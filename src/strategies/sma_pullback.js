/**
 * Type 2 — pullback to the 50 SMA, continuation.
 *
 * Built from what survived three-window testing at an SMA touch:
 *   base bounce rate            55.8 / 55.4 / 55.8%
 *   + stochastic CROSS (turn)   58.6 / 59.4 / 58.5%   (+3 every window)
 *   RSI EXTREME at the touch    18.5 / 24.2 / 27.2%   (level breaks 73-82%)
 *
 * So: take the cross, and exclude the stretched-RSI cases, which are price
 * arriving hard rather than drifting in — and hard arrivals go through.
 *
 * Deliberately does NOT use RSI-turning, which measured +15 but is identical
 * to "close ticked down then up" on 100% of bars; the move has already begun
 * when it fires.
 */
import { atr, sma, stochastic, rsi } from '../indicators.js';
import { buildLevels } from '../structure.js';

export const meta = { name: 'sma_pullback', entryTF: 'H4', levelTFs: ['D'], warmup: 80 };

export function generate(entry, levelBars, opts = {}, ctx = {}) {
  const {
    period = 50,
    touchATR = 0.25,
    minAwayATR = 1.0,      // must have left the SMA, not be riding it
    requireCross = true,
    excludeRsiExtreme = true,
    rsiLo = 40, rsiHi = 60,
    stopATR = 1.0,
    targetMode = 'atr',    // 'atr' | 'level'
    targetATR = 1.0,
    minRR = 0.5, maxRR = 4,
    maxSpreadFrac = 0.25,
    cooldown = 5,
  } = opts;

  const closes = entry.map(b => b.close);
  const a = atr(entry, 14);
  const s = sma(closes, period);
  const st = stochastic(entry, 14, 3, 3);
  const r = rsi(closes, 14);
  const levels = buildLevels(levelBars.D || entry, { binATR: 0.35, minBars: 3 });

  const out = [];
  let last = -99;
  for (let i = meta.warmup; i < entry.length - 1; i++) {
    if (a[i] == null || s[i] == null || st.k[i] == null || r[i] == null) continue;
    const b = entry[i];
    if (!(b.low <= s[i] + a[i] * touchATR && b.high >= s[i] - a[i] * touchATR)) continue;
    if (i - last < cooldown) continue;

    let away = false;
    for (let k = Math.max(0, i - 15); k < i - 2; k++) {
      if (s[k] != null && Math.abs(entry[k].close - s[k]) > a[k] * minAwayATR) { away = true; break; }
    }
    if (!away) continue;
    last = i;

    // Continuation is in the direction of the trend price pulled back FROM.
    const fromAbove = entry[Math.max(0, i - 5)].close > s[i];
    const L = fromAbove;                       // pulled back down to it -> long

    if (excludeRsiExtreme && (L ? r[i] < rsiLo : r[i] > rsiHi)) continue;

    if (requireCross) {
      let crossed = false;
      for (let q = i; q > i - 4 && q > 0; q--) {
        if (st.k[q] == null || st.d[q] == null || st.k[q - 1] == null || st.d[q - 1] == null) continue;
        const up = st.k[q - 1] <= st.d[q - 1] && st.k[q] > st.d[q];
        const dn = st.k[q - 1] >= st.d[q - 1] && st.k[q] < st.d[q];
        if (L ? up : dn) { crossed = true; break; }
      }
      if (!crossed) continue;
    }

    const px = entry[i + 1].open;
    const stop = L ? s[i] - a[i] * stopATR : s[i] + a[i] * stopATR;   // beyond the SMA
    const risk = Math.abs(px - stop);
    if (!risk || (L ? px <= stop : px >= stop)) continue;
    if (ctx.spread && ctx.spread / risk > maxSpreadFrac) continue;

    let target, rr;
    if (targetMode === 'atr') {
      target = L ? px + a[i] * targetATR : px - a[i] * targetATR;
      rr = Math.abs(target - px) / risk;
    } else {
      const ahead = levels.filter(z => L ? z.price > px : z.price < px)
        .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))
        .find(z => Math.abs(z.price - px) / risk >= minRR);
      if (!ahead) continue;
      target = ahead.price; rr = Math.abs(target - px) / risk;
    }
    if (rr < minRR) continue;
    if (rr > maxRR) { target = L ? px + maxRR * risk : px - maxRR * risk; rr = maxRR; }

    out.push({ index: i + 1, time: entry[i + 1].time, dir: L ? 'long' : 'short',
      entry: px, stop, target, risk, rr,
      meta: { sma: s[i], stoch: st.k[i], rsi: r[i] } });
  }
  return out;
}
