/**
 * Indicator maths over plain candle arrays. No chart, no CDP, no Pine.
 *
 * Everything here is standard and computable from OHLCV, which is the point:
 * the LuxAlgo studies forced the whole TradingView dependency, and on
 * production data they did not rank outcomes (ltfEvent none +0.135R vs
 * CHoCH+ -0.130R). These are testable and reproducible instead.
 *
 * All functions return arrays aligned to the input, padded with null where
 * there is not yet enough history. Aligned indexing matters — an off-by-one
 * between price and indicator is a silent lookahead bug.
 */

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += values[j];
      prev = s / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's RSI — the smoothing TradingView's RSI uses, not a plain average. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder's ATR. Used for stop sizing and for judging whether a stop is sane. */
export function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr = bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(
    b.high - b.low,
    Math.abs(b.high - bars[i - 1].close),
    Math.abs(b.low - bars[i - 1].close),
  ));
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Confirmed swing points: a bar whose high is the highest within `lookback`
 * bars either side. Confirmation costs `lookback` bars of delay, which is
 * real — a swing is not knowable until price has moved away from it. Returning
 * it earlier would be lookahead.
 *
 * Returns index arrays; caller reads bars[i].high / bars[i].low.
 */
export function swings(bars, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/**
 * Most recent swing high/low CONFIRMED as of bar `i` — i.e. one whose
 * confirmation window has already closed. This is the guard against lookahead:
 * a swing at index k is not usable until k + lookback.
 */
export function lastConfirmedSwing(swingIdx, i, lookback) {
  for (let n = swingIdx.length - 1; n >= 0; n--) {
    if (swingIdx[n] + lookback <= i) return swingIdx[n];
  }
  return null;
}
