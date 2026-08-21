#!/usr/bin/env node
/**
 * Campaign backtest — models how the user actually trades, not one-shot trades.
 *
 * Their description, turned into a state machine:
 *   - small starter at the level, accepting it may be stopped
 *   - one retry if stopped (the failure may just have extended the zone); if
 *     that fails too it is a new trend, so stand aside
 *   - add on each completed pullback that does NOT produce an opposing CHoCH
 *   - after each add, stop moves up behind that pullback to secure profit
 *   - exit everything immediately on an opposing CHoCH, not just on the stop
 *
 * Why this matters more than the entry signal: at a 42.1% level-hold rate,
 * -1R losses make the game unwinnable. Starter-sized losses with adds only
 * after confirmation change the payoff shape entirely. Every previous backtest
 * measured this strategy with the risk management removed.
 *
 * UNITS. R = the risk on the STARTER at its initial stop. A stopped starter is
 * -1R. A campaign that scales can return far more than its rr, because size
 * grows after the trade is already right. Peak size is reported alongside, so
 * a good expectancy bought with huge exposure is visible rather than hidden.
 *
 * Usage: node scripts/backtest_campaign.mjs [--pairs A,B] [--years 2] [--opts '{...}']
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
const STRAT = (process.argv.includes('--strategy') ? process.argv[process.argv.indexOf('--strategy')+1] : 'macro_reversal_level');
const strat = await import(`../src/strategies/${STRAT}.js`);
import { structureEvents } from '../src/structure.js';
import { swings, atr } from '../src/indicators.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const YEARS = parseFloat(argOf('--years') || '2');
const SOPTS = JSON.parse(argOf('--opts') || '{}');
const COPTS = JSON.parse(argOf('--campaign') || '{}');
const ENTRY_TF = argOf('--entry') || 'H1';
const END_AGO = parseFloat(argOf('--endYearsAgo') || '0');

const CFG = {
  addSize: 1.0,        // each add, as a multiple of the starter
  maxAdds: 4,          // "until I couldn't" — capped so exposure stays visible
  retries: 1,          // one retry after a stopped starter
  maxHold: 480,        // H1 bars
  trailBufferATR: 0.3,
  ...COPTS,
};

const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;

/**
 * Run one campaign from a signal. Returns total P&L in starter-R units.
 *
 * `legs` holds each fill as {price, size}; P&L is summed over legs so adds are
 * priced where they actually happened, not at the original entry.
 */
function campaign(bars, sig, spread, events, sw, a, startIdx = sig.index, entryPx = sig.entry) {
  const L = sig.dir === 'long';
  const unitRisk = sig.risk;                       // 1R, in price
  const legs = [{ price: entryPx, size: 1 }];
  let stop = sig.stop;
  let adds = 0, peakSize = 1;
  let lastAddIdx = startIdx;

  const pnlAt = px => legs.reduce((acc, leg) =>
    acc + (L ? px - leg.price : leg.price - px) * leg.size, 0) / unitRisk;
  const costOf = size => (spread * size) / unitRisk;
  let cost = costOf(1);

  const end = Math.min(bars.length, startIdx + CFG.maxHold);
  for (let i = startIdx; i < end; i++) {
    const b = bars[i];

    // Opposing CHoCH ends the campaign at market, ahead of any stop logic —
    // the user exits on character change, not only on price.
    const opp = events.find(e => e.type === 'CHoCH' && e.confirmedAt === i &&
      (L ? e.dir === 'bear' : e.dir === 'bull'));
    if (opp) return { r: pnlAt(b.close) - cost, exit: 'choch', adds, peakSize };

    if (L ? b.low <= stop : b.high >= stop) {
      return { r: pnlAt(stop) - cost, exit: adds ? 'trailed' : 'stopped', adds, peakSize, at: i };
    }

    // A completed pullback: a confirmed swing against the trade that did NOT
    // flip structure. That is the add trigger and the new stop location.
    if (adds < CFG.maxAdds && i > lastAddIdx + 3) {
      const pivots = L ? sw.lows : sw.highs;
      const p = pivots.filter(k => k + 5 <= i && k > lastAddIdx).pop();
      if (p != null) {
        const pivotPx = L ? bars[p].low : bars[p].high;
        const inProfit = L ? pivotPx > entryPx : pivotPx < entryPx;
        if (inProfit) {
          const px = bars[Math.min(i + 1, bars.length - 1)].open;
          legs.push({ price: px, size: CFG.addSize });
          cost += costOf(CFG.addSize);
          adds++; peakSize += CFG.addSize;
          lastAddIdx = i;
          const buf = (a[i] || unitRisk) * CFG.trailBufferATR;
          stop = L ? pivotPx - buf : pivotPx + buf;   // secure the profit behind it
        }
      }
    }
  }
  return { r: pnlAt(bars[end - 1].close) - cost, exit: 'timeout', adds, peakSize, at: end - 1 };
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
  const to = new Date(Date.now() - END_AGO * 365 * 24 * 3600e3);
  const from = new Date(to.getTime() - YEARS * 365 * 24 * 3600e3);
  console.log(`Campaign backtest — ${strat.meta.name}`);
  console.log(`${PAIRS.length} pairs, ${YEARS}y ending ${END_AGO}y ago, entries ${ENTRY_TF}`);
  console.log(`starter=1R, add=${CFG.addSize}R x${CFG.maxAdds}, retries=${CFG.retries}, trail behind pullbacks`);
  console.log(`R = risk on the STARTER at its initial stop\n`);

  const all = [], perPair = [], exits = {}, peaks = [];
  for (const sym of PAIRS) {
    try {
      const [h1, h4, d, w, bid, ask] = await Promise.all([
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
      if (h1.length < 400) continue;
      const sp = bid.map((b, i) => ask[i] ? ask[i].close - b.close : null).filter(v => v && v > 0).sort((x, y) => x - y);
      const spread = sp[Math.floor(sp.length / 2)] || 0;

      const sigs = strat.generate(h1, { H4: h4, D: d, W: w }, SOPTS, { spread });
      if (!sigs.length) continue;
      const events = structureEvents(h1, { lookback: 5 });
      const sw = swings(h1, 5);
      const a = atr(h1, 14);

      const rs = [];
      for (const s of sigs) {
        let total = 0, idx = s.index, px = s.entry;
        for (let attempt = 0; attempt <= CFG.retries; attempt++) {
          const res = campaign(h1, s, spread, events, sw, a, idx, px);
          total += res.r;
          exits[res.exit] = (exits[res.exit] || 0) + 1;
          peaks.push(res.peakSize);
          // Retry only a clean starter stop-out — a trailed exit banked profit,
          // and a CHoCH means the idea is dead. The retry must RE-ENTER after
          // the stop, at the next bar's open; replaying the same bar just
          // duplicates the identical loss, which is what produced avgL -1.59R.
          if (res.exit === 'stopped' && attempt < CFG.retries && res.at + 1 < h1.length - 2) {
            idx = res.at + 1; px = h1[idx].open;
          } else break;
        }
        rs.push(total);
      }
      const st = stats(rs);
      if (st) { perPair.push({ sym, ...st }); all.push(...rs); }
    } catch (e) { console.log(`  ${sym.padEnd(7)} ${e.message.slice(0, 55)}`); }
  }

  perPair.sort((a, b) => b.exp - a.exp);
  console.log('pair      camps   win%    avgW    avgL     EXP       totalR   maxDD');
  for (const p of perPair) {
    console.log(`  ${p.sym.padEnd(7)} ${String(p.n).padStart(5)}  ${p.winRate.toFixed(1).padStart(5)}` +
      `  ${p.avgW.toFixed(2).padStart(6)}  ${p.avgL.toFixed(2).padStart(6)}` +
      `  ${(p.exp >= 0 ? '+' : '') + p.exp.toFixed(3)}R  ${((p.totalR >= 0 ? '+' : '') + p.totalR.toFixed(1)).padStart(7)}  ${p.maxDD.toFixed(1).padStart(6)}`);
  }
  const agg = stats(all);
  if (!agg) { console.log('\nno campaigns'); return; }
  console.log(`\nALL PAIRS  campaigns=${agg.n}  win%=${agg.winRate.toFixed(1)}  avgW=+${agg.avgW.toFixed(2)}R  avgL=${agg.avgL.toFixed(2)}R`);
  console.log(`  EXPECTANCY ${(agg.exp >= 0 ? '+' : '') + agg.exp.toFixed(3)}R   totalR ${(agg.totalR >= 0 ? '+' : '') + agg.totalR.toFixed(1)}   maxDD ${agg.maxDD.toFixed(1)}R`);
  console.log(`  ${perPair.filter(p => p.exp > 0).length}/${perPair.length} pairs positive`);
  console.log(`  exits: ${JSON.stringify(exits)}`);
  console.log(`  peak size: mean ${(peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(2)}x starter, max ${Math.max(...peaks)}x`);
}
main().catch(e => { console.error(e); process.exit(1); });
