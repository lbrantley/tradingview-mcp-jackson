/**
 * ORDER BLOCKS — the second trade model, and the only one whose definition
 * came from the user rather than from me.
 *
 * Detection runs BACKWARD FROM A CHoCH, which is the whole point. An earlier
 * version scanned forward from every candle looking for "displacement plus a
 * structure break" and measured no edge at all on any timeframe. This one does
 * what the user actually does: a change of character is what says GO LOOK, and
 * the block is found by walking back from it.
 *
 *   1. pivot    a bar whose high exceeds the `lookback` bars either side
 *   2. trend    bearish structure = lower highs AND lower lows
 *   3. CHoCH    price takes out the last opposing swing. A WICK COUNTS.
 *               Each swing fires once and is then spent.
 *   4. block    walk back from the CHoCH to the first candle closing against
 *               the move
 *   5. zone     that candle's full high-to-low range
 *   6. entry    a limit at the edge price returns to — the top of a bullish
 *               block, the bottom of a bearish one
 *   7. stop     just beyond the far edge, so 1R IS THE ZONE'S OWN HEIGHT.
 *               Risk comes from structure; we never choose it.
 *
 * Daily bars. There is deliberately no ATR anywhere — thresholds on "how
 * violent is the takeoff" were tested across four windows and the user's own
 * textbook example failed every one of them.
 *
 * Split-validated on 14 fit / 14 untouched pairs, ~10 years:
 *      1R hit rate   67.2% / 67.9%      expectancy  +0.344R / +0.359R
 *      median MFE     1.44R / 1.43R     fill rate    95.1% / 96.0%
 *
 * Two bugs worth remembering, both caught by the user reading the output:
 *   - a swing that was never marked spent kept re-firing the CHoCH for weeks
 *   - two pivots cannot establish a trend; one lower high inside an uptrend
 *     was being called a change of character when it was a BOS
 */

export const OB_DEFAULTS = {
  lookback: 5,      // bars either side of a pivot. 3, 4 and 5 all reproduce the
                    // user's reference block; 1, 2, 6, 8 and 10 do not.
  need: 1,          // consecutive lower-high + lower-low pairs needed before a
                    // break counts as a change of character. 3 is too strict —
                    // it discards the user's own example.
  maxRun: 40,       // give up walking back after this many bars
  stopBuffer: 0.10, // stop this far beyond the far edge, in zone heights
  // UNTESTED. When a block expires was never settled — it is on the open list.
  // 120 days is where the fill data flattens: 87% of blocks that ever fill have
  // done so by then, 92% by 250. Beyond this the order is mostly just sitting
  // there. Needs its own test; do not treat this number as evidence.
  maxAgeDays: 120,
};

export function pivots(bars, lookback) {
  const highs = [], lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low  <= bars[i].low ) isLow  = false;
    }
    if (isHigh) highs.push(i);
    if (isLow)  lows.push(i);
  }
  return { highs, lows };
}

const descending = (bars, idx, n, key) => {
  if (idx.length < n + 1) return false;
  const s = idx.slice(-(n + 1));
  for (let i = 1; i < s.length; i++) if (bars[s[i]][key] >= bars[s[i-1]][key]) return false;
  return true;
};
const ascending = (bars, idx, n, key) => {
  if (idx.length < n + 1) return false;
  const s = idx.slice(-(n + 1));
  for (let i = 1; i < s.length; i++) if (bars[s[i]][key] <= bars[s[i-1]][key]) return false;
  return true;
};

/**
 * Every order block in `bars`, oldest first. Daily bars expected.
 * Each carries the indices it was built from so a caller can render it.
 */
export function findOrderBlocks(bars, opts = {}) {
  const o = { ...OB_DEFAULTS, ...opts };
  const { highs, lows } = pivots(bars, o.lookback);
  const isUp = c => c.close > c.open;
  const out = [], spentHigh = new Set(), spentLow = new Set();

  for (let i = 2; i < bars.length; i++) {
    // pivots are only knowable `lookback` bars after they print
    const hs = highs.filter(k => k < i - o.lookback);
    const ls = lows.filter(k => k < i - o.lookback);

    // BULLISH: a downtrend gets broken upward
    if (hs.length) {
      const swing = hs[hs.length - 1];
      if (!spentHigh.has(swing) && bars[i].high > bars[swing].high &&
          descending(bars, hs, o.need, 'high') && descending(bars, ls, o.need, 'low')) {
        spentHigh.add(swing);
        let k = i, steps = 0;
        while (k > 0 && isUp(bars[k]) && steps < o.maxRun) { k--; steps++; }
        if (!isUp(bars[k]) && steps >= 1) out.push(build(bars, k, i, swing, 1, o));
      }
    }
    // BEARISH: an uptrend gets broken downward
    if (ls.length) {
      const swing = ls[ls.length - 1];
      if (!spentLow.has(swing) && bars[i].low < bars[swing].low &&
          ascending(bars, hs, o.need, 'high') && ascending(bars, ls, o.need, 'low')) {
        spentLow.add(swing);
        let k = i, steps = 0;
        while (k > 0 && !isUp(bars[k]) && steps < o.maxRun) { k--; steps++; }
        if (isUp(bars[k]) && steps >= 1) out.push(build(bars, k, i, swing, -1, o));
      }
    }
  }
  return out;
}

function build(bars, blockIdx, chochIdx, swingIdx, dir, o) {
  const c = bars[blockIdx];
  const height = c.high - c.low;
  const entry = dir > 0 ? c.high : c.low;
  const far   = dir > 0 ? c.low  : c.high;
  const stop  = dir > 0 ? far - height * o.stopBuffer : far + height * o.stopBuffer;
  return {
    dir, blockIdx, chochIdx, swingIdx,
    blockTime: c.time, chochTime: bars[chochIdx].time,
    zoneHigh: c.high, zoneLow: c.low, height,
    entry, stop, risk: Math.abs(entry - stop),
    swing: dir > 0 ? bars[swingIdx].high : bars[swingIdx].low,
    // a CLOSE through the swing is stronger than a wick through it. Kept as a
    // grade rather than a gate: wicked-through blocks actually fill FASTER
    // (3 days vs 7), which fits the read that a wick is a liquidity raid.
    closedThrough: dir > 0 ? bars[chochIdx].close > bars[swingIdx].high
                           : bars[chochIdx].close < bars[swingIdx].low,
    runLen: chochIdx - blockIdx - 1,
  };
}

/**
 * Blocks that have not yet been filled, plus whether price has since traded
 * into them. `live` is the current price.
 */
export function pendingBlocks(bars, live, opts = {}) {
  const o = { ...OB_DEFAULTS, ...opts };
  const last = bars.length - 1;
  return findOrderBlocks(bars, o).map(b => {
    let filledAt = null, invalidatedAt = null;
    for (let j = b.chochIdx + 1; j <= last; j++) {
      if (filledAt === null &&
          (b.dir > 0 ? bars[j].low <= b.entry : bars[j].high >= b.entry)) filledAt = j;
      // once price runs past the stop the block is gone, filled or not
      if (b.dir > 0 ? bars[j].low <= b.stop : bars[j].high >= b.stop) { invalidatedAt = j; break; }
    }
    const distance = b.dir > 0 ? live - b.entry : b.entry - live;
    const age = last - b.chochIdx;
    return { ...b,
      barsSinceChoch: age, expired: age > o.maxAgeDays,
      filled: filledAt !== null, filledTime: filledAt ? bars[filledAt].time : null,
      invalidated: invalidatedAt !== null,
      distance, distanceR: distance / b.risk };
  });
}
