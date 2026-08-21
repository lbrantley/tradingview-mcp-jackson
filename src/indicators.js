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

/** MACD. Returns aligned {macd, signal, hist} arrays. */
export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] == null || s[i] == null) ? null : f[i] - s[i]);
  // The signal line is an EMA of the MACD line, so it can only start once the
  // MACD line does. Feed it the defined section and pad back to full length.
  const start = line.findIndex(v => v != null);
  const sigRaw = start < 0 ? [] : ema(line.slice(start), sig);
  const signal = new Array(closes.length).fill(null);
  for (let i = 0; i < sigRaw.length; i++) signal[start + i] = sigRaw[i];
  return { macd: line, signal, hist: line.map((v, i) => (v == null || signal[i] == null) ? null : v - signal[i]) };
}

/** Bollinger Bands. `pctB` is where price sits in the band: 0 = lower, 1 = upper. */
export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const pctB = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    pctB[i] = upper[i] === lower[i] ? 0.5 : (closes[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { mid, upper, lower, pctB };
}

/** Slow stochastic: %K smoothed, %D = SMA of %K. */
export function stochastic(bars, period = 14, kSmooth = 3, dSmooth = 3) {
  const raw = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
    raw[i] = hi === lo ? 50 : 100 * (bars[i].close - lo) / (hi - lo);
  }
  const defined = raw.filter(v => v != null);
  const kS = sma(defined, kSmooth);
  const k = new Array(bars.length).fill(null);
  const off = raw.findIndex(v => v != null);
  for (let i = 0; i < kS.length; i++) k[off + i] = kS[i];
  const kDef = k.filter(v => v != null);
  const dS = sma(kDef, dSmooth);
  const d = new Array(bars.length).fill(null);
  const off2 = k.findIndex(v => v != null);
  for (let i = 0; i < dS.length; i++) d[off2 + i] = dS[i];
  return { k, d };
}

/**
 * Relative Vigor Index. Compares where a bar closes within its range, on the
 * idea that in an uptrend closes sit near highs. Uses the standard 1-2-2-1
 * weighting before averaging, and the same weighting again for the signal.
 */
export function rvi(bars, period = 10) {
  const n = bars.length;
  const num = new Array(n).fill(null), den = new Array(n).fill(null);
  for (let i = 3; i < n; i++) {
    const w = (f) => (f(bars[i]) + 2 * f(bars[i - 1]) + 2 * f(bars[i - 2]) + f(bars[i - 3])) / 6;
    num[i] = w(b => b.close - b.open);
    den[i] = w(b => b.high - b.low);
  }
  const out = new Array(n).fill(null);
  for (let i = 3 + period - 1; i < n; i++) {
    let sn = 0, sd = 0;
    for (let j = i - period + 1; j <= i; j++) { sn += num[j]; sd += den[j]; }
    out[i] = sd === 0 ? 0 : sn / sd;
  }
  const signal = new Array(n).fill(null);
  for (let i = 3; i < n; i++) {
    if (out[i] == null || out[i - 3] == null) continue;
    signal[i] = (out[i] + 2 * out[i - 1] + 2 * out[i - 2] + out[i - 3]) / 6;
  }
  return { rvi: out, signal };
}
