/**
 * Candlestick pattern detection over plain OHLC bars.
 *
 * Every function reads bar i and, where the pattern needs it, i-1 and i-2.
 * Nothing reads forward. Sizes are normalised by ATR so "long wick" means the
 * same thing on GBPJPY as on EURCHF — a fixed pip threshold would make every
 * pattern a volatility proxy rather than a shape.
 *
 * Prior worth stating: MACD, Bollinger, Stochastic, RVI, RSI and SMA distance
 * all measured flat across 90,000 labelled outcomes. Patterns are a different
 * kind of signal, but the base rate for "well-known indicator predicts FX
 * direction" is currently zero for six out of six.
 */
const body = b => Math.abs(b.close - b.open);
const range = b => (b.high - b.low) || 1e-12;
const upperWick = b => b.high - Math.max(b.open, b.close);
const lowerWick = b => Math.min(b.open, b.close) - b.low;
const bull = b => b.close > b.open;

/** Long lower wick, small body near the top — rejection of lower prices. */
export function hammer(bars, i, av) {
  const b = bars[i];
  if (!av || range(b) < av * 0.5) return false;
  return lowerWick(b) >= body(b) * 2 && lowerWick(b) >= range(b) * 0.5 && upperWick(b) <= range(b) * 0.25;
}

/** Mirror of hammer — rejection of higher prices. */
export function shootingStar(bars, i, av) {
  const b = bars[i];
  if (!av || range(b) < av * 0.5) return false;
  return upperWick(b) >= body(b) * 2 && upperWick(b) >= range(b) * 0.5 && lowerWick(b) <= range(b) * 0.25;
}

/** Body fully covers the prior body, opposite colour. */
export function engulfing(bars, i, av, dir) {
  if (i < 1) return false;
  const b = bars[i], p = bars[i - 1];
  if (!av || body(b) < av * 0.4) return false;
  if (body(p) === 0) return false;
  const covers = Math.max(b.open, b.close) >= Math.max(p.open, p.close)
    && Math.min(b.open, b.close) <= Math.min(p.open, p.close);
  if (!covers) return false;
  return dir === 'bull' ? (bull(b) && !bull(p)) : (!bull(b) && bull(p));
}

/** Indecision: body is a small fraction of a normal-sized range. */
export function doji(bars, i, av) {
  const b = bars[i];
  if (!av || range(b) < av * 0.4) return false;
  return body(b) <= range(b) * 0.1;
}

/** Range contained entirely within the prior bar — compression. */
export function insideBar(bars, i) {
  if (i < 1) return false;
  return bars[i].high <= bars[i - 1].high && bars[i].low >= bars[i - 1].low;
}

/** Range engulfs the prior bar's range — expansion. */
export function outsideBar(bars, i) {
  if (i < 1) return false;
  return bars[i].high >= bars[i - 1].high && bars[i].low <= bars[i - 1].low;
}

/** Big body, almost no wick — one side in control for the whole bar. */
export function marubozu(bars, i, av, dir) {
  const b = bars[i];
  if (!av || body(b) < av * 0.8) return false;
  if (body(b) < range(b) * 0.8) return false;
  return dir === 'bull' ? bull(b) : !bull(b);
}

/** Three-bar reversal: strong bar, small indecisive bar, strong opposite bar. */
export function star(bars, i, av, dir) {
  if (i < 2) return false;
  const [a, m, c] = [bars[i - 2], bars[i - 1], bars[i]];
  if (!av) return false;
  if (body(m) > body(a) * 0.5 || body(m) > av * 0.3) return false;
  if (body(a) < av * 0.5 || body(c) < av * 0.5) return false;
  return dir === 'bull'
    ? (!bull(a) && bull(c) && c.close > (a.open + a.close) / 2)
    : (bull(a) && !bull(c) && c.close < (a.open + a.close) / 2);
}

/** All patterns present on bar i, as a flat name->boolean map. */
export function detect(bars, i, av) {
  return {
    hammer: hammer(bars, i, av),
    shootingStar: shootingStar(bars, i, av),
    bullEngulf: engulfing(bars, i, av, 'bull'),
    bearEngulf: engulfing(bars, i, av, 'bear'),
    doji: doji(bars, i, av),
    inside: insideBar(bars, i),
    outside: outsideBar(bars, i),
    bullMaru: marubozu(bars, i, av, 'bull'),
    bearMaru: marubozu(bars, i, av, 'bear'),
    morningStar: star(bars, i, av, 'bull'),
    eveningStar: star(bars, i, av, 'bear'),
  };
}
