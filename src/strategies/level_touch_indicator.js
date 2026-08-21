/**
 * Strategy 3 — enter AT the level, timed by an indicator.
 *
 * The previous version required a confirmed CHoCH before entering. A swing
 * needs 5 bars to confirm, so entry landed hours after the turn — measurably
 * worse than random (-3.86 sd, n=245), consistent with the user's own read
 * that they were "waiting for too much of the move to happen".
 *
 * This is what they described doing before adopting that rule: take the level,
 * accept that some attempts fail, keep the size small. Because price lingers
 * and fakes out at levels, a single indicator times the entry instead of
 * structure.
 *
 * ONE trigger at a time, deliberately. With five indicators available, stacking
 * them and tuning until something looks good would fit noise — and at these
 * sample sizes it would be indistinguishable from an edge.
 */
import { rsi, atr, sma, macd, bollinger, stochastic, rvi } from '../indicators.js';
import { buildZones } from '../structure.js';

export const meta = {
  name: 'level_touch_indicator',
  entryTF: 'H1',
  levelTFs: ['H4', 'D', 'W'],
  warmup: 120,
  triggers: ['none', 'macd', 'bb', 'stoch', 'rvi', 'sma50', 'rsi', 'reject', 'reject+macd', 'reject+stoch'],
};

export function generate(entry, levelBars, opts = {}, ctx = {}) {
  const {
    trigger = 'none',
    tolATR = 0.5,
    minTouches = 2,
    maxTouches = 4,       // measured: 5+ touch zones hold 39.6% vs 46.6% at 2
    zoneDistATR = 0.4,    // "at" the level, not near it
    stopBufferATR = 0.5,  // beyond the far edge of the zone
    minRR = 1.5,
    maxRR = 3,
    maxSpreadFrac = 0.25,
    cooldownBars = 24,    // one attempt per zone per window
    invert = false,       // Diagnostic. Fading levels measured -9.4 sd; if that
                          // is a real market effect the mirror trade must come
                          // back near +9 sd. If it does not, the fault is in
                          // this simulation, not in the market.
  } = opts;

  const zones = [];
  for (const tf of meta.levelTFs) {
    const b = levelBars[tf];
    if (!b || b.length < 30) continue;
    for (const z of buildZones(b, { lookback: 5, tolATR, minTouches })) {
      if (z.touches <= maxTouches) zones.push({ ...z, tf });
    }
  }
  if (!zones.length) return [];

  const closes = entry.map(b => b.close);
  const a = atr(entry, 14);
  const r = rsi(closes, 14);
  const md = macd(closes);
  const bb = bollinger(closes);
  const st = stochastic(entry);
  const rv = rvi(entry);
  const s50 = sma(closes, 50);

  // Each trigger answers: is the level being defended, right now, in this
  // direction? Every one reads bar i only — no forward reference.
  const fired = (i, isLong, override) => {
    const prev = i - 1;
    switch (override || trigger) {
      case 'none': return true;
      // The missing ingredient. Every trigger above fires on price TOUCHING the
      // level, which includes a trend cutting straight through it — buying
      // support on the way down, every time, by construction. Rejection asks
      // for evidence the level was defended: price traded into the zone and
      // closed back out of it, leaving a wick.
      case 'reject': {
        const z = ctx._zone;
        if (!z) return false;
        const b = entry[i];
        const body = Math.abs(b.close - b.open);
        const wick = isLong ? (Math.min(b.open, b.close) - b.low) : (b.high - Math.max(b.open, b.close));
        const closedOut = isLong ? b.close > z.high : b.close < z.low;
        const enteredZone = isLong ? b.low <= z.high : b.high >= z.low;
        return enteredZone && closedOut && wick > body * 0.5;
      }
      case 'reject+macd':
        return fired.call(null, i, isLong, 'reject') && fired.call(null, i, isLong, 'macd');
      case 'reject+stoch':
        return fired.call(null, i, isLong, 'reject') && fired.call(null, i, isLong, 'stoch');
      case 'macd': {
        if (md.hist[i] == null || md.hist[prev] == null) return false;
        return isLong ? (md.hist[prev] <= 0 && md.hist[i] > 0) : (md.hist[prev] >= 0 && md.hist[i] < 0);
      }
      case 'bb': {
        if (bb.pctB[i] == null || bb.pctB[prev] == null) return false;
        // Price pushed outside the band and is closing back inside it.
        return isLong ? (bb.pctB[prev] < 0 && bb.pctB[i] >= 0) : (bb.pctB[prev] > 1 && bb.pctB[i] <= 1);
      }
      case 'stoch': {
        if (st.k[i] == null || st.d[i] == null || st.k[prev] == null || st.d[prev] == null) return false;
        return isLong
          ? (st.k[prev] <= st.d[prev] && st.k[i] > st.d[i] && st.k[i] < 40)
          : (st.k[prev] >= st.d[prev] && st.k[i] < st.d[i] && st.k[i] > 60);
      }
      case 'rvi': {
        if (rv.rvi[i] == null || rv.signal[i] == null || rv.rvi[prev] == null) return false;
        return isLong
          ? (rv.rvi[prev] <= rv.signal[prev] && rv.rvi[i] > rv.signal[i])
          : (rv.rvi[prev] >= rv.signal[prev] && rv.rvi[i] < rv.signal[i]);
      }
      case 'sma50': {
        if (s50[i] == null) return false;
        // Level is being defended on the correct side of the trend filter.
        return isLong ? entry[i].close > s50[i] : entry[i].close < s50[i];
      }
      case 'rsi': {
        if (r[i] == null) return false;
        return isLong ? r[i] < 35 : r[i] > 65;
      }
      default: return false;
    }
  };

  const signals = [];
  const lastFire = new Map();

  for (let i = meta.warmup; i < entry.length - 1; i++) {
    const bar = entry[i];
    if (a[i] == null) continue;

    for (const isLong of [true, false]) {
      const kind = isLong ? 'support' : 'resistance';
      const near = zones.filter(z =>
        z.kind === kind && z.confirmedTime <= bar.time &&
        // Price must have actually reached into the zone on this bar.
        bar.low <= z.high + a[i] * zoneDistATR && bar.high >= z.low - a[i] * zoneDistATR);
      if (!near.length) continue;
      // Prefer the FEWEST touches — measured 46.6% hold at 2 vs 39.6% at 5+.
      const zone = near.sort((x, y) => x.touches - y.touches)[0];

      const key = `${kind}:${zone.price.toFixed(6)}`;
      if (i - (lastFire.get(key) ?? -1e9) < cooldownBars) continue;
      ctx._zone = zone;
      if (!fired(i, isLong)) continue;

      const px = entry[i + 1].open;
      const buf = a[i] * stopBufferATR;
      const stop = isLong ? zone.low - buf : zone.high + buf;
      const risk = Math.abs(px - stop);
      if (!risk) continue;
      if (isLong ? px <= stop : px >= stop) continue;
      if (ctx.spread && ctx.spread / risk > maxSpreadFrac) continue;

      const opp = zones
        .filter(z => z.kind === (isLong ? 'resistance' : 'support') && z.confirmedTime <= bar.time)
        .filter(z => isLong ? z.price > px : z.price < px)
        .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))[0];
      if (!opp) continue;
      let target = opp.price;
      let rr = Math.abs(target - px) / risk;
      if (rr < minRR) continue;
      if (rr > maxRR) { target = isLong ? px + maxRR * risk : px - maxRR * risk; rr = maxRR; }

      lastFire.set(key, i);
      // Mirror the trade about the entry: same bar, same risk, opposite side.
      const d = invert ? (isLong ? 'short' : 'long') : (isLong ? 'long' : 'short');
      const st2 = invert ? (isLong ? px + risk : px - risk) : stop;
      const tg2 = invert ? (isLong ? px - rr * risk : px + rr * risk) : target;
      signals.push({
        index: i + 1, time: entry[i + 1].time,
        dir: d,
        entry: px, stop: st2, target: tg2, risk, rr,
        meta: { zone: zone.price, touches: zone.touches, zoneTF: zone.tf, trigger },
      });
    }
  }
  return signals;
}
