#!/usr/bin/env node
/**
 * Does combining 50 SMA + static level + Stochastic beat any of them alone?
 *
 * The user does not trade any indicator in isolation, so isolation tests may
 * understate them. But combinations are where overfitting lives: with three
 * components you can enumerate a dozen variants and one will look good by
 * chance. So the buckets below are fixed BEFORE running, every window is
 * reported, and only what holds in all three counts.
 *
 * Anchor is the 50 SMA touch, because that is the one component that survived
 * isolation testing (55% bounce, three windows, two timeframes). The question
 * is whether the other two add anything to it.
 *
 * Usage: node scripts/test_confluence.mjs [--tf H4] [--endYearsAgo 0]
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
import { atr, sma, stochastic, rvi, rsi } from '../src/indicators.js';
import { buildLevels } from '../src/structure.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'H4';
const YEARS = parseFloat(argOf('--years') || '2');
const END = parseFloat(argOf('--endYearsAgo') || '0');
const TOUCH = 0.25, THRESH = 1.0, WINDOW = 20, MIN_AWAY = 1.0;

const B = {};
const add = (k, v) => { (B[k] = B[k] || []).push(v); };

for (const sym of PAIRS) {
  try {
    const to = new Date(Date.now() - END * 365 * 24 * 3600e3);
    const from = new Date(to.getTime() - YEARS * 365 * 24 * 3600e3);
    const bars = ['D', 'W'].includes(TF)
      ? (await getCandles(sym, { granularity: TF, count: 5000 })).filter(b => b.time <= to.toISOString() && b.time >= from.toISOString())
      : await getCandlesRange(sym, { granularity: TF, from: from.toISOString(), to: to.toISOString() });
    if (bars.length < 200) continue;
    const closes = bars.map(b => b.close);
    const a = atr(bars, 14);
    const s = sma(closes, 50);
    const st = stochastic(bars, 14, 3, 3);
    const rv = rvi(bars, 10);
    const rs = rsi(closes, 14);
    const levels = buildLevels(bars, { binATR: 0.35, minBars: 3 });

    let lastTouch = -99;
    for (let i = 80; i < bars.length - WINDOW; i++) {
      if (a[i] == null || s[i] == null || st.k[i] == null) continue;
      const b = bars[i];
      if (!(b.low <= s[i] + a[i] * TOUCH && b.high >= s[i] - a[i] * TOUCH)) continue;
      if (i - lastTouch < 5) continue;
      // Must have been away from the SMA — otherwise price is riding it, not
      // pulling back to it.
      let away = false;
      for (let k = Math.max(0, i - 15); k < i - 2; k++) {
        if (s[k] != null && Math.abs(bars[k].close - s[k]) > a[k] * MIN_AWAY) { away = true; break; }
      }
      if (!away) continue;
      lastTouch = i;

      const fromAbove = bars[Math.max(0, i - 5)].close > s[i];
      const backPx = fromAbove ? s[i] + THRESH * a[i] : s[i] - THRESH * a[i];
      const thruPx = fromAbove ? s[i] - THRESH * a[i] : s[i] + THRESH * a[i];
      let out = null;
      for (let j = i; j < Math.min(bars.length, i + WINDOW); j++) {
        const c = bars[j];
        if (fromAbove ? c.close >= backPx : c.close <= backPx) { out = 1; break; }   // bounced
        if (fromAbove ? c.close <= thruPx : c.close >= thruPx) { out = 0; break; }   // broke
      }
      if (out === null) continue;

      // STATE vs TURN. The first version asked only whether stochastic was
      // extreme at the touch. What the user reads off the chart is stochastic
      // TURNING — K crossing back through D out of the zone. Those are
      // different events, and the distinction has already decided three other
      // disagreements here, so test both.
      const extreme = fromAbove ? st.k[i] < 30 : st.k[i] > 70;

      // A cross in the bounce direction, on this bar or within the last 3.
      let crossed = false;
      for (let q = i; q > i - 4 && q > 0; q--) {
        if (st.k[q] == null || st.d[q] == null || st.k[q - 1] == null || st.d[q - 1] == null) continue;
        const up = st.k[q - 1] <= st.d[q - 1] && st.k[q] > st.d[q];
        const dn = st.k[q - 1] >= st.d[q - 1] && st.k[q] < st.d[q];
        if (fromAbove ? up : dn) { crossed = true; break; }
      }
      // The full version: turning AND doing so from the extreme zone.
      const turnFromZone = crossed && (fromAbove ? st.k[i] < 40 : st.k[i] > 60);

      // RVI has the same line/signal structure as stochastic, so the same
      // turn-vs-state split applies. RSI has no signal line — test it as a
      // level (extreme) and as a slope (turning).
      let rviCross = false;
      for (let q = i; q > i - 4 && q > 0; q--) {
        if (rv.rvi[q] == null || rv.signal[q] == null || rv.rvi[q - 1] == null || rv.signal[q - 1] == null) continue;
        const up = rv.rvi[q - 1] <= rv.signal[q - 1] && rv.rvi[q] > rv.signal[q];
        const dn = rv.rvi[q - 1] >= rv.signal[q - 1] && rv.rvi[q] < rv.signal[q];
        if (fromAbove ? up : dn) { rviCross = true; break; }
      }
      const rsiExtreme = rs[i] != null && (fromAbove ? rs[i] < 40 : rs[i] > 60);
      const rsiTurning = rs[i] != null && rs[i - 2] != null &&
        (fromAbove ? rs[i] > rs[i - 1] && rs[i - 1] <= rs[i - 2] : rs[i] < rs[i - 1] && rs[i - 1] >= rs[i - 2]);

      add('A. 50 SMA touch alone', out);
      add(rviCross ? 'E. RVI crossed (turn)' : 'E. RVI no cross', out);
      add(rsiExtreme ? 'F. RSI extreme (state)' : 'F. RSI not extreme', out);
      add(rsiTurning ? 'G. RSI turning (slope)' : 'G. RSI not turning', out);
      add(extreme ? 'B. stoch EXTREME (state)' : 'B. stoch not extreme', out);
      add(crossed ? 'C. stoch CROSSED (turn)' : 'C. no cross', out);
      add(turnFromZone ? 'D. crossed FROM the zone' : 'D. not that', out);
    }
  } catch (e) { /* skip */ }
}

const pct = v => v.reduce((a, b) => a + b, 0) / v.length * 100;
const base = B['A. 50 SMA touch alone'] ? pct(B['A. 50 SMA touch alone']) : 0;
console.log(`\nCONFLUENCE — ${TF}, ${YEARS}y ending ${END}y ago   (bounce %, vs the SMA touch alone)\n`);
for (const k of Object.keys(B).sort()) {
  const v = B[k];
  if (v.length < 80) { console.log(`  ${k.padEnd(28)} n=${v.length} (too few)`); continue; }
  const wr = pct(v);
  console.log(`  ${k.padEnd(28)} n=${String(v.length).padStart(5)}   bounce ${wr.toFixed(1)}%   ${(wr - base >= 0 ? '+' : '') + (wr - base).toFixed(1)}`);
}
