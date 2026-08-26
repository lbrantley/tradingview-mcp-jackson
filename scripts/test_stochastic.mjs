#!/usr/bin/env node
/**
 * The user's three claims, for Stochastic (14,3,3) — the indicator they were
 * actually describing. MACD has no 0-100 scale, no 50 midpoint and no fixed
 * overbought zone, which is why the terms fit here and not there.
 *
 *  1. K crossing INTO overbought/oversold -> reversal. Tested with and without
 *     a level nearby (swing level or 50 SMA), since the claim is that the level
 *     is what makes it actionable.
 *  2. K crossing the 50 midpoint with K and D WIDE apart -> continuation.
 *  3. Multi-timeframe agreement (H4 + D + W pointing the same way) -> better.
 *
 * Outcome is symmetric: does price travel 1 ATR the predicted way before 1 ATR
 * against, within 20 bars. Baseline is the same test at arbitrary bars, so
 * every figure is a lift over what nothing-in-particular would have given.
 *
 * Usage: node scripts/test_stochastic.mjs [--tf H4] [--years 2] [--endYearsAgo 0]
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
import { atr, sma, stochastic } from '../src/indicators.js';
import { buildLevels } from '../src/structure.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'H4';
const YEARS = parseFloat(argOf('--years') || '2');
const END = parseFloat(argOf('--endYearsAgo') || '0');
const FWD = 20;

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
    const st = stochastic(bars, 14, 3, 3);
    const s50 = sma(closes, 50);
    const levels = buildLevels(bars, { binATR: 0.35, minBars: 3 });

    // Higher-timeframe stochastic, aligned by timestamp, for claim 3.
    const dBars = await getCandles(sym, { granularity: TF === 'H4' ? 'D' : 'W', count: 800 });
    const dSt = stochastic(dBars, 14, 3, 3);
    const alignD = t => { let lo = 0, hi = dBars.length - 1, best = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (dBars[m].time <= t) { best = m; lo = m + 1; } else hi = m - 1; } return best; };

    const outcome = (i, dir) => {
      const L = dir === 'long';
      const tgt = L ? closes[i] + a[i] : closes[i] - a[i];
      const stp = L ? closes[i] - a[i] : closes[i] + a[i];
      for (let j = i + 1; j < Math.min(bars.length, i + 1 + FWD); j++) {
        const b = bars[j];
        if (L ? b.low <= stp : b.high >= stp) return 0;
        if (L ? b.high >= tgt : b.low <= tgt) return 1;
      }
      return null;
    };

    for (let i = 120; i < bars.length - FWD; i++) {
      const k = st.k[i], kp = st.k[i - 1], d = st.d[i];
      if (k == null || kp == null || d == null || !a[i] || s50[i] == null) continue;

      const nearLevel = levels.some(z => z.confirmedAt <= i && Math.abs(closes[i] - z.price) <= a[i] * 0.5)
        || Math.abs(closes[i] - s50[i]) <= a[i] * 0.5;

      // 1. CROSSING INTO overbought/oversold — the transition, not the state.
      const intoOS = kp >= 20 && k < 20;
      const intoOB = kp <= 80 && k > 80;
      if (intoOS || intoOB) {
        const o = outcome(i, intoOS ? 'long' : 'short');
        if (o !== null) add(nearLevel ? '1. into OB/OS + at level' : '1. into OB/OS, no level', o);
      }

      // 2. CROSSING 50 with K and D wide apart.
      const up50 = kp <= 50 && k > 50, dn50 = kp >= 50 && k < 50;
      if (up50 || dn50) {
        const sep = Math.abs(k - d);
        const o = outcome(i, up50 ? 'long' : 'short');
        if (o !== null) add(sep >= 10 ? '2. cross 50, wide (>=10)' : '2. cross 50, narrow', o);
      }

      // 3. HIGHER TIMEFRAME AGREEMENT on an into-OB/OS signal.
      if (intoOS || intoOB) {
        const j = alignD(bars[i].time);
        const hk = j >= 0 ? dSt.k[j] : null;
        if (hk != null) {
          const agrees = intoOS ? hk < 50 : hk > 50;
          const o = outcome(i, intoOS ? 'long' : 'short');
          if (o !== null) add(agrees ? '3. HTF agrees' : '3. HTF disagrees', o);
        }
      }

      if (i % 7 === 0) for (const dir of ['long', 'short']) { const o = outcome(i, dir); if (o !== null) add('baseline', o); }
    }
  } catch (e) { /* skip */ }
}

const pct = v => v.reduce((a, b) => a + b, 0) / v.length * 100;
const base = B.baseline ? pct(B.baseline) : 50;
console.log(`\nSTOCHASTIC (14,3,3) — ${TF}, ${YEARS}y ending ${END}y ago   baseline ${base.toFixed(1)}%\n`);
for (const k of Object.keys(B).sort()) {
  const v = B[k];
  if (v.length < 100) { console.log(`  ${k.padEnd(28)} n=${v.length} (too few)`); continue; }
  const wr = pct(v);
  console.log(`  ${k.padEnd(28)} n=${String(v.length).padStart(6)}   ${wr.toFixed(1)}%   ${(wr - base >= 0 ? '+' : '') + (wr - base).toFixed(1)}`);
}
