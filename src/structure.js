/**
 * Market structure from plain candles — zones, BOS, CHoCH.
 *
 * These are algorithmic definitions over swing points, not proprietary maths.
 * LuxAlgo packages them; it does not own them. Computing them here makes them
 * backtestable and unit-testable, which the CDP-scraped version never was —
 * and removes the last reason the system needed TradingView.
 */
import { swings, atr, lastConfirmedSwing } from './indicators.js';

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

/**
 * Levels the way the user actually counts them.
 *
 * buildLevels counts a TOUCH as any bar whose high/low lands in the band, 3+
 * bars apart. No excursion required. That is why NZDJPY 95.303 scored "4
 * touches" while price had only genuinely come back to it once.
 *
 * The user's count is a round trip: price forms a swing high/low, LEAVES,
 * makes the opposing swing on the other side, and only then does a return
 * count as a touch. Resistance formed 7/19-7/20, price made a swing low at
 * 91.669 on 8/02, came back 8/20 — that is one touch, not four.
 *
 * awayATR is what makes the opposing swing structural rather than a wiggle:
 * the swing must sit at least that many ATR beyond the far side of the band.
 *
 * `confirmedAt` is the bar the level reaches minTouches, so nothing is
 * tradeable before the round trips that qualify it have actually happened.
 */
export function buildSwingTouchLevels(bars, {
  lookback = 5, binATR = 0.35, minTouches = 1, awayATR = 1.0,
} = {}) {
  const a = atr(bars, 14);
  const defined = a.filter(Boolean).sort((x, y) => x - y);
  const ref = defined[Math.floor(defined.length / 2)] || 0;
  if (!ref) return [];
  const bin = ref * binATR;

  const { highs, lows } = swings(bars, lookback);
  const out = [];

  const build = (anchors, opposing, kind) => {
    for (const k of anchors) {
      const px = kind === 'resistance' ? bars[k].high : bars[k].low;
      const low = px - bin / 2, high = px + bin / 2;
      const born = k + lookback;                 // swing unknowable before this
      if (born >= bars.length) continue;

      const touchAt = [];
      let armed = false;                         // an opposing swing has landed
      let inBand = true;                         // start at the level itself

      for (let i = born + 1; i < bars.length; i++) {
        const inNow = bars[i].low <= high && bars[i].high >= low;

        // Has an opposing swing confirmed since we last stood at the band, and
        // is it far enough past the band to count as a real excursion?
        if (!armed && !inNow) {
          for (const j of opposing) {
            if (j + lookback > i) break;         // not yet confirmed
            if (j <= (touchAt.length ? touchAt[touchAt.length - 1] : born)) continue;
            const sp = kind === 'resistance' ? bars[j].low : bars[j].high;
            const beyond = kind === 'resistance' ? low - sp : sp - high;
            if (beyond >= (a[j] || ref) * awayATR) { armed = true; break; }
          }
        }

        if (inNow && !inBand && armed) { touchAt.push(i); armed = false; }
        inBand = inNow;
      }

      if (touchAt.length < minTouches) continue;
      out.push({
        kind, price: px, low, high,
        touches: touchAt.length,
        firstAt: k,
        confirmedAt: touchAt[minTouches - 1],
        confirmedTime: bars[touchAt[minTouches - 1]].time,
      });
    }
  };

  build(highs, lows, 'resistance');
  build(lows, highs, 'support');
  return out;
}

/**
 * Classify every historical touch at a level: did price TURN AWAY or PASS THROUGH?
 *
 * The point of this is target grading. buildLevels scores a level by visit
 * count, which says nothing about what happened when price got there. NZDJPY
 * 94.145 carried 11 visits and a 55% respect rate — six holds, five passes, no
 * pattern — and still got picked as a target purely because of where it sat.
 *
 * respected — price moved `thresh` ATR back the way it came
 * passed    — price closed through and travelled `thresh` ATR beyond
 * stall     — neither, inside the forward window
 *
 * Each event carries the bar it resolved on, so a caller can take only the
 * history available at a given bar and avoid lookahead.
 */
export function levelRespectEvents(bars, zone, { forward = 10, threshATR = 1.0 } = {}) {
  const a = atr(bars, 14);
  const hits = [];
  for (let k = 0; k < bars.length; k++)
    if (bars[k].low <= zone.high && bars[k].high >= zone.low) hits.push(k);

  const spans = [];
  let start = null, prev = null;
  for (const k of hits) {
    if (start == null) { start = k; prev = k; continue; }
    if (k - prev <= 2) { prev = k; continue; }
    spans.push([start, prev]); start = k; prev = k;
  }
  if (start != null) spans.push([start, prev]);

  const out = [];
  for (const [st, en] of spans) {
    if (st === 0 || !a[en]) continue;
    const fromAbove = bars[st - 1].close > zone.price;
    const thresh = a[en] * threshATR;
    let kind = 'stall';
    for (let j = en + 1; j <= Math.min(bars.length - 1, en + forward); j++) {
      const b = bars[j];
      if (fromAbove) {
        if (b.high >= zone.high + thresh) { kind = 'respected'; break; }
        if (b.close < zone.low && (zone.low - b.low) >= thresh) { kind = 'passed'; break; }
      } else {
        if (b.low <= zone.low - thresh) { kind = 'respected'; break; }
        if (b.close > zone.high && (b.high - zone.high) >= thresh) { kind = 'passed'; break; }
      }
    }
    out.push({ end: en, kind });
  }
  return out;
}

/**
 * PROVISIONAL breaks of structure — the way a trader reads a chart.
 *
 * structureEvents() only calls a break when a NEW swing forms past the old one,
 * and a swing is not knowable until `lookback` bars have closed either side. So
 * the code sees a break roughly a day (5 H4 bars) after the trader does.
 *
 * This is the trader's definition instead: price CLOSES beyond the last
 * confirmed swing. It is available the moment that bar closes.
 *
 * Note carefully what is and is not provisional. The SWING must still be fully
 * confirmed — using an unconfirmed swing would be lookahead, since you cannot
 * know a bar was a swing high until the bars after it have closed. Only the
 * BREAK is recognised early, and a close beyond a price that was already known
 * needs no future information at all.
 *
 * Returns events stamped with the bar the close happened on, which is also the
 * first bar they could be acted upon.
 */
export function provisionalEvents(bars, { lookback = 5 } = {}) {
  const { highs, lows } = swings(bars, lookback);
  const events = [];
  let trend = null;
  let usedHigh = null, usedLow = null;

  for (let i = lookback; i < bars.length; i++) {
    // Only swings whose confirmation window has already closed as of bar i.
    const hi = lastConfirmedSwing(highs, i, lookback);
    const lo = lastConfirmedSwing(lows, i, lookback);
    const c = bars[i].close;

    if (hi != null && hi !== usedHigh && c > bars[hi].high) {
      events.push({
        type: trend === 'bear' ? 'CHoCH' : 'BOS', dir: 'bull',
        at: i, level: bars[hi].high, time: bars[i].time,
        confirmedAt: i,                    // actionable on this bar's close
      });
      trend = 'bull';
      usedHigh = hi;                       // one event per swing, not one per bar
    }
    if (lo != null && lo !== usedLow && c < bars[lo].low) {
      events.push({
        type: trend === 'bull' ? 'CHoCH' : 'BOS', dir: 'bear',
        at: i, level: bars[lo].low, time: bars[i].time,
        confirmedAt: i,
      });
      trend = 'bear';
      usedLow = lo;
    }
  }
  return events;
}
