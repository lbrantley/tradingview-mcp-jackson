#!/usr/bin/env node
/**
 * Backtest the macro-reversal-at-level strategy.
 *
 * Separate runner from backtest.mjs because this strategy is multi-timeframe:
 * levels come from H4/D/W, entries from H1. Same honesty rules — entry at the
 * next bar's open, spread charged at entry from real bid/ask, stop taken on any
 * bar whose range covers both stop and target.
 *
 * Usage: node scripts/backtest_reversal.mjs [--pairs A,B] [--years 2] [--opts '{"minTouches":3}']
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
const STRAT = (process.argv.includes('--strategy') ? process.argv[process.argv.indexOf('--strategy')+1] : 'macro_reversal_level');
const strat = await import(`../src/strategies/${STRAT}.js`);

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const YEARS = parseFloat(argOf('--years') || '2');
const OPTS = JSON.parse(argOf('--opts') || '{}');
// The one variable under test: where the CHoCH confirmation is read.
const ENTRY_TF = argOf('--entry') || 'H1';
// Shift the window back to test a period the parameters were never seen on.
const END_YEARS_AGO = parseFloat(argOf('--endYearsAgo') || '0');
let MAX_HOLD = 480;     // entry bars; rescaled below so hold time is constant

const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;

function simulate(bars, sig, spread) {
  const L = sig.dir === 'long';
  const costR = spread / sig.risk;
  const end = Math.min(bars.length, sig.index + MAX_HOLD);
  for (let i = sig.index; i < end; i++) {
    const b = bars[i];
    if (L ? b.low <= sig.stop : b.high >= sig.stop) return { r: -1 - costR, exit: 'stop' };
    if (L ? b.high >= sig.target : b.low <= sig.target) return { r: sig.rr - costR, exit: 'target' };
  }
  const last = bars[end - 1];
  return { r: (L ? last.close - sig.entry : sig.entry - last.close) / sig.risk - costR, exit: 'timeout' };
}

function stats(rs) {
  if (!rs.length) return null;
  const n = rs.length, sum = rs.reduce((a, b) => a + b, 0);
  const w = rs.filter(r => r > 0), l = rs.filter(r => r <= 0);
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return { n, winRate: w.length / n * 100,
    avgW: w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0,
    avgL: l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0,
    exp: sum / n, totalR: sum, maxDD: dd };
}

async function main() {
  const to = new Date(Date.now() - END_YEARS_AGO * 365 * 24 * 3600e3);
  const from = new Date(to.getTime() - YEARS * 365 * 24 * 3600e3);
  console.log(`Backtest: ${strat.meta.name}   entries ${ENTRY_TF}, levels ${strat.meta.levelTFs.join('/')}`);
  console.log(`${PAIRS.length} pairs, ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  if (Object.keys(OPTS).length) console.log(`opts ${JSON.stringify(OPTS)}`);
  console.log('');

  MAX_HOLD = 480 * ({ M15: 4, M30: 2, H1: 1 }[ENTRY_TF] || 1);
  const perPair = [], all = [], rrs = [], resolved = [], exits = {};
  for (const sym of PAIRS) {
    try {
      const [h1, h4, d, w, bid, ask] = await Promise.all([
        // D/W fit inside one 5000-bar request, but a count-based fetch ignores
        // from/to entirely — which silently returned the SAME most-recent bars
        // for every --endYearsAgo, making in-sample and out-of-sample identical.
        // Fetch by count, then window by date explicitly.
        (['D', 'W'].includes(ENTRY_TF)
          ? getCandles(sym, { granularity: ENTRY_TF, count: 5000 })
            .then(bs => bs.filter(b => b.time >= from.toISOString() && b.time <= to.toISOString()))
          : getCandlesRange(sym, { granularity: ENTRY_TF, from: from.toISOString(), to: to.toISOString() })),
        getCandlesRange(sym, { granularity: 'H4', from: from.toISOString(), to: to.toISOString() }),
        getCandles(sym, { granularity: 'D', count: 800 }),
        getCandles(sym, { granularity: 'W', count: 250 }),
        getCandles(sym, { granularity: 'D', count: 60, price: 'B' }),
        getCandles(sym, { granularity: 'D', count: 60, price: 'A' }),
      ]);
      if (h1.length < strat.meta.warmup + 100) { console.log(`  ${sym.padEnd(7)} thin history`); continue; }
      const sp = bid.map((b, i) => ask[i] ? ask[i].close - b.close : null).filter(v => v && v > 0).sort((a, b) => a - b);
      const spread = sp[Math.floor(sp.length / 2)] || 0;

      const perH1 = { M15: 4, M30: 2, H1: 1 }[ENTRY_TF] || 1;
      // chochWithin and maxHold are counted in ENTRY bars. Without scaling, a
      // 12-bar window means 12h on H1 but only 3h on M15 — the comparison
      // would silently change two things at once.
      const scaled = { chochWithin: 12 * perH1, ...OPTS };
      const sigs = strat.generate(h1, { H4: h4, D: d, W: w }, scaled, { spread });
      if (!sigs.length) { console.log(`  ${sym.padEnd(7)} no signals`); continue; }
      rrs.push(...sigs.map(s => s.rr));
      const res = sigs.map((s, k) => ({ ...simulate(h1, s, spread), rr: sigs[k].rr }));
      resolved.push(...res.filter(x => x.exit !== 'timeout'));
      exits.timeout = (exits.timeout || 0) + res.filter(x => x.exit === 'timeout').length;
      const rs = res.map(x => x.r);
      const st = stats(rs);
      perPair.push({ sym, ...st, spreadPips: spread / pipOf(sym) });
      all.push(...rs);
    } catch (e) { console.log(`  ${sym.padEnd(7)} ${e.message.slice(0, 60)}`); }
  }

  perPair.sort((a, b) => b.exp - a.exp);
  console.log('pair      trades  win%    avgW    avgL     EXP       totalR   maxDD');
  for (const p of perPair) {
    console.log(`  ${p.sym.padEnd(7)} ${String(p.n).padStart(5)}  ${p.winRate.toFixed(1).padStart(5)}` +
      `  ${p.avgW.toFixed(2).padStart(6)}  ${p.avgL.toFixed(2).padStart(6)}` +
      `  ${(p.exp >= 0 ? '+' : '') + p.exp.toFixed(3)}R  ${((p.totalR >= 0 ? '+' : '') + p.totalR.toFixed(1)).padStart(7)}  ${p.maxDD.toFixed(1).padStart(6)}`);
  }
  const agg = stats(all);
  if (!agg) { console.log('\nno trades'); return; }
  const meanRR = rrs.reduce((a, b) => a + b, 0) / rrs.length;
  console.log(`\nALL PAIRS  n=${agg.n}  win%=${agg.winRate.toFixed(1)}  avgW=+${agg.avgW.toFixed(2)}  avgL=${agg.avgL.toFixed(2)}  meanRR=${meanRR.toFixed(2)}`);
  console.log(`  EXPECTANCY ${(agg.exp >= 0 ? '+' : '') + agg.exp.toFixed(3)}R   totalR ${(agg.totalR >= 0 ? '+' : '') + agg.totalR.toFixed(1)}   maxDD ${agg.maxDD.toFixed(1)}R`);
  console.log(`  ${perPair.filter(p => p.exp > 0).length}/${perPair.length} pairs positive`);
  // Same null test as the breakout: for a driftless walk P(win) = 1/(1+rr).
  const rrRes = resolved.map(x => x.rr);
  const expWins = rrRes.reduce((a, r) => a + 1 / (1 + r), 0);
  const sd = Math.sqrt(rrRes.reduce((a, r) => { const p = 1 / (1 + r); return a + p * (1 - p); }, 0));
  const actualWins = resolved.filter(x => x.exit === 'target').length;
  console.log(`  resolved ${resolved.length} of ${all.length} (timeouts ${exits.timeout || 0} excluded from the null)`);
  console.log(`  vs random walk: ${actualWins} wins vs ${expWins.toFixed(0)} expected  = ${((actualWins - expWins) / sd).toFixed(2)} sd`);
}
main().catch(e => { console.error(e); process.exit(1); });
