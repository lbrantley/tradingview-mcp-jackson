/**
 * Strategy 4 — trade what the APPROACH says, not what the level says.
 *
 * From classify_level_events (n=17,731, replicated on a second window and on
 * Weekly). At a level, price breaks 45% / reverses 50% / stalls 5% — a coin
 * flip, until you condition on how it arrived:
 *
 *   closed through + fast approach + 1st/2nd test  -> break   67.3% / 67.6%
 *   closed back out + slow approach + 4th+ test    -> reverse 68.9% / 69.6%
 *
 * Both sides tradeable, ~2.5:1 in the predicted direction. The level is not the
 * signal; it is where the signal is read. Fading is not wrong — it was
 * unconditional, which averaged two opposite populations into nothing.
 *
 * Direction is always relative to how price ARRIVED, never to whether the zone
 * is labelled support or resistance.
 */
import { atr, sma } from '../indicators.js';
import { detect } from '../candles.js';
import { buildZones } from '../structure.js';

export const meta = {
  name: 'approach',
  entryTF: 'D',
  levelTFs: ['H4', 'D', 'W'],
  warmup: 220,
};

export function generate(entry, levelBars, opts = {}, ctx = {}) {
  const {
    // 'reverse_pattern' replaces the close-back-out test with a candlestick
    // rejection. Measured: a bullish pattern on a fall into a level reverses
    // 65.8% / 63.3% of the time vs a 49.9% base, on two windows. It also fires
    // on the NZDJPY 2026-06-26 turn (439 pips), which the close-back-out
    // version missed — a hammer printed inside the zone on 06-25, a day before
    // the low, and a bull engulf on 06-29.
    mode = 'break',        // 'break' | 'reverse' | 'reverse_pattern'
    levelTF = 'self',      // 'self' uses the entry timeframe's own zones
    tolATR = 0.5,
    minTouches = 2,
    fastATR = 1.5,         // 5-bar travel that counts as arriving fast
    slowATR = 0.5,
    maxTestBreak = 2,      // fresh level
    minTestReverse = 4,    // well-tested level
    stopBufferATR = 0.5,
    minRR = 1.0,
    maxRR = 4,
    maxSpreadFrac = 0.25,
    cooldownBars = 5,
    // The classification measured a 1 ATR move in the predicted direction.
    // Structural stops and level targets are a different bet, so allow a
    // geometry that matches what was actually measured — otherwise a failure
    // could be the geometry rather than the finding.
    geom = 'structure',    // 'structure' | 'atr'
    stopATR = 1.0,
    targetATR = 1.0,
    // The reverse signal requires the touch bar to have closed BACK OUT of the
    // zone, which means the turn is already underway before you can be filled —
    // the same entry lag that killed the CHoCH version. These let the reverse
    // side be tested without that handicap: enter at the level itself, as the
    // user does by hand with a small starter, rather than after confirmation.
    requireClosedOut = true,
    entryMode = 'next_open',   // 'next_open' | 'zone_limit'
    // ROOM TO RUN — the gate on whether a BIG move is even possible. Price
    // cannot travel 3 ATR if another level sits 1 ATR beyond it. Measured on
    // 3 ATR persistent moves: 8+ ATR of room lifts big breaks from 28% to 37%,
    // under 2 ATR lifts big reversals instead. Both replicated on a second
    // window.
    minRoom = 0,          // break wants space ahead
    maxRoom = 1e9,        // reverse wants none
  } = opts;

  const src = levelTF === 'self' ? entry : (levelBars[levelTF] || entry);
  const zones = buildZones(src, { lookback: 5, tolATR, minTouches });
  if (!zones.length) return [];

  const closes = entry.map(b => b.close);
  const a = atr(entry, 14);
  const signals = [];
  const testCount = new Map();     // zone key -> tests seen so far
  const lastTouch = new Map();

  for (let i = meta.warmup; i < entry.length - 1; i++) {
    const b = entry[i];
    if (a[i] == null) continue;

    for (const z of zones) {
      if (z.confirmedTime > b.time) continue;
      if (!(b.low <= z.high && b.high >= z.low)) continue;
      const key = `${z.kind}:${z.price.toFixed(6)}`;
      if (i - (lastTouch.get(key) ?? -1e9) < cooldownBars) continue;
      lastTouch.set(key, i);
      const testNo = (testCount.get(key) ?? 0) + 1;
      testCount.set(key, testNo);

      // A resting limit is placed BEFORE this bar opens, so it may only use
      // information closed at i-1. Reading closes[i] to decide, then filling
      // inside bar i, is lookahead — it produced a spurious +12.6 sd before
      // this guard existed. next_open entries are decided at i's close and
      // filled at i+1, so they may legitimately see bar i.
      const lim = entryMode === 'zone_limit';
      const dec = lim ? i - 1 : i;             // last bar the decision may see
      if (dec < 6) continue;
      const ref = closes[Math.max(0, dec - 5)];
      const fromAbove = ref > z.price;
      const speed = Math.abs(closes[dec] - ref) / a[dec];
      const closedOut = lim
        ? (fromAbove ? entry[dec].close > z.high : entry[dec].close < z.low)
        : (fromAbove ? b.close > z.high : b.close < z.low);

      // Distance to the next level BEYOND the one being touched, in the
      // direction price is travelling.
      const beyond = zones
        .filter(w => w.confirmedTime <= b.time && Math.abs(w.price - z.price) > a[dec] * 0.5)
        .filter(w => fromAbove ? w.price < z.price : w.price > z.price)
        .sort((x, y) => Math.abs(x.price - z.price) - Math.abs(y.price - z.price))[0];
      const room = beyond ? Math.abs(beyond.price - z.price) / a[dec] : 99;
      if (room < minRoom || room > maxRoom) continue;

      let go = null;
      if (mode === 'break') {
        // Fresh level, arrived hard, bar did NOT close back out.
        if (testNo > maxTestBreak || speed < fastATR || closedOut) continue;
        go = fromAbove ? 'short' : 'long';        // continue through
      } else if (mode === 'reverse_pattern') {
        // Rejection candle in the direction of the turn, printed at the level.
        const pat = detect(entry, dec, a[dec]);
        const bullish = pat.hammer || pat.bullEngulf || pat.morningStar;
        const bearish = pat.shootingStar || pat.bearEngulf || pat.eveningStar;
        if (fromAbove ? !bullish : !bearish) continue;
        go = fromAbove ? 'long' : 'short';
      } else {
        // Well-tested level, drifted in, bar closed back out.
        if (testNo < minTestReverse || speed >= slowATR) continue;
        if (requireClosedOut && !closedOut) continue;
        go = fromAbove ? 'long' : 'short';        // turn back
      }

      const L = go === 'long';
      // zone_limit fills at the level itself. Only legitimate if the bar
      // actually traded there, which the touch test already guarantees.
      // Limit resting at the zone: filled only if THIS bar trades there, and
      // only at a price the bar actually reached.
      let px;
      if (lim) {
        if (L ? b.low > z.price : b.high < z.price) continue;   // never reached
        px = z.price;
      } else {
        px = entry[i + 1].open;
      }
      const buf = a[dec] * stopBufferATR;
      // Break: invalidated by price returning to the far side of the zone.
      // Reverse: invalidated by the touch bar's extreme giving way.
      // A pattern trade is invalidated when the rejection itself fails — i.e.
      // price takes out the wick that defined it. A fixed 1 ATR stop sits at an
      // arbitrary distance and gets picked off while the idea is still valid,
      // which is why the pattern classified at 65% but traded at 48%.
      const patStop = mode === 'reverse_pattern'
        ? (go === 'long' ? entry[dec].low - a[dec] * stopBufferATR
                         : entry[dec].high + a[dec] * stopBufferATR)
        : null;
      const stop = patStop != null ? patStop : geom === 'atr'
        ? (L ? px - a[dec] * stopATR : px + a[dec] * stopATR)
        : mode === 'break'
          ? (L ? z.low - buf : z.high + buf)
          : (L ? Math.min(b.low, z.low) - buf : Math.max(b.high, z.high) + buf);

      const risk = Math.abs(px - stop);
      if (!risk) continue;
      if (L ? px <= stop : px >= stop) continue;
      if (ctx.spread && ctx.spread / risk > maxSpreadFrac) continue;

      if (geom === 'atr') {
        // Target still measured in ATR, but risk is now the structural distance.
        const tgt = L ? px + a[dec] * targetATR : px - a[dec] * targetATR;
        const rrA = Math.abs(tgt - px) / risk;
        signals.push({
          index: lim ? i : i + 1,
          time: entry[lim ? i : i + 1].time, dir: go,
          entry: px, stop, target: tgt, risk, rr: rrA,
          meta: { mode, zone: z.price, testNo, speed: +speed.toFixed(2), fromAbove, closedOut },
        });
        continue;
      }

      // Target: the next level in the direction of travel.
      const ahead = zones
        .filter(w => w.confirmedTime <= b.time && Math.abs(w.price - z.price) > a[i] * 0.5)
        .filter(w => L ? w.price > px : w.price < px)
        .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))[0];
      if (!ahead) continue;
      let target = ahead.price;
      let rr = Math.abs(target - px) / risk;
      if (rr < minRR) continue;
      if (rr > maxRR) { target = L ? px + maxRR * risk : px - maxRR * risk; rr = maxRR; }

      signals.push({
        index: lim ? i : i + 1, time: entry[lim ? i : i + 1].time, dir: go,
        entry: px, stop, target, risk, rr,
        meta: { mode, zone: z.price, testNo, speed: +speed.toFixed(2), fromAbove, closedOut },
      });
    }
  }
  return signals;
}
