/**
 * Strategy 5 — the user's actual process, as a state machine.
 *
 * Every earlier strategy fired on a SINGLE BAR, which is why they kept entering
 * at the wrong moment. This is a sequence with escalating confirmation, and
 * crucially the entry is the RETEST, not the resolution:
 *
 *   WATCHING   daily close within 1 x daily ATR of a multi-touch level
 *   CODE RED   price touches the level but never CLOSES beyond it. Persists as
 *              long as that holds — the user watches for either outcome,
 *              because "either is bound to happen".
 *   RESOLVED   it finally gives way, in one of two directions:
 *                REVERSAL  moves away from the level with momentum
 *                BREAKOUT  closes beyond the level with momentum
 *   RETEST     price comes back to the broken structure. "It retests more times
 *              than not." THIS is the entry — not the resolution bar.
 *   ENTRY      stop goes below the ORIGINAL level, deliberately wide, which is
 *              affordable because this is the small starter.
 *
 * Both resolutions are tradeable, which unifies the break and reverse cases
 * that were being tested as separate strategies.
 *
 * Levels and state on Daily; resolution, retest and entry on H4.
 */
import { atr, sma } from '../indicators.js';
import { buildZones } from '../structure.js';
import { momentum } from '../candles.js';

export const meta = {
  name: 'watchlist',
  entryTF: 'H4',
  levelTFs: ['D'],
  warmup: 60,
};

const alignedIdx = (series, t) => {
  let lo = 0, hi = series.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].time <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best;
};

export function generate(entry, levelBars, opts = {}, ctx = {}) {
  const {
    watchATR = 1.0,        // "within 1 daily ATR" — step 3
    minHoldDays = 2,       // days of touching-without-closing-beyond before armed
    retestATR = 0.5,       // how close price must come back to count as a retest
    retestMaxBars = 30,    // H4 bars allowed for the retest to happen
    stopBufferATR = 0.3,   // beyond the ORIGINAL level
    minRR = 1.0,
    maxRR = 6,
    maxSpreadFrac = 0.25,
    momOpts = {},
  } = opts;

  const D = levelBars.D || [];
  if (D.length < 60 || entry.length < 200) return [];
  const aD = atr(D, 14);
  const aH = atr(entry, 14);
  const s50 = sma(entry.map(b => b.close), 50);
  const zones = buildZones(D, { lookback: 5, tolATR: 0.5, minTouches: 2 });
  if (!zones.length) return [];

  const signals = [];

  for (const z of zones) {
    // ── Daily state machine over this level ────────────────────────────────
    let holdDays = 0, armedAt = null, dir = null;
    for (let k = z.confirmedAt + 1; k < D.length; k++) {
      const d = D[k];
      if (aD[k] == null) continue;
      const near = Math.abs(d.close - z.price) <= aD[k] * watchATR;
      const touched = d.low <= z.high && d.high >= z.low;
      const closedBelow = d.close < z.low, closedAbove = d.close > z.high;

      if (touched && !closedBelow && !closedAbove) { holdDays++; continue; }   // CODE RED persists
      if (!near && !touched) { holdDays = 0; continue; }                        // drifted away, reset

      // RESOLVED — it finally closed beyond, or pulled decisively away.
      if (holdDays >= minHoldDays) {
        if (closedBelow) { dir = 'short'; armedAt = d.time; }        // broke down
        else if (closedAbove) { dir = 'long'; armedAt = d.time; }    // broke up
        else if (near) {
          // Pulled away without closing beyond = the reversal case. Direction
          // is away from the level.
          const away = d.close > z.price ? 'long' : 'short';
          if (Math.abs(d.close - z.price) > aD[k] * 0.8) { dir = away; armedAt = d.time; }
        }
      }
      if (armedAt) break;
      holdDays = 0;
    }
    if (!armedAt || !dir) continue;

    // ── H4: require momentum on the resolution, then wait for the retest ───
    const i0 = alignedIdx(entry, armedAt);
    if (i0 < 60 || i0 >= entry.length - 2) continue;
    const L = dir === 'long';

    let resolvedAt = null;
    for (let i = i0; i < Math.min(entry.length - 2, i0 + 12); i++) {
      if (aH[i] == null || s50[i] == null) continue;
      const m = momentum(entry, i, aH[i], L ? 'bull' : 'bear', momOpts);
      // Force must also carry price through the 50 SMA — the user's step 6.
      const throughSma = L ? entry[i].close > s50[i] : entry[i].close < s50[i];
      if (m.any && throughSma) { resolvedAt = i; break; }
    }
    if (resolvedAt == null) continue;

    // Extreme reached before the pullback — the "range high" that was broken.
    let ext = entry[resolvedAt].close;
    let entered = false;
    for (let i = resolvedAt + 1; i < Math.min(entry.length - 1, resolvedAt + retestMaxBars); i++) {
      ext = L ? Math.max(ext, entry[i].high) : Math.min(ext, entry[i].low);
      const back = L ? entry[i].low : entry[i].high;
      const nearSma = s50[i] != null && Math.abs(back - s50[i]) <= aH[i] * retestATR;
      const nearBreak = Math.abs(back - entry[resolvedAt].close) <= aH[i] * retestATR;
      if (!(nearSma || nearBreak)) continue;

      // ENTRY on the retest. Stop below the ORIGINAL level, per the user.
      const px = entry[i + 1].open;
      const buf = aH[i] * stopBufferATR;
      const stop = L ? z.low - buf : z.high + buf;
      const risk = Math.abs(px - stop);
      if (!risk) break;
      if (L ? px <= stop : px >= stop) break;
      if (ctx.spread && ctx.spread / risk > maxSpreadFrac) break;

      // Target: the next daily structure beyond the move.
      const ahead = zones
        .filter(w => Math.abs(w.price - z.price) > aD[aD.length - 1] * 0.5)
        .filter(w => L ? w.price > px : w.price < px)
        .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))[0];
      if (!ahead) break;
      let target = ahead.price;
      let rr = Math.abs(target - px) / risk;
      if (rr < minRR) break;
      if (rr > maxRR) { target = L ? px + maxRR * risk : px - maxRR * risk; rr = maxRR; }

      signals.push({
        index: i + 1, time: entry[i + 1].time, dir,
        entry: px, stop, target, risk, rr,
        meta: { level: z.price, holdDays, armedAt, resolvedAt: entry[resolvedAt].time },
      });
      entered = true;
      break;
    }
    void entered;
  }
  return signals.sort((a, b) => a.index - b.index);
}
