#!/usr/bin/env node
/**
 * Three MACD claims, tested separately.
 *
 * Uses METATRADER'S MACD, which differs from the common implementation: the
 * signal line is a 9-period SMA of the MACD line, not an EMA. The user's dialog
 * says "MACD SMA: 9". Reading a different indicator than they see would make
 * any result meaningless.
 *
 * MACD is unbounded — it has no fixed overbought/oversold levels — so "extreme"
 * is defined relative to its own recent distribution, and "midpoint" is zero.
 *
 *  1. EXTREME + AT A LEVEL -> reversal
 *  2. ZERO CROSS WITH WIDE SEPARATION -> continuation
 *  3. MULTI-TIMEFRAME AGREEMENT -> better outcomes
 *
 * Usage: node scripts/test_macd.mjs [--tf H4] [--years 2] [--endYearsAgo 0]
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
import { atr, sma, ema } from '../src/indicators.js';
import { buildLevels } from '../src/structure.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'H4';
const YEARS = parseFloat(argOf('--years') || '2');
const END = parseFloat(argOf('--endYearsAgo') || '0');
const FWD = 20;

/** MetaTrader MACD: signal is an SMA of the MACD line. */
function mt4Macd(closes, fast = 12, slow = 26, sig = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] == null || s[i] == null) ? null : f[i] - s[i]);
  const start = line.findIndex(v => v != null);
  const sigRaw = start < 0 ? [] : sma(line.slice(start), sig);
  const signal = new Array(closes.length).fill(null);
  for (let i = 0; i < sigRaw.length; i++) signal[start + i] = sigRaw[i];
  return { line, signal };
}

const buckets = {
  'extreme + at level': [], 'extreme, no level': [],
  'zero cross, wide': [], 'zero cross, narrow': [],
  baseline: [],
};

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
    const m = mt4Macd(closes);
    const s50 = sma(closes, 50);
    const levels = buildLevels(bars, { binATR: 0.35, minBars: 3 });

    // Forward outcome: does price travel 1 ATR one way before the other?
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
      if (m.line[i] == null || m.signal[i] == null || !a[i] || s50[i] == null) continue;
      const hist = m.line.slice(i - 100, i).filter(v => v != null).sort((x, y) => x - y);
      if (hist.length < 60) continue;
      const hi = hist[Math.floor(hist.length * 0.9)], lo = hist[Math.floor(hist.length * 0.1)];

      // 1. MACD extreme -> reversal, with and without a level nearby.
      const overbought = m.line[i] >= hi, oversold = m.line[i] <= lo;
      if (overbought || oversold) {
        const dir = overbought ? 'short' : 'long';
        const o = outcome(i, dir);
        if (o !== null) {
          const nearLevel = levels.some(z => z.confirmedAt <= i && Math.abs(closes[i] - z.price) <= a[i] * 0.5)
            || Math.abs(closes[i] - s50[i]) <= a[i] * 0.5;
          buckets[nearLevel ? 'extreme + at level' : 'extreme, no level'].push(o);
        }
      }

      // 2. Zero cross with the two lines wide apart -> continuation.
      const crossedUp = m.line[i] > 0 && m.line[i - 1] <= 0;
      const crossedDn = m.line[i] < 0 && m.line[i - 1] >= 0;
      if (crossedUp || crossedDn) {
        const sep = Math.abs(m.line[i] - m.signal[i]);
        const seps = m.line.map((v, k) => (v == null || m.signal[k] == null) ? null : Math.abs(v - m.signal[k]))
          .slice(Math.max(0, i - 100), i).filter(v => v != null).sort((x, y) => x - y);
        if (seps.length > 40) {
          const wide = sep >= seps[Math.floor(seps.length * 0.7)];
          const o = outcome(i, crossedUp ? 'long' : 'short');
          if (o !== null) buckets[wide ? 'zero cross, wide' : 'zero cross, narrow'].push(o);
        }
      }

      // Baseline: the same forward test taken at random, long and short.
      if (i % 7 === 0) {
        for (const d of ['long', 'short']) { const o = outcome(i, d); if (o !== null) buckets.baseline.push(o); }
      }
    }
  } catch (e) { /* skip */ }
}

console.log(`\nMT4 MACD (12,26,9 SMA-signal) — ${TF}, ${YEARS}y ending ${END}y ago`);
console.log(`outcome = price travels 1 ATR in the predicted direction before 1 ATR against, within ${FWD} bars\n`);
const base = buckets.baseline.length ? buckets.baseline.reduce((a, b) => a + b, 0) / buckets.baseline.length * 100 : 50;
for (const [k, v] of Object.entries(buckets)) {
  if (v.length < 100) { console.log(`  ${k.padEnd(22)} n=${v.length} (too few)`); continue; }
  const wr = v.reduce((a, b) => a + b, 0) / v.length * 100;
  const lift = wr - base;
  console.log(`  ${k.padEnd(22)} n=${String(v.length).padStart(6)}   ${wr.toFixed(1)}%   ${(lift >= 0 ? '+' : '') + lift.toFixed(1)} vs baseline`);
}
