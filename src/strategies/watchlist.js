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
import { buildLevels } from '../structure.js';
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
    leaveATR = 1.5,        // price must go AWAY this far before a return counts
    minHoldDays = 2,       // days of touching-without-closing-beyond before armed
    retestATR = 0.5,       // how close price must come back to count as a retest
    extendATR = 1.0,       // the move must TRAVEL this far before a pullback
                           // counts as a retest. Without it the very next bar
                           // qualifies — on NZDJPY the bar after the 6/30
                           // resolution had a low within half an ATR of the
                           // resolution close, so a still-rising move was read
                           // as a pullback and the real 7/2 retest was never
                           // reached.
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
  // Histogram levels, not strict swings — buildZones could not see the very
  // clusters the user draws by hand.
  const zones = buildLevels(D, { binATR: 0.35, minBars: 3 });
  if (!zones.length) return [];

  const signals = [];

  for (const z of zones) {
    const isSup = z.kind === 'support';
    // Walk the level's whole life and record EVERY resolution, not just the
    // first. A level is revisited repeatedly over months — breaking after one
    // event meant the NZDJPY June setup was invisible because an earlier
    // resolution on the same level had already consumed it.
    //
    // The zone is NOT a narrow band. Per the user: price must LEAVE, then come
    // back within 1 daily ATR; the reversal may happen anywhere inside that
    // ATR, or below the level entirely. Requiring re-entry into a narrow band
    // is what hid the June setup, whose lows sat 33p above a level with a 71p
    // ATR.
    const events = [];
    let left = false, holdDays = 0;
    for (let k = z.confirmedAt + 1; k < D.length; k++) {
      const d = D[k];
      if (aD[k] == null) continue;
      const dist = Math.abs(d.close - z.price);

      if (!left) { if (dist > aD[k] * leaveATR) left = true; continue; }
      if (dist > aD[k] * watchATR) {
        // Left the watch band. If it had been holding, that is the REVERSAL.
        if (holdDays >= minHoldDays) {
          const away = isSup ? d.close > z.price : d.close < z.price;
          if (away) events.push({ at: d.time, dir: isSup ? 'long' : 'short', holdDays });
        }
        holdDays = 0; left = true;
        continue;
      }
      // Inside the watch band.
      const beyond = isSup ? d.close < z.low : d.close > z.high;
      if (beyond) {
        // Closed through it — the BREAKOUT.
        if (holdDays >= minHoldDays) events.push({ at: d.time, dir: isSup ? 'short' : 'long', holdDays });
        holdDays = 0; left = false;
        continue;
      }
      holdDays++;   // CODE RED persists
    }
    if (!events.length) continue;

    for (const evt of events) {
      const armedAt = evt.at, dir = evt.dir, holdCount = evt.holdDays;
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
    const base = entry[resolvedAt].close;
    let ext = base, extended = false;
    let entered = false;
    for (let i = resolvedAt + 1; i < Math.min(entry.length - 1, resolvedAt + retestMaxBars); i++) {
      ext = L ? Math.max(ext, entry[i].high) : Math.min(ext, entry[i].low);
      if (!extended) {
        if (Math.abs(ext - base) >= aH[i] * extendATR) extended = true;
        continue;                       // no pullback counts until it has run
      }
      const back = L ? entry[i].low : entry[i].high;
      const nearSma = s50[i] != null && Math.abs(back - s50[i]) <= aH[i] * retestATR;
      const nearBreak = Math.abs(back - base) <= aH[i] * retestATR;
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
        meta: { level: z.price, holdDays: holdCount, armedAt, resolvedAt: entry[resolvedAt].time },
      });
      entered = true;
      break;
    }
    void entered;
    }
  }
  return signals.sort((a, b) => a.index - b.index);
}
