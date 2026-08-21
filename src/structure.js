/**
 * Market structure from plain candles — zones, BOS, CHoCH.
 *
 * These are algorithmic definitions over swing points, not proprietary maths.
 * LuxAlgo packages them; it does not own them. Computing them here makes them
 * backtestable and unit-testable, which the CDP-scraped version never was —
 * and removes the last reason the system needed TradingView.
 */
import { swings, atr } from './indicators.js';

/**
 * Multi-touch zones. Prices are never exact, so nearby swing points are one
 * level: cluster them by proximity and count how many times price turned there.
 *
 * `tolATR` is the cluster width in ATR, so a zone on GBPJPY is wider in pips
 * than one on EURCHF without hand-tuning 28 pairs.
 *
 * Each zone carries `confirmedAt` — the bar by which every one of its touches
 * was knowable. Reading a zone before that index is lookahead.
 */
export function buildZones(bars, { lookback = 5, tolATR = 0.5, minTouches = 2, minWidthATR = 0.25 } = {}) {
  const a = atr(bars, 14);
  const { highs, lows } = swings(bars, lookback);

  const mk = (idxs, kind) => {
    const pts = idxs.map(i => ({
      i, price: kind === 'resistance' ? bars[i].high : bars[i].low,
      confirmedAt: i + lookback,
    })).sort((x, y) => x.price - y.price);

    const clusters = [];
    for (const p of pts) {
      const tol = (a[p.i] || a.filter(Boolean)[0] || 0) * tolATR;
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(p.price - last.mean) <= tol) {
        last.points.push(p);
        last.mean = last.points.reduce((s, q) => s + q.price, 0) / last.points.length;
      } else {
        clusters.push({ points: [p], mean: p.price });
      }
    }
    return clusters
      .filter(c => c.points.length >= minTouches)
      .map(c => {
        // A zone needs WIDTH. Taking min-max of the clustered swing points
        // produced 2-pip bands on NZDJPY H4 — a line, not a zone — so a touch
        // 13 pips away never registered while a trader would obviously count
        // it. Floor the half-width at minWidthATR so the band reflects where
        // price is reacting rather than the exact pips two swings printed.
        const lo = Math.min(...c.points.map(p => p.price));
        const hi = Math.max(...c.points.map(p => p.price));
        const at = a[c.points[c.points.length - 1].i] || a.find(Boolean) || 0;
        const half = Math.max((hi - lo) / 2, at * minWidthATR);
        return {
        kind,
        price: c.mean,
        low: c.mean - half,
        high: c.mean + half,
        touches: c.points.length,
        // Usable only once the LAST touch is confirmed.
        confirmedAt: Math.max(...c.points.map(p => p.confirmedAt)),
        // Zones are built on H4/D/W but consumed on H1, and bar indices do not
        // translate across timeframes. Carry the wall-clock time so a lower
        // timeframe can ask "was this knowable yet?" without index maths.
        confirmedTime: bars[Math.min(bars.length - 1, Math.max(...c.points.map(p => p.confirmedAt)))].time,
        firstAt: Math.min(...c.points.map(p => p.i)),
        };
      });
  };

  return [...mk(highs, 'resistance'), ...mk(lows, 'support')];
}

/**
 * Zones visible as of bar `i`, nearest first. A zone whose last touch has not
 * yet been confirmed does not exist yet.
 */
export function zonesAt(zones, i, price, { maxDistATR = 1.0, atrVal = null } = {}) {
  const out = zones.filter(z => z.confirmedAt <= i);
  if (atrVal == null) return out;
  return out
    .filter(z => Math.abs(z.price - price) <= atrVal * maxDistATR)
    .sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price));
}

/**
 * Walk swing points in time order and label market structure.
 *
 *   BOS   — trend continues: an uptrend takes out its last swing HIGH
 *   CHoCH — character changes: an uptrend breaks its last higher LOW, which
 *           is the first evidence the trend may be over
 *
 * CHoCH is the reversal trigger; BOS is the continuation trigger. Returns
 * events stamped with the bar the break happened on, so a backtest can only
 * see an event once price has actually broken the level.
 */
export function structureEvents(bars, { lookback = 5 } = {}) {
  const { highs, lows } = swings(bars, lookback);
  const pts = [
    ...highs.map(i => ({ i, kind: 'high', price: bars[i].high })),
    ...lows.map(i => ({ i, kind: 'low', price: bars[i].low })),
  ].sort((a, b) => a.i - b.i);

  const events = [];
  let trend = null;            // 'bull' | 'bear' | null
  let lastHigh = null, lastLow = null;

  for (const p of pts) {
    if (p.kind === 'high') {
      if (lastHigh && p.price > lastHigh.price && trend !== 'bull') {
        // Broke a prior high while not in an uptrend — character change up.
        events.push({ type: trend === 'bear' ? 'CHoCH' : 'BOS', dir: 'bull', at: p.i, level: lastHigh.price, confirmedAt: p.i + lookback });
        trend = 'bull';
      } else if (lastHigh && p.price > lastHigh.price) {
        events.push({ type: 'BOS', dir: 'bull', at: p.i, level: lastHigh.price, confirmedAt: p.i + lookback });
      }
      lastHigh = p;
    } else {
      if (lastLow && p.price < lastLow.price && trend !== 'bear') {
        events.push({ type: trend === 'bull' ? 'CHoCH' : 'BOS', dir: 'bear', at: p.i, level: lastLow.price, confirmedAt: p.i + lookback });
        // eslint-disable-next-line no-unused-expressions
        trend = 'bear';
      } else if (lastLow && p.price < lastLow.price) {
        events.push({ type: 'BOS', dir: 'bear', at: p.i, level: lastLow.price, confirmedAt: p.i + lookback });
      }
      lastLow = p;
    }
  }
  return events;
}

/** Most recent structure event confirmed as of bar `i`. */
export function lastEventAt(events, i, { within = Infinity } = {}) {
  for (let n = events.length - 1; n >= 0; n--) {
    const e = events[n];
    if (e.confirmedAt <= i && i - e.confirmedAt <= within) return e;
  }
  return null;
}


/**
 * Levels the way a trader draws them: price bands where many bars have turned,
 * found by histogram rather than by strict swing structure.
 *
 * buildZones() requires a bar lower than the N bars either side, so in a
 * cluster of similar lows only one qualifies and no zone forms. On NZDJPY the
 * April 2026 lows (90.712-90.992 over five days) are obvious by eye and produce
 * NO zone at all under swing detection. This finds them.
 *
 * Method: bucket every bar's high and low into ATR-scaled price bins, then keep
 * bins where price turned on `minBars` separate occasions. Occasions are counted
 * with a gap requirement so one long consolidation is not mistaken for repeated
 * independent tests.
 */
export function buildLevels(bars, { binATR = 0.35, minBars = 3, gap = 3, lookback = 5 } = {}) {
  const a = atr(bars, 14);
  const ref = a.filter(Boolean).sort((x, y) => x - y)[Math.floor(a.filter(Boolean).length / 2)] || 0;
  if (!ref) return [];
  const bin = ref * binATR;

  const mk = (pick, kind) => {
    const buckets = new Map();
    for (let i = lookback; i < bars.length - lookback; i++) {
      const px = pick(bars[i]);
      const key = Math.round(px / bin);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ i, px });
    }
    const out = [];
    for (const [key, pts] of buckets) {
      // Separate touches only — consecutive bars in one dip are one event.
      const events = [];
      let last = -1e9;
      for (const p of pts) { if (p.i - last >= gap) events.push(p); last = p.i; }
      if (events.length < minBars) continue;
      const prices = events.map(e => e.px);
      const mean = prices.reduce((x, y) => x + y, 0) / prices.length;
      out.push({
        kind, price: mean,
        low: mean - bin / 2, high: mean + bin / 2,
        touches: events.length,
        firstAt: events[0].i,
        confirmedAt: events[Math.min(events.length - 1, minBars - 1)].i + lookback,
        confirmedTime: bars[Math.min(bars.length - 1, events[Math.min(events.length - 1, minBars - 1)].i + lookback)].time,
        _key: key,
      });
    }
    return out;
  };
  return [...mk(b => b.low, 'support'), ...mk(b => b.high, 'resistance')];
}
