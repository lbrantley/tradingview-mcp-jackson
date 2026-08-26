#!/usr/bin/env node
/**
 * Does price REACT at the 50 SMA the way it reacts at a static level?
 *
 * An earlier test measured "is price above or below the 50 SMA at entry" as a
 * directional filter and found it useless. That is a different claim from the
 * user's: that price pulls back TO the 50 SMA and then either bounces and
 * continues, or breaks through and runs, or breaks-retests-runs — and that it
 * is more pronounced on some pairs than others.
 *
 * So treat the SMA as a level and classify each touch the same way static
 * levels were classified, judged against the direction price ARRIVED from:
 *
 *   BOUNCE  price turns away and travels `thresh` ATR back the way it came
 *   BREAK   price closes through and travels `thresh` ATR beyond
 *   STALL   neither, inside the window
 *
 * Reported per pair, because "prevalent on certain pairs" is the specific
 * claim and an average across 28 would hide it.
 *
 * Usage: node scripts/test_sma_level.mjs [--tf H4] [--years 2] [--endYearsAgo 0]
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
import { atr, sma } from '../src/indicators.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'H4';
const YEARS = parseFloat(argOf('--years') || '2');
const END = parseFloat(argOf('--endYearsAgo') || '0');
const PERIOD = parseInt(argOf('--period') || '50', 10);
const TOUCH_ATR = 0.25, THRESH = 1.0, WINDOW = 20, MIN_AWAY = 1.0;

const per = [];
for (const sym of PAIRS) {
  try {
    const to = new Date(Date.now() - END * 365 * 24 * 3600e3);
    const from = new Date(to.getTime() - YEARS * 365 * 24 * 3600e3);
    const bars = ['D', 'W'].includes(TF)
      ? (await getCandles(sym, { granularity: TF, count: 5000 })).filter(b => b.time <= to.toISOString() && b.time >= from.toISOString())
      : await getCandlesRange(sym, { granularity: TF, from: from.toISOString(), to: to.toISOString() });
    if (bars.length < PERIOD + 100) continue;
    const a = atr(bars, 14);
    const s = sma(bars.map(b => b.close), PERIOD);

    let bounce = 0, brk = 0, stall = 0, lastTouch = -99;
    for (let i = PERIOD + 20; i < bars.length - WINDOW; i++) {
      if (a[i] == null || s[i] == null) continue;
      const b = bars[i];
      // A touch: the bar's range reaches the SMA.
      if (!(b.low <= s[i] + a[i] * TOUCH_ATR && b.high >= s[i] - a[i] * TOUCH_ATR)) continue;
      if (i - lastTouch < 5) continue;               // one event per approach

      // Price must have been AWAY from the SMA before returning — otherwise
      // this is price riding along it, not pulling back to it.
      let wasAway = false;
      for (let k = Math.max(0, i - 15); k < i - 2; k++) {
        if (s[k] != null && Math.abs(bars[k].close - s[k]) > a[k] * MIN_AWAY) { wasAway = true; break; }
      }
      if (!wasAway) continue;
      lastTouch = i;

      const fromAbove = bars[Math.max(0, i - 5)].close > s[i];
      const backPx = fromAbove ? s[i] + THRESH * a[i] : s[i] - THRESH * a[i];   // bounce
      const thruPx = fromAbove ? s[i] - THRESH * a[i] : s[i] + THRESH * a[i];   // break

      let out = 'stall';
      for (let j = i; j < Math.min(bars.length, i + WINDOW); j++) {
        const c = bars[j];
        if (fromAbove ? c.close >= backPx : c.close <= backPx) { out = 'bounce'; break; }
        if (fromAbove ? c.close <= thruPx : c.close >= thruPx) { out = 'break'; break; }
      }
      if (out === 'bounce') bounce++; else if (out === 'break') brk++; else stall++;
    }
    const n = bounce + brk + stall;
    if (n >= 20) per.push({ sym, n, bounce, brk, stall, bp: bounce / n * 100, kp: brk / n * 100 });
  } catch (e) { /* skip */ }
}

const N = per.reduce((a, p) => a + p.n, 0);
const B = per.reduce((a, p) => a + p.bounce, 0), K = per.reduce((a, p) => a + p.brk, 0);
console.log(`\n${PERIOD}-SMA AS A LEVEL — ${TF}, ${per.length} pairs, ${YEARS}y ending ${END}y ago`);
console.log(`touch = bar reaches the SMA after being >1 ATR away; outcome judged vs arrival direction\n`);
console.log(`  OVERALL  n=${N}   bounce ${(B / N * 100).toFixed(1)}%   break ${(K / N * 100).toFixed(1)}%   stall ${((N - B - K) / N * 100).toFixed(1)}%\n`);
per.sort((a, b) => b.bp - a.bp);
console.log('  pair       n    bounce   break   stall');
for (const p of per) {
  console.log(`  ${p.sym.padEnd(8)} ${String(p.n).padStart(4)}   ${p.bp.toFixed(1).padStart(5)}%  ${p.kp.toFixed(1).padStart(5)}%  ${(100 - p.bp - p.kp).toFixed(1).padStart(5)}%`);
}
