/**
 * Strategy 1 — Breakout with 50-SMA + RSI.
 * From the user's "4 hr trading strategy.pdf" (Alphaex Capital, March 2026):
 *
 *   - 50-period SMA on H4
 *   - recent swing high (longs) / swing low (shorts) relative to the SMA
 *   - RSI > 60 to confirm momentum
 *   - enter on H4 close beyond the swing level
 *   - stop just under the SMA
 *   - target = 2x (distance from SMA to swing level)
 *
 * Chosen first because it is seven unambiguous lines, so it can be falsified.
 * That is the whole point — the existing system has eight interacting signals
 * and when a trade loses you cannot say which rule was wrong.
 *
 * Decisions the PDF leaves open, made explicit here:
 *   - shorts mirror longs with RSI < 40
 *   - "just under the SMA" = 0.25 x ATR beyond it, so the buffer scales with
 *     volatility instead of being a fixed pip count across 28 pairs
 *   - a swing counts only once its confirmation window has closed
 *   - a setup is rejected if the stop would be under 0.5 x ATR (too tight to
 *     survive noise) or over 3 x ATR (risk out of proportion to the move)
 */
import { sma, rsi, atr, swings, lastConfirmedSwing } from '../indicators.js';

export const meta = {
  name: 'sma50_rsi_breakout',
  granularity: 'H4',
  warmup: 60,        // bars needed before the first signal can be trusted
};

export function generate(bars, opts = {}) {
  const {
    smaPeriod = 50,
    rsiPeriod = 14,
    rsiLong = 60,
    rsiShort = 40,
    swingLookback = 5,
    stopBufferATR = 0.25,
    minStopATR = 0.5,
    maxStopATR = 3.0,
    targetMult = 2.0,
  } = opts;

  const closes = bars.map(b => b.close);
  const s = sma(closes, smaPeriod);
  const r = rsi(closes, rsiPeriod);
  const a = atr(bars, 14);
  const sw = swings(bars, swingLookback);

  const signals = [];
  for (let i = meta.warmup; i < bars.length - 1; i++) {
    if (s[i] == null || r[i] == null || a[i] == null) continue;
    const bar = bars[i];

    for (const dir of ['long', 'short']) {
      const isLong = dir === 'long';

      // Trend filter: price on the correct side of the 50-SMA.
      if (isLong ? bar.close <= s[i] : bar.close >= s[i]) continue;
      // Momentum filter.
      if (isLong ? r[i] <= rsiLong : r[i] >= rsiShort) continue;

      // The swing being broken. Must already be confirmed as of this bar.
      const k = lastConfirmedSwing(isLong ? sw.highs : sw.lows, i, swingLookback);
      if (k == null) continue;
      const level = isLong ? bars[k].high : bars[k].low;

      // The swing has to sit beyond the SMA, i.e. this is a breakout in the
      // trend direction rather than a bounce inside it.
      if (isLong ? level <= s[i] : level >= s[i]) continue;

      // Trigger: this bar CLOSES beyond the level, and the previous bar did
      // not — so we take the break, not every bar after it.
      const broke = isLong ? bar.close > level : bar.close < level;
      const prevBroke = isLong ? bars[i - 1].close > level : bars[i - 1].close < level;
      if (!broke || prevBroke) continue;

      const buffer = a[i] * stopBufferATR;
      const stop = isLong ? s[i] - buffer : s[i] + buffer;

      // Entry is the NEXT bar's open. You cannot fill at a close you have only
      // just observed; taking it would be lookahead worth several pips a trade.
      const entry = bars[i + 1].open;
      const risk = Math.abs(entry - stop);
      if (!risk) continue;
      if (risk < a[i] * minStopATR || risk > a[i] * maxStopATR) continue;
      // Entry must still be on the right side of its own stop.
      if (isLong ? entry <= stop : entry >= stop) continue;

      const target = isLong
        ? entry + targetMult * Math.abs(level - s[i])
        : entry - targetMult * Math.abs(level - s[i]);
      if (isLong ? target <= entry : target >= entry) continue;

      signals.push({
        index: i + 1,            // bar the position opens on
        time: bars[i + 1].time,
        dir, entry, stop, target,
        risk,
        rr: Math.abs(target - entry) / risk,
        meta: { rsi: r[i], sma: s[i], atr: a[i], level },
      });
    }
  }
  return signals;
}
