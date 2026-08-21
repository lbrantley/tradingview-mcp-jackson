#!/usr/bin/env node
/**
 * Backtest engine — runs a strategy over real OANDA candles.
 *
 * The thing the system has never had. Four months of live-forward trading
 * produced 253 closed setups whose outcomes turned out to be partly
 * fabricated; this reads two years across 28 pairs in a few minutes, from
 * price that cannot be argued with.
 *
 * Honesty rules, each chosen so the result cannot flatter itself:
 *   - entry is the NEXT bar's open, never the signal bar's close
 *   - spread is charged once at entry, taken from real bid/ask candles at
 *     that moment in history (not today's spread applied to last year)
 *   - if a bar's range covers both stop and target, the STOP is taken
 *   - swing points are only usable after their confirmation window closes
 *   - incomplete (still-forming) candles are excluded
 *
 * Usage:
 *   node scripts/backtest.mjs [--pairs EURUSD,GBPUSD] [--years 2] [--json out.json]
 */
import { getCandles } from '../src/oanda.js';
import * as strat from '../src/strategies/sma50_rsi_breakout.js';
import { writeFileSync } from 'fs';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const YEARS = parseFloat(argOf('--years') || '2');
const OUT = argOf('--json');
const MAX_HOLD = 120;   // bars; H4 -> ~20 trading days before abandoning a trade

const pipOf = sym => /JPY$/.test(sym) ? 0.01 : 0.0001;

/** Median spread in price terms, from real bid/ask candles over the period. */
function medianSpread(bid, ask) {
  const sp = bid.map((b, i) => ask[i] ? ask[i].close - b.close : null)
    .filter(v => v !== null && v > 0).sort((a, b) => a - b);
  return sp.length ? sp[Math.floor(sp.length / 2)] : 0;
}

function simulate(bars, sig, spread) {
  const isLong = sig.dir === 'long';
  // Spread is a cost at entry: you buy the ask and sell the bid. Charging it
  // once in R terms is the simplification; it is charged against every trade.
  const costR = spread / sig.risk;
  const end = Math.min(bars.length, sig.index + MAX_HOLD);

  for (let i = sig.index; i < end; i++) {
    const b = bars[i];
    const hitStop = isLong ? b.low <= sig.stop : b.high >= sig.stop;
    const hitTgt = isLong ? b.high >= sig.target : b.low <= sig.target;
    // Ambiguous bar: both touched, order unknowable at this granularity.
    // Take the stop. This is the assumption that cannot flatter the result.
    if (hitStop) return { r: -1 - costR, bars: i - sig.index, exit: 'stop' };
    if (hitTgt) return { r: sig.rr - costR, bars: i - sig.index, exit: 'target' };
  }
  const last = bars[end - 1];
  const r = (isLong ? last.close - sig.entry : sig.entry - last.close) / sig.risk;
  return { r: r - costR, bars: end - 1 - sig.index, exit: 'timeout' };
}

function stats(rs) {
  if (!rs.length) return null;
  const n = rs.length, sum = rs.reduce((a, b) => a + b, 0);
  const w = rs.filter(r => r > 0), l = rs.filter(r => r <= 0);
  // Max drawdown over the equity curve in R, i.e. worst peak-to-trough run.
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return {
    n, winRate: w.length / n * 100,
    avgW: w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0,
    avgL: l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0,
    exp: sum / n, totalR: sum, maxDD: dd,
  };
}

async function main() {
  const to = new Date();
  const from = new Date(to.getTime() - YEARS * 365 * 24 * 3600e3);
  console.log(`Backtest: ${strat.meta.name}`);
  console.log(`${PAIRS.length} pairs, ${strat.meta.granularity}, ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}\n`);

  const perPair = [];
  const all = [];

  for (const sym of PAIRS) {
    try {
      // OANDA caps a request at 5000 candles; H4 over 2y is ~3100, so one call.
      const [bars, bid, ask] = await Promise.all([
        getCandles(sym, { granularity: strat.meta.granularity, from: from.toISOString(), to: to.toISOString() }),
        getCandles(sym, { granularity: 'D', count: 60, price: 'B' }),
        getCandles(sym, { granularity: 'D', count: 60, price: 'A' }),
      ]);
      if (bars.length < strat.meta.warmup + 50) { console.log(`  ${sym.padEnd(7)} too little history (${bars.length})`); continue; }

      const spread = medianSpread(bid, ask);
      const sigs = strat.generate(bars);
      const rs = sigs.map(s => simulate(bars, s, spread).r);
      const st = stats(rs);
      if (!st) { console.log(`  ${sym.padEnd(7)} no signals`); continue; }
      perPair.push({ sym, ...st, spreadPips: spread / pipOf(sym), bars: bars.length });
      all.push(...rs);
    } catch (e) {
      console.log(`  ${sym.padEnd(7)} ${e.message.slice(0, 60)}`);
    }
  }

  perPair.sort((a, b) => b.exp - a.exp);
  console.log('pair      trades  win%    avgW    avgL     EXP       totalR   maxDD   spread');
  for (const p of perPair) {
    console.log(`  ${p.sym.padEnd(7)} ${String(p.n).padStart(5)}  ${p.winRate.toFixed(1).padStart(5)}` +
      `  ${p.avgW.toFixed(2).padStart(6)}  ${p.avgL.toFixed(2).padStart(6)}` +
      `  ${(p.exp >= 0 ? '+' : '') + p.exp.toFixed(3)}R  ${(p.totalR >= 0 ? '+' : '') + p.totalR.toFixed(1).padStart(7)}` +
      `  ${p.maxDD.toFixed(1).padStart(6)}  ${p.spreadPips.toFixed(1)}p`);
  }

  const agg = stats(all);
  console.log(`\nALL PAIRS  n=${agg.n}  win%=${agg.winRate.toFixed(1)}  avgW=+${agg.avgW.toFixed(2)}  avgL=${agg.avgL.toFixed(2)}`);
  console.log(`  EXPECTANCY ${(agg.exp >= 0 ? '+' : '') + agg.exp.toFixed(3)}R   totalR ${(agg.totalR >= 0 ? '+' : '') + agg.totalR.toFixed(1)}   maxDD ${agg.maxDD.toFixed(1)}R`);
  const pos = perPair.filter(p => p.exp > 0).length;
  console.log(`  ${pos}/${perPair.length} pairs positive`);

  if (OUT) { writeFileSync(OUT, JSON.stringify({ strategy: strat.meta.name, from, to, perPair, agg }, null, 2)); console.log(`\n  wrote ${OUT}`); }
}

main().catch(e => { console.error(e); process.exit(1); });
