#!/usr/bin/env node
/**
 * Score every alert the scanner produced — taken or not.
 *
 * The skipped ones matter more than the taken ones. If the alerts you pass on
 * do better than the ones you take, your filtering is costing money; if worse,
 * it is adding value. Neither is knowable without scoring both.
 *
 * Replays each ENTRY alert against real candles from the moment it fired:
 * stop first on any bar covering both levels, which cannot flatter a result.
 *
 * Usage: node scripts/score_alerts.mjs [--file alerts.jsonl]
 */
import { getCandlesRange } from '../src/oanda.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const args = process.argv.slice(2);
const FILE = join(REPO, args[args.indexOf('--file') + 1] || 'alerts.jsonl');
if (!existsSync(FILE)) { console.error(`No ${FILE}`); process.exit(1); }

const rows = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
// One row per alert — the scanner may log the same level again after a gap.
const seen = new Set();
const entries = rows.filter(r => r.state === 'ENTRY').filter(r => {
  const k = `${r.sym}:${r.dir}:${r.level.toFixed(5)}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});

console.log(`\nSCORING ${entries.length} entry alert(s) from ${FILE.split('/').pop()}\n`);
const dp = s => /JPY$/.test(s) ? 3 : 5;
const out = [];

for (const a of entries) {
  const L = a.dir === 'LONG';
  try {
    const bars = await getCandlesRange(a.sym, {
      granularity: 'H1', from: a.ts, to: new Date().toISOString(),
    });
    if (!bars.length) { console.log(`  ${a.sym} — no bars yet`); continue; }
    const risk = Math.abs(a.entry - a.stop);
    let res = 'open', rMult = null, when = null;
    for (const b of bars) {
      const hitStop = L ? b.low <= a.stop : b.high >= a.stop;
      const hitTgt = a.target != null && (L ? b.high >= a.target : b.low <= a.target);
      if (hitStop) { res = 'stopped'; rMult = -1; when = b.time; break; }
      if (hitTgt) { res = 'target'; rMult = Math.abs(a.target - a.entry) / risk; when = b.time; break; }
    }
    const last = bars[bars.length - 1].close;
    if (res === 'open') rMult = (L ? last - a.entry : a.entry - last) / risk;
    const mfe = L ? Math.max(...bars.map(b => b.high)) : Math.min(...bars.map(b => b.low));
    out.push({ ...a, res, rMult, when, bars: bars.length, mfeR: Math.abs(mfe - a.entry) / risk });
  } catch (e) { console.log(`  ${a.sym} — ${e.message.slice(0, 50)}`); }
}

out.sort((x, y) => y.rMult - x.rMult);
console.log('  pair     dir     entry      status     R      best-R   age');
for (const r of out) {
  console.log(`  ${r.sym.padEnd(8)} ${r.dir.padEnd(6)} ${r.entry.toFixed(dp(r.sym)).padStart(9)}` +
    `  ${r.res.padEnd(8)} ${((r.rMult >= 0 ? '+' : '') + r.rMult.toFixed(2)).padStart(6)}` +
    `  ${('+' + r.mfeR.toFixed(2)).padStart(7)}   ${r.bars}h`);
}
if (out.length) {
  const tot = out.reduce((a, b) => a + b.rMult, 0);
  const closed = out.filter(r => r.res !== 'open');
  console.log(`\n  ${out.length} alerts   total ${(tot >= 0 ? '+' : '') + tot.toFixed(2)}R` +
    `   avg ${(tot / out.length >= 0 ? '+' : '') + (tot / out.length).toFixed(3)}R` +
    `   ${closed.length} resolved, ${out.length - closed.length} still open`);
  console.log('  (best-R = furthest it went in your favour, i.e. what a trailing exit could have caught)\n');
}
