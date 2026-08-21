/**
 * Strategy 2 — Macro reversal at a multi-touch level.
 *
 * The user's own setup, specified in their words:
 *   "wide range for both swing highs and lows and zones with multiple touches
 *    because prices of course aren't exact ... 4hr, daily, and weekly ...
 *    for entries RSI, and on lower tf choch/bos ... sl below or above last
 *    swing high/low depending on trade direction"
 *
 * So: a level that has been respected more than once on a higher timeframe,
 * price stretched into it, and the lower timeframe changing character before
 * committing. The level is MANDATORY here — the existing checkMacroReversal()
 * fires on an RSI extreme OR a cross without one, which is a different and
 * looser thing.
 *
 * Levels are built on H4/D/W; entries are taken on H1. Cross-timeframe
 * alignment is by timestamp, never by bar index — indices do not translate,
 * and getting it wrong is a silent lookahead bug.
 */
import { rsi, atr, swings, lastConfirmedSwing } from '../indicators.js';
import { buildZones, structureEvents } from '../structure.js';

export const meta = {
  name: 'macro_reversal_level',
  entryTF: 'H1',              // overridable; the runner sweeps M15/M30/H1
  levelTFs: ['H4', 'D', 'W'],
  warmup: 200,
};

/** Index of the last element of `series` whose time is <= t. -1 if none. */
function alignedIdx(series, t) {
  let lo = 0, hi = series.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].time <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * @param entry  H1 bars — where trades are taken
 * @param levels {H4:[],D:[],W:[]} — where zones come from
 */
export function generate(entry, levelBars, opts = {}, ctx = {}) {
  const {
    tolATR = 0.5,
    minTouches = 2,
    zoneDistATR = 0.75,     // how close price must be to count as "at" the zone
    rsiPeriod = 14,
    rsiLongMax = 40,        // oversold into support
    rsiShortMin = 60,       // overbought into resistance
    chochWithin = 12,       // H1 bars between CHoCH confirming and entry
    swingLookback = 5,
    stopBufferATR = 0.3,
    minRR = 1.2,            // reject geometry that does not pay for the risk
    maxRR = Infinity,       // cap the target; the nearest opposing zone can be
                            // absurdly far, and an uncapped rr of 6.7 means a
                            // ~13% win rate is the best a coin flip could do
    minStopATR = 0.4,
    maxStopATR = 4.0,
    maxSpreadFrac = 0.25,   // reject if spread eats more than this share of the
                            // stop. NZDCAD showed avgL -2.53R, i.e. a spread
                            // 1.5x the risk: not a losing trade, an impossible
                            // one. No real trader would take it.
    stopTF = 'entry',       // 'entry' | 'H4'. Which timeframe's swing the stop
                            // hangs off. Dropping the ENTRY timeframe is cheap;
                            // dropping the STOP with it is not — spread does not
                            // shrink, so cost per trade goes from ~7% of R at H4
                            // to ~35% at M15. Entering low while stopping off
                            // higher structure is how to get precision without
                            // paying for it.
  } = opts;

  // Zones from every level timeframe, pooled — they are just prices.
  const zones = [];
  for (const tf of meta.levelTFs) {
    const bars = levelBars[tf];
    if (!bars || bars.length < 30) continue;
    for (const z of buildZones(bars, { lookback: swingLookback, tolATR, minTouches })) {
      zones.push({ ...z, tf });
    }
  }
  if (!zones.length) return [];

  const closes = entry.map(b => b.close);
  const rH1 = rsi(closes, rsiPeriod);
  const aH1 = atr(entry, 14);
  const swH1 = swings(entry, swingLookback);
  const events = structureEvents(entry, { lookback: swingLookback });

  // RSI on the primary level timeframe, aligned by time.
  const h4 = levelBars.H4 || [];
  const rH4 = rsi(h4.map(b => b.close), rsiPeriod);
  const swHi = swings(h4, swingLookback);

  const signals = [];
  let evCursor = 0;
  // One trade per CHoCH. Without this the conditions stay true for as long as
  // price loiters near the level, so a single setup fires on every consecutive
  // H1 bar — EURUSD produced 28 "signals" from about five real setups. Worse,
  // it is a selection bias with a direction: setups that work leave the zone
  // immediately and are counted once, while setups that stall get counted six
  // times. That alone makes a neutral edge measure 3+ sd WORSE than random.
  const takenCHoCH = new Set();

  for (let i = meta.warmup; i < entry.length - 1; i++) {
    const bar = entry[i];
    if (aH1[i] == null || rH1[i] == null) continue;

    // Advance a cursor over confirmed events rather than rescanning the list.
    while (evCursor < events.length && events[evCursor].confirmedAt <= i) evCursor++;
    let ev = null;
    for (let n = evCursor - 1; n >= 0 && i - events[n].confirmedAt <= chochWithin; n--) {
      if (events[n].type === 'CHoCH') { ev = events[n]; break; }
    }
    if (!ev) continue;
    const evKey = `${ev.at}:${ev.dir}`;
    if (takenCHoCH.has(evKey)) continue;

    const isLong = ev.dir === 'bull';

    // Test the zone against the SWING that formed the reversal, not against
    // price now. Requiring price to still sit at the level after a CHoCH has
    // already fired selects for bounces that failed and came back — which is
    // why the first version came out 3.4-4.6 sd WORSE than random rather than
    // merely edgeless. The setup is: price reached the level, turned there,
    // then changed character. By entry time it is supposed to have left.
    const pivotIdx = lastConfirmedSwing(isLong ? swH1.lows : swH1.highs, i, swingLookback);
    if (pivotIdx == null) continue;
    const pivotPx = isLong ? entry[pivotIdx].low : entry[pivotIdx].high;
    // The turn must be recent enough to belong to this CHoCH.
    if (i - pivotIdx > chochWithin * 2) continue;

    const near = zones.filter(z =>
      z.confirmedTime <= entry[pivotIdx].time &&
      z.kind === (isLong ? 'support' : 'resistance') &&
      Math.abs(z.price - pivotPx) <= aH1[i] * zoneDistATR);
    if (!near.length) continue;
    const zone = near.sort((x, y) => y.touches - x.touches)[0];

    // Stretched into the level on the higher timeframe, measured AT the turn.
    const k4 = alignedIdx(h4, entry[pivotIdx].time);
    const r4 = k4 >= 0 ? rH4[k4] : null;
    if (r4 == null) continue;
    if (isLong ? r4 > rsiLongMax : r4 < rsiShortMin) continue;

    // Stop beyond the swing that formed at the level, per the user's rule.
    let swingPx = pivotPx;
    if (stopTF !== 'entry') {
      const sIdx = lastConfirmedSwing(isLong ? swHi.lows : swHi.highs, k4, swingLookback);
      if (sIdx == null) continue;
      swingPx = isLong ? h4[sIdx].low : h4[sIdx].high;
    }
    const buf = aH1[i] * stopBufferATR;
    const stop = isLong ? swingPx - buf : swingPx + buf;

    const px = entry[i + 1].open;
    const risk = Math.abs(px - stop);
    if (!risk) continue;
    if (isLong ? px <= stop : px >= stop) continue;
    if (risk < aH1[i] * minStopATR || risk > aH1[i] * maxStopATR) continue;
    if (ctx.spread && ctx.spread / risk > maxSpreadFrac) continue;

    // Target: the nearest opposing zone in front of the trade. Structure, not
    // a fixed multiple — price reacts at levels, not at ratios.
    const opp = zones
      .filter(z => z.confirmedTime <= bar.time && z.kind === (isLong ? 'resistance' : 'support'))
      .filter(z => isLong ? z.price > px : z.price < px)
      .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))[0];
    if (!opp) continue;
    let target = opp.price;
    let rr = Math.abs(target - px) / risk;
    if (rr < minRR) continue;
    if (rr > maxRR) { target = isLong ? px + maxRR * risk : px - maxRR * risk; rr = maxRR; }

    signals.push({
      index: i + 1, time: entry[i + 1].time,
      dir: isLong ? 'long' : 'short',
      entry: px, stop, target, risk, rr,
      meta: { zone: zone.price, touches: zone.touches, zoneTF: zone.tf, rsiH4: r4, choch: ev.at },
    });
    takenCHoCH.add(evKey);
  }
  return signals;
}
