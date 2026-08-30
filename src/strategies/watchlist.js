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
import { atr, sma, rsi, macd, stochastic, rvi, bollinger, swings } from '../indicators.js';
import { buildLevels, buildSwingTouchLevels, levelRespectEvents } from '../structure.js';
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
    // 'level'  first level >= minRR      'level2' second level out
    // 'atr'    fixed multiple            'sma50_entry' / 'sma50_daily'
    targetMode = 'level',
    targetATR = 2,
    rMult = 1.2,           // for targetMode 'fixedR'
    rejectTF = 'D',        // which timeframe's candle must do the rejecting
    // WHERE ENTRY LEVELS COME FROM. 'bin' is buildLevels — any bar extreme
    // landing in the band counts as a touch. 'swingtouch' is the user's count:
    // a swing high/low, price leaves, makes the OPPOSING swing, and only the
    // return is a touch. Targets are unaffected either way — they always come
    // from bin levels, which is the combination that passed holdout.
    levelSource = 'bin',
    levelBin = 0.35,       // band width in ATR; the user's areas are wider than
                           // 0.35, so this has to be swept, not assumed
    minTouches = 1,        // qualifying round trips before the level is live
    awayATR = 1.0,         // how far past the band the opposing swing must sit
    // Only the FIRST rejection at each level. Later pokes wear the band down.
    firstRejectionOnly = false,
    // Grade the TARGET by its respect rate. Measured U-shaped: a level that
    // always holds is where price stops, one that never holds is easy to reach,
    // and the ambiguous middle is the bad one. null disables the filter.
    targetRespect = null,  // 'ushape' | null
    fill = 'market',       // 'market' = next bar's open | 'limit' = at the rejection close
    limitBars = 12,        // entry bars a limit order stays live before it is abandoned
  } = opts;

  const D = levelBars.D || [];
  if (D.length < 60 || entry.length < 200) return [];
  const aD = atr(D, 14);
  const aH = atr(entry, 14);
  const closes = entry.map(b => b.close);
  const s50 = sma(closes, 50);
  const sma50Entry = s50;
  const s200 = sma(closes, 200);
  // Indicators recorded at entry — NOT used to filter here. They are attached
  // so a later pass can measure which of them actually separate winners from
  // losers, rather than being assumed to help.
  const iRsi = rsi(closes, 14);
  const iMacd = macd(closes);
  const iStoch = stochastic(entry);
  const iRvi = rvi(entry);
  const iBb = bollinger(closes);
  const dCloses = D.map(b => b.close);
  const dS50 = sma(dCloses, 50);
  const dRsi = rsi(dCloses, 14);
  // Histogram levels, not strict swings — buildZones could not see the very
  // clusters the user draws by hand.
  const targetZones = buildLevels(D, { binATR: 0.35, minBars: 3 });
  const zones = levelSource === 'swingtouch'
    ? buildSwingTouchLevels(D, { binATR: levelBin, minTouches, awayATR })
    : targetZones;
  if (!zones.length || !targetZones.length) return [];

  const signals = [];
  // Respect history is expensive and reused across every signal on a level, so
  // classify each target zone once and slice by bar index at use.
  const respectCache = new Map();
  // Daily swing points, for targetMode 'swing'. Level bands cover ~73% of the
  // traded range, so "first level >= minRR away" barely constrains anything —
  // a swing low is a specific place price actually turned, and is the user's
  // reading of where support really sits.
  const dSw = swings(D, 5);
  const respectAt = (w, k) => {
    if (!respectCache.has(w)) respectCache.set(w, levelRespectEvents(D, w));
    const prior = respectCache.get(w).filter(e => e.end < k);
    const resp = prior.filter(e => e.kind === 'respected').length;
    const pass = prior.filter(e => e.kind === 'passed').length;
    return resp + pass >= 2 ? resp / (resp + pass) : null;
  };

  for (const z of zones) {
    let tookOne = false;
    // ROLE REVERSAL. A level's role is not a label stamped at build time — it is
    // where price is standing relative to it. Above the band it is support;
    // below, resistance. It FLIPS when price closes through, which is what
    // "broken support becomes resistance" means, and it is the basis of every
    // break-and-retest setup.
    //
    // Reading z.kind instead left 48% of levels permanently on the wrong side of
    // price and therefore untradeable in the direction price was approaching
    // from — measured 603 of 1,249 daily levels across 12 pairs.
    //
    // While price sits INSIDE the band (code red) `side` holds its last value,
    // which is the side price approached from — exactly the side the trade
    // would be taken from.
    let side = null;                       // +1 price above the band, -1 below
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

      // Establish the role before anything reads it. A level whose first bars
      // sit inside the band has no role yet and cannot be traded.
      if (side === null) {
        if (d.close > z.high) side = 1;
        else if (d.close < z.low) side = -1;
        else continue;
      }
      const isSup = side > 0;
      const dist = Math.abs(d.close - z.price);

      if (!left) { if (dist > aD[k] * leaveATR) left = true; continue; }
      if (dist > aD[k] * watchATR) {
        // Left the watch band. If it had been holding, that is the REVERSAL.
        if (holdDays >= minHoldDays) {
          const away = isSup ? d.close > z.price : d.close < z.price;
          if (away) events.push({ at: d.time, dir: isSup ? 'long' : 'short', holdDays, type: 'reversal' });
        }
        holdDays = 0; left = true;
        continue;
      }
      // Inside the watch band.
      const beyond = isSup ? d.close < z.low : d.close > z.high;
      if (beyond) {
        // Closed through it — the BREAKOUT. The level now does the opposite job.
        if (holdDays >= minHoldDays) events.push({ at: d.time, dir: isSup ? 'short' : 'long', holdDays, type: 'breakout' });
        side = -side;                      // <- the flip
        holdDays = 0; left = false;
        continue;
      }
      holdDays++;   // CODE RED persists
    }
    // ── Level rejection ───────────────────────────────────────────────────
    //
    // REWRITTEN 2026-08-27. The previous version took an EVENT (a reversal or
    // breakout recorded during the level walk) and then searched the 10 bars
    // BEFORE it for a rejection candle. That made the entry bar a function of
    // something that had not happened yet: measured on EURUSD, 90% of signals
    // filled before the event that made them visible, and with role reversal
    // feeding it breakout events too it produced a 77.8% win rate and 28/28
    // pairs positive — the signature of hindsight, not an edge.
    //
    // The rejection candle IS the signal. Nothing needs to point at it. Scan
    // forward, fire when it happens, and never look back from a later bar.
    //
    // FILL MODEL. `fill` decides how the order is actually placed:
    //   'market' — next entry-TF bar's OPEN. Always fills, at whatever is there.
    //   'limit'  — a limit at the rejection close (sell at resistance, buy at
    //              support). Better price, but only fills if price comes back to
    //              it within limitBars; otherwise the trade never happens.
    // The old code did neither — it booked the rejection close as the fill and
    // started the walk on the next bar, which is a price you could not have got.
    if (entryMode === 'level_rejection') {
      const src = rejectTF === 'D' ? D : entry;
      const aSrc = rejectTF === 'D' ? aD : aH;

      for (let k = z.confirmedAt + 1; k < src.length - 1; k++) {
        const c = src[k];
        if (aSrc[k] == null) continue;

        // Role at THIS bar, from where price is standing — same rule as the walk.
        const sideK = c.close > z.high ? 1 : c.close < z.low ? -1 : 0;
        if (sideK === 0) continue;
        const isSup = sideK > 0;

        // Traded into the level and closed back away from it.
        const into = isSup ? c.low <= z.high : c.high >= z.low;
        const away = isSup ? c.close > z.high : c.close < z.low;
        if (!(into && away)) continue;

        // Must be within reach of the level to be this setup at all.
        if (Math.abs(c.close - z.price) > aSrc[k] * watchATR) continue;

        // The bar's close time is the next bar's timestamp — see the OANDA
        // bar-stamping note. Anything earlier is lookahead.
        const closeT = src[k + 1]?.time;
        if (closeT == null) continue;
        const i0 = alignedIdx(entry, closeT);
        if (i0 < 0 || i0 >= entry.length - 2) continue;

        let px = null, fillIdx = null;
        if (fill === 'limit') {
          const want = c.close;
          for (let j = i0; j < Math.min(entry.length, i0 + limitBars); j++) {
            const b = entry[j];
            if (isSup ? b.low <= want : b.high >= want) { px = want; fillIdx = j; break; }
          }
          if (px == null) continue;                 // never came back — no trade
        } else {
          px = entry[i0].open;                      // the price actually available
          fillIdx = i0;
        }

        const buf = aSrc[k] * stopBufferATR;
        const stop = isSup ? z.low - buf : z.high + buf;
        const risk = Math.abs(px - stop);
        if (!risk) continue;
        if (isSup ? px <= stop : px >= stop) continue;
        if (ctx.spread && ctx.spread / risk > maxSpreadFrac) continue;

        const forward = targetZones
          .filter(w => isSup ? w.price > px : w.price < px)
          .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px));
        let target = null;
        if (targetMode === 'atr') {
          target = isSup ? px + aSrc[k] * targetATR : px - aSrc[k] * targetATR;
        } else if (targetMode === 'fixedR') {
          target = isSup ? px + risk * rMult : px - risk * rMult;
        } else if (targetMode === 'level2') {
          const ok = forward.filter(w => Math.abs(w.price - px) / risk >= minRR);
          target = ok[1]?.price ?? ok[0]?.price ?? null;
        } else {
          target = forward.find(w => Math.abs(w.price - px) / risk >= minRR)?.price ?? null;
        }
        if (target == null) continue;
        let rr = Math.abs(target - px) / risk;
        if (rr < minRR) continue;
        if (rr > maxRR) { target = isSup ? px + maxRR * risk : px - maxRR * risk; rr = maxRR; }
        if (firstRejectionOnly && tookOne) continue;

        signals.push({
          index: fillIdx, time: entry[fillIdx].time, dir: isSup ? 'long' : 'short',
          entry: px, stop, target, risk, rr,
          meta: {
            level: z.price, mode: 'level_rejection', fill,
            rejectBar: c.time, touches: z.touches, riskPips: risk, rr,
            dRsi: dRsi[rejectTF === 'D' ? k : alignedIdx(D, c.time)],
            dTrend: dS50[k] != null ? (c.close > dS50[k] ? 1 : 0) : null,
            atrPips: aSrc[k],
            // conditions at the FILL bar — the inputs any future entry filter
            // gets to use, all knowable at fill time
            rsi: iRsi[fillIdx], stoch: iStoch.k[fillIdx], macdHist: iMacd.hist[fillIdx],
            bbPct: iBb.pctB[fillIdx],
            vsSma50: s50[fillIdx] != null ? (px - s50[fillIdx]) / aH[fillIdx] : null,
            vsSma200: s200[fillIdx] != null ? (px - s200[fillIdx]) / aH[fillIdx] : null,
            hour: new Date(entry[fillIdx].time).getUTCHours(),
          },
        });
        tookOne = true;
      }
      continue;                       // this mode is done with the level
    }

    if (!events.length) continue;

    for (const evt of events) {
      const armedAt = evt.at, dir = evt.dir, holdCount = evt.holdDays;
      const isSup = dir === 'long';

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
