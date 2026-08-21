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
    rangeBars = 24,        // bars of consolidation defining the broken range
    stopBufferATR = 0.3,   // beyond the ORIGINAL level
    minRR = 1.0,
    maxRR = 6,
    maxSpreadFrac = 0.25,
    momOpts = {},
    // 'retest'          wait for breakout then re-entry to the broken range
    // 'level_rejection' enter on the close of the candle that rejects the
    //                   level itself. Simpler, and it is what the user does by
    //                   hand: by the time the level has rejected, the question
    //                   is only where to get in, not whether.
    entryMode = 'retest',
    rejectTF = 'D',        // which timeframe's candle must do the rejecting
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
    // ── Level rejection: enter on the close of the candle that rejects ─────
    if (entryMode === 'level_rejection') {
      const src = rejectTF === 'D' ? D : entry;
      const aSrc = rejectTF === 'D' ? aD : aH;
      // Find the rejection inside the code-red window that produced this event.
      const armedIdx = src.findIndex(b => b.time >= armedAt);
      const from = Math.max(0, armedIdx - 10);
      for (let k = from; k < armedIdx && k < src.length; k++) {
        const c = src[k];
        if (aSrc[k] == null) continue;
        // Traded into the level, closed back away from it.
        const into = isSup ? c.low <= z.high : c.high >= z.low;
        const away = isSup ? c.close > z.high : c.close < z.low;
        if (!(into && away)) continue;

        const px = c.close;                       // enter on the rejection close
        const buf = aSrc[k] * stopBufferATR;
        const stop = isSup ? z.low - buf : z.high + buf;
        const risk = Math.abs(px - stop);
        if (!risk) continue;
        if (isSup ? px <= stop : px >= stop) continue;
        if (ctx.spread && ctx.spread / risk > maxSpreadFrac) continue;

        // Take the first level FAR ENOUGH to be worth trading, not simply the
        // nearest. Histogram levels sit every ~30 pips, so the nearest is often
        // a few pips away — on the NZDJPY June setup it was 3 pips, giving
        // rr 0.08 and killing every signal. The user's TP1 is a specific prior
        // structure, not whatever happens to be closest.
        const ahead = zones
          .filter(w => isSup ? w.price > px : w.price < px)
          .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))
          .find(w => Math.abs(w.price - px) / risk >= minRR);
        if (!ahead) continue;
        let target = ahead.price;
        let rr = Math.abs(target - px) / risk;
        if (rr > maxRR) { target = isSup ? px + maxRR * risk : px - maxRR * risk; rr = maxRR; }

        // Map the rejection bar back onto the entry timeframe for simulation.
        const idx = alignedIdx(entry, c.time);
        if (idx < 0 || idx >= entry.length - 1) continue;
        signals.push({
          index: idx + 1, time: entry[idx + 1].time, dir: isSup ? 'long' : 'short',
          entry: px, stop, target, risk, rr,
          meta: { level: z.price, holdDays: holdCount, armedAt, mode: 'level_rejection',
                  rejectBar: c.time },
        });
        break;
      }
      continue;
    }

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
    // THE RANGE that was broken — measured over the consolidation BEFORE the
    // resolution bar, never including the breakout itself. Measuring through
    // the breakout put the range top at 92.764 instead of ~91.6, so the retest
    // could never be recognised.
    let rHi = -Infinity, rLo = Infinity;
    for (let k = Math.max(0, resolvedAt - rangeBars); k < resolvedAt; k++) {
      rHi = Math.max(rHi, entry[k].high); rLo = Math.min(rLo, entry[k].low);
    }
    const edge = L ? rHi : rLo;          // the side price broke through

    const base = entry[resolvedAt].close;
    let ext = base, extended = false;
    let entered = false;
    for (let i = resolvedAt + 1; i < Math.min(entry.length - 1, resolvedAt + retestMaxBars); i++) {
      ext = L ? Math.max(ext, entry[i].high) : Math.min(ext, entry[i].low);
      if (!extended) {
        if (Math.abs(ext - base) >= aH[i] * extendATR) extended = true;
        continue;                       // no pullback counts until it has run
      }
      // RETEST AND REJECTION. Price must trade back to the broken edge (or the
      // 50 SMA) and CLOSE back on the breakout side — the user's "retesting and
      // rejecting the range". Either confirmation alone is enough; both
      // together is the stronger entry, so count them and report it.
      const back = L ? entry[i].low : entry[i].high;
      const hitEdge = L ? back <= edge + aH[i] * retestATR : back >= edge - aH[i] * retestATR;
      const hitSma = s50[i] != null &&
        (L ? back <= s50[i] + aH[i] * retestATR : back >= s50[i] - aH[i] * retestATR);
      const rejected = L ? entry[i].close > Math.max(edge, s50[i] ?? -Infinity)
                         : entry[i].close < Math.min(edge, s50[i] ?? Infinity);
      if (!((hitEdge || hitSma) && rejected)) continue;
      const confirmations = (hitEdge ? 1 : 0) + (hitSma ? 1 : 0);

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
        meta: { level: z.price, holdDays: holdCount, armedAt,
                resolvedAt: entry[resolvedAt].time, rangeEdge: edge, confirmations },
      });
      entered = true;
      break;
    }
    void entered;
    }
  }
  // Levels sit every ~30 pips, so one rejection bar can satisfy several of them
  // and produce duplicates — and worse, a long and a short on the SAME bar from
  // levels either side. A bar that argues both ways is a bar with no view, so
  // drop it entirely rather than trade a coin flip. Otherwise keep the best
  // reward-to-risk per bar per direction.
  const byBar = new Map();
  for (const sig of signals) {
    const k = sig.index;
    if (!byBar.has(k)) byBar.set(k, []);
    byBar.get(k).push(sig);
  }
  const out = [];
  for (const group of byBar.values()) {
    const dirs = new Set(group.map(g => g.dir));
    if (dirs.size > 1) continue;                       // contradictory — skip
    out.push(group.sort((a, b) => b.rr - a.rr)[0]);    // best geometry
  }
  return out.sort((a, b) => a.index - b.index);
}
