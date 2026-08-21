#!/usr/bin/env node
/**
 * Live monitor for the validated setup. Read-only — reads OANDA, prints, and
 * optionally sends Pushover. It cannot place an order.
 *
 * Reports the full state machine, not just entries, because the user asked to
 * be told when the system STARTS watching a level, not only when it fires:
 *
 *   WATCHING   daily close within 1 daily ATR of a level
 *   CODE RED   holding there without closing beyond  (n days)
 *   ENTRY      a candle rejects the level AND daily RSI is at an extreme
 *
 * The RSI filter is what makes this tradeable. Unfiltered, level rejections sit
 * at breakeven (+0.031 / -0.046 / +0.016R across three windows). With daily RSI
 * below 40 for longs or above 60 for shorts: +0.251 / +0.098 / +0.143R, and max
 * drawdown falls from -173R to -22R.
 *
 * Usage: node scripts/scan_live.mjs [--pairs A,B] [--risk 1.0] [--notify] [--all]
 */
import { getCandles, getPricing, getSummary, ACCOUNT_ID, LIVE_ACCOUNT_ID } from '../src/oanda.js';
import { atr, rsi } from '../src/indicators.js';
import { buildLevels } from '../src/structure.js';
import https from 'https';
import 'dotenv/config';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const RISK_PCT = parseFloat(argOf('--risk') || '1.0');
const NOTIFY = args.includes('--notify');
const SHOW_ALL = args.includes('--all');

const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;
const fmt = (s, v) => v.toFixed(/JPY$/.test(s) ? 3 : 5);

function pushover(title, message) {
  if (process.env.PUSHOVER_ENABLED !== '1' || !process.env.PUSHOVER_TOKEN) return;
  const body = new URLSearchParams({ token: process.env.PUSHOVER_TOKEN, user: process.env.PUSHOVER_USER,
    title, message, priority: '1' }).toString();
  const req = https.request({ hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } });
  req.on('error', () => {}); req.write(body); req.end();
}

// Size against the funded account. OANDA_ACCOUNT_ID deliberately points at the
// empty sandbox, whose NAV of 0 silently produced a size of 0 and no size line
// at all. Reading the live account is safe — getSummary is a GET, and the write
// guard is unchanged.
const nav = await getSummary(LIVE_ACCOUNT_ID || ACCOUNT_ID)
  .then(a => parseFloat(a.NAV)).catch(() => null);
const usdjpy = await getPricing('USDJPY').then(p => p.USDJPY.mid).catch(() => 150);
const entries = [], codeRed = [], watching = [];

for (const sym of PAIRS) {
  try {
    const D = await getCandles(sym, { granularity: 'D', count: 800 });
    if (D.length < 250) continue;
    const a = atr(D, 14);
    const r = rsi(D.map(b => b.close), 14);
    const i = D.length - 1;
    const av = a[i], dr = r[i];
    if (!av || dr == null) continue;
    const last = D[i], pip = pipOf(sym);
    const levels = buildLevels(D, { binATR: 0.35, minBars: 3 }).filter(z => z.confirmedAt <= i);

    for (const z of levels) {
      const isSup = z.kind === 'support';
      if (Math.abs(last.close - z.price) > av) continue;          // not being watched

      // How many recent days have held here without closing beyond?
      let hold = 0;
      for (let k = i; k >= Math.max(0, i - 15); k--) {
        if (Math.abs(D[k].close - z.price) > a[k]) break;
        if (isSup ? D[k].close < z.low : D[k].close > z.high) break;
        hold++;
      }
      const dir = isSup ? 'LONG' : 'SHORT';
      const rsiOK = isSup ? dr < 40 : dr > 60;
      const rejected = (isSup ? last.low <= z.high : last.high >= z.low)
                    && (isSup ? last.close > z.high : last.close < z.low);

      const px = last.close;
      const stop = isSup ? z.low - av * 0.3 : z.high + av * 0.3;
      const risk = Math.abs(px - stop);
      const tgt = levels.filter(w => isSup ? w.price > px : w.price < px)
        .sort((x, y) => Math.abs(x.price - px) - Math.abs(y.price - px))
        .find(w => Math.abs(w.price - px) / risk >= 1.5);
      const rr = tgt ? Math.abs(tgt.price - px) / risk : null;
      const units = nav && risk
        ? Math.floor((nav * RISK_PCT / 100) / (risk * (/JPY$/.test(sym) ? 1 / usdjpy : 1)))
        : null;

      const rec = { sym, dir, level: z.price, hold, dr, rsiOK, rejected, px, stop,
                    target: tgt?.price, rr, risk: risk / pip, units, touches: z.touches };
      if (rejected && rsiOK && tgt) entries.push(rec);
      else if (hold >= 2) codeRed.push(rec);
      else watching.push(rec);
      void 0;
    }
  } catch (e) { /* skip unavailable pair */ }
}

// The backtest drops any bar where levels either side argue opposite ways — a
// setup with no view — and keeps the best geometry otherwise. The live scan has
// to apply the identical rule or its signals are not the ones that were tested.
function dedupe(list) {
  const byPair = new Map();
  for (const r of list) { if (!byPair.has(r.sym)) byPair.set(r.sym, []); byPair.get(r.sym).push(r); }
  const out = [];
  for (const [, group] of byPair) {
    if (new Set(group.map(g => g.dir)).size > 1) continue;      // contradictory
    out.push(group.sort((a, b) => (b.rr ?? 0) - (a.rr ?? 0))[0]);
  }
  return out;
}
const conflicted = [...new Set(entries.map(e => e.sym))]
  .filter(sym => new Set(entries.filter(e => e.sym === sym).map(e => e.dir)).size > 1);
const finalEntries = dedupe(entries);

console.log(`\nLIVE SCAN — ${new Date().toISOString().slice(0, 16)}Z   ${PAIRS.length} pairs`);
if (nav) console.log(`sizing off ${LIVE_ACCOUNT_ID || ACCOUNT_ID}   NAV $${nav.toFixed(2)}   risking ${RISK_PCT}%/trade   (read-only)`);
console.log('='.repeat(72));

if (finalEntries.length) {
  console.log('\n🎯 ENTRY — level rejected AND daily RSI at an extreme\n');
  for (const e of finalEntries) {
    console.log(`  ${e.sym}  ${e.dir}   level ${fmt(e.sym, e.level)} (${e.touches} touches, held ${e.hold}d)`);
    console.log(`    entry ${fmt(e.sym, e.px)}   stop ${fmt(e.sym, e.stop)} (${e.risk.toFixed(0)}p)   target ${fmt(e.sym, e.target)} (${e.rr.toFixed(1)}R)`);
    if (e.units) console.log(`    size ${e.units.toLocaleString()} units = $${(nav * RISK_PCT / 100).toFixed(2)} risk    daily RSI ${e.dr.toFixed(1)}`);
    console.log(`    PUT THE STOP IN AS A REAL ORDER.`);
  }
} else console.log('\nNo entries.');
if (conflicted.length) console.log(`\n  (dropped ${conflicted.join(', ')} — levels either side firing opposite ways, no view)`);

if (codeRed.length) {
  console.log(`\n🔴 CODE RED — holding at a level, waiting for it to resolve\n`);
  for (const c of codeRed.sort((a, b) => b.hold - a.hold)) {
    const gate = c.rsiOK ? 'RSI ready' : `RSI ${c.dr.toFixed(0)} — needs ${c.dir === 'LONG' ? '<40' : '>60'}`;
    console.log(`  ${c.sym.padEnd(7)} ${c.dir.padEnd(6)} level ${fmt(c.sym, c.level)}  held ${c.hold}d  ${c.touches} touches   ${gate}`);
  }
}

if (SHOW_ALL && watching.length) {
  console.log(`\n👁  WATCHING — within 1 daily ATR of a level\n`);
  for (const w of watching) {
    console.log(`  ${w.sym.padEnd(7)} ${w.dir.padEnd(6)} level ${fmt(w.sym, w.level)}  daily RSI ${w.dr.toFixed(0)}`);
  }
} else if (!SHOW_ALL) {
  console.log(`\n(${watching.length} more within 1 ATR of a level — use --all to list)`);
}
console.log('');

if (NOTIFY && finalEntries.length) {
  const e = finalEntries[0];
  pushover(`${e.sym} ${e.dir} — level rejection`,
    `${fmt(e.sym, e.px)}  stop ${fmt(e.sym, e.stop)}  target ${fmt(e.sym, e.target)} (${e.rr.toFixed(1)}R)\n` +
    `${e.units ? e.units.toLocaleString() + ' units' : ''}   daily RSI ${e.dr.toFixed(0)}   level held ${e.hold}d\n` +
    `PUT THE STOP IN AS A REAL ORDER.`);
  console.log(`sent Pushover for ${e.sym}\n`);
}
