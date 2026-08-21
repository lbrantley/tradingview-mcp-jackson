#!/usr/bin/env node
/**
 * Live scanner for the validated setups. Read-only: reads OANDA, prints, and
 * optionally sends Pushover. It cannot place an order.
 *
 * Setups, from three non-overlapping backtest windows (28 pairs, H4):
 *
 *   BIG BREAK  level with 8+ ATR clear space beyond, 1st/2nd test, fast
 *              approach (>=1.5 ATR/5 bars), bar closes THROUGH.
 *              stop 2 ATR, target 4 ATR.
 *              +0.508R / +0.439R / +0.159R   5.07 / 4.37 / 2.20 sd
 *
 *   1 ATR      the fallback when no big setup is available.
 *              +0.059R / +0.169R             3.00 / 5.36 sd
 *
 * Also reports NEAR MISSES. The framework failed to fire on the NZDJPY move of
 * 2026-06-26 (439 pips in 25 days) because approach speed was 0.76 against a
 * 0.5 threshold and the bar closed inside the zone rather than back out — two
 * near misses on a trade that was obvious by eye. Silently dropping those hides
 * exactly the cases where the thresholds are wrong, so they are surfaced with
 * the reason.
 *
 * Usage: node scripts/scan_live.mjs [--pairs A,B] [--notify]
 */
import { getCandles, getCandlesRange, getPricing, getSummary, ACCOUNT_ID } from '../src/oanda.js';
import { atr } from '../src/indicators.js';
import { buildZones } from '../src/structure.js';
import https from 'https';
import 'dotenv/config';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const NOTIFY = args.includes('--notify');
const RISK_PCT = parseFloat(argOf('--risk') || '1.0');

const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;

function pushover(title, message) {
  if (!process.env.PUSHOVER_TOKEN || process.env.PUSHOVER_ENABLED !== '1') return;
  const body = new URLSearchParams({
    token: process.env.PUSHOVER_TOKEN, user: process.env.PUSHOVER_USER,
    title, message, priority: '1',
  }).toString();
  const req = https.request({ hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } });
  req.on('error', () => {});
  req.write(body); req.end();
}

const nav = await getSummary().then(a => parseFloat(a.NAV)).catch(() => null);
const hits = [], nearMisses = [];

for (const sym of PAIRS) {
  try {
    const bars = await getCandles(sym, { granularity: 'H4', count: 1500 });
    if (bars.length < 300) continue;
    const a = atr(bars, 14);
    const i = bars.length - 1;
    const av = a[i];
    if (!av) continue;
    const b = bars[i];
    const pip = pipOf(sym);
    const zones = buildZones(bars, { lookback: 5, tolATR: 0.5, minTouches: 2 })
      .filter(z => z.confirmedAt <= i);

    // Only zones price is actually engaging with on this bar.
    const touched = zones.filter(z => b.low <= z.high && b.high >= z.low);
    for (const z of touched) {
      // Returns since the zone confirmed — distinct from the swings that formed
      // it. Both get reported; conflating them was a real source of confusion.
      let returns = 0, last = z.confirmedAt;
      for (let k = z.confirmedAt + 1; k <= i; k++) {
        const c = bars[k];
        if (c.low <= z.high && c.high >= z.low) { if (k - last >= 3) returns++; last = k; }
      }
      const ref = bars[i - 5].close;
      const fromAbove = ref > z.price;
      const speed = Math.abs(b.close - ref) / av;
      const closedThrough = fromAbove ? b.close < z.low : b.close > z.high;
      const closedBackOut = fromAbove ? b.close > z.high : b.close < z.low;

      const beyond = zones.filter(w => Math.abs(w.price - z.price) > av * 0.5)
        .filter(w => fromAbove ? w.price < z.price : w.price > z.price)
        .sort((x, y) => Math.abs(x.price - z.price) - Math.abs(y.price - z.price))[0];
      const room = beyond ? Math.abs(beyond.price - z.price) / av : 99;

      const dir = fromAbove ? 'SHORT' : 'LONG';
      const checks = {
        'fresh level (<=2 tests)': returns <= 1,
        'clear space (8+ ATR)': room >= 8,
        'fast approach (>=1.5)': speed >= 1.5,
        'closed through': closedThrough,
      };
      const passed = Object.values(checks).filter(Boolean).length;
      if (passed < 3) continue;

      const px = b.close;
      const stop = dir === 'LONG' ? px - 2 * av : px + 2 * av;
      const target = dir === 'LONG' ? px + 4 * av : px - 4 * av;
      const riskPips = 2 * av / pip;
      const units = nav ? Math.floor((nav * RISK_PCT / 100) / (2 * av) * (/JPY$/.test(sym) ? 1 / 150 : 1)) : null;

      const rec = {
        sym, dir, px, stop, target, riskPips, units,
        zone: z.price, formedBy: z.touches, returns, speed, room, checks, passed,
        failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k),
      };
      (passed === 4 ? hits : nearMisses).push(rec);
    }
  } catch (e) { /* pair unavailable — skip */ }
}

const fmt = (s, v) => v.toFixed(/JPY$/.test(s) ? 3 : 5);
function show(r, label) {
  console.log(`\n${label}  ${r.sym}  ${r.dir}  — ${r.dir === 'LONG' ? 'break up through' : 'break down through'} ${fmt(r.sym, r.zone)}`);
  console.log(`  level      ${fmt(r.sym, r.zone)}   formed by ${r.formedBy} swings, tested ${r.returns} time(s) since`);
  console.log(`  entry      ${fmt(r.sym, r.px)}    stop ${fmt(r.sym, r.stop)} (${r.riskPips.toFixed(0)}p)   target ${fmt(r.sym, r.target)} (2.0R)`);
  if (r.units) console.log(`  size       ${r.units.toLocaleString()} units  = $${(nav * RISK_PCT / 100).toFixed(2)} risk (${RISK_PCT}% of $${nav.toFixed(2)})`);
  console.log(`  approach   ${r.speed.toFixed(2)} ATR / 5 bars      room beyond ${r.room >= 99 ? 'clear' : r.room.toFixed(1) + ' ATR'}`);
  if (r.failed.length) console.log(`  ⚠ missing  ${r.failed.join(', ')}`);
}

console.log(`\nLIVE SCAN — ${new Date().toISOString().slice(0, 16)}Z   ${PAIRS.length} pairs, H4`);
if (nav) console.log(`account ${ACCOUNT_ID}  NAV $${nav.toFixed(2)}  risking ${RISK_PCT}%/trade`);
console.log(`${'='.repeat(70)}`);

if (!hits.length) console.log('\nNo full setups.');
hits.forEach(r => show(r, '🎯 SETUP'));
if (nearMisses.length) {
  console.log(`\n${'-'.repeat(70)}\nNEAR MISSES (3 of 4 conditions) — shown so bad thresholds stay visible`);
  nearMisses.forEach(r => show(r, '·'));
}
console.log('');

if (NOTIFY && hits.length) {
  const r = hits[0];
  pushover(`${r.sym} ${r.dir} — level break`,
    `${fmt(r.sym, r.px)}  stop ${fmt(r.sym, r.stop)}  target ${fmt(r.sym, r.target)}\n` +
    `${r.units ? r.units.toLocaleString() + ' units' : ''}  level ${fmt(r.sym, r.zone)} tested ${r.returns}x\n` +
    `PUT THE STOP IN AS A REAL ORDER.`);
  console.log(`sent Pushover for ${r.sym}`);
}
