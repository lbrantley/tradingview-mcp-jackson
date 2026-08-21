#!/usr/bin/env node
/**
 * Trade journal from real OANDA fills — the ground truth the system has never
 * had. Every performance figure in this repo until now came from replaying
 * bars against remembered levels; this reads what the account actually did.
 *
 * Purpose is not bookkeeping. It is to capture how the user ADJUSTS relative to
 * what the scanner said: which alerts they take and skip, where they place the
 * stop against where the alert suggested, when they move it, when they scale
 * in, and when they exit early. That difference is the thing worth learning
 * from, and it cannot be recovered after the fact.
 *
 * Read-only. Polls /transactions/sinceid and appends to trades.jsonl.
 *
 * Usage:
 *   node scripts/track_trades.mjs            # poll and append
 *   node scripts/track_trades.mjs --report   # summarise the journal
 */
import { getTransactionsSince, getLastTransactionId, LIVE_ACCOUNT_ID, ACCOUNT_ID } from '../src/oanda.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const JOURNAL = join(REPO, 'trades.jsonl');
const STATE = join(REPO, '.track_state.json');
const ACC = LIVE_ACCOUNT_ID || ACCOUNT_ID;

// The transaction types that describe a trade's life. Everything else — daily
// financing, account config — is noise for this purpose.
const KEEP = new Set([
  'MARKET_ORDER', 'LIMIT_ORDER', 'STOP_ORDER',
  'ORDER_FILL', 'ORDER_CANCEL',
  'STOP_LOSS_ORDER', 'TAKE_PROFIT_ORDER', 'TRAILING_STOP_LOSS_ORDER',
  'TRADE_CLIENT_EXTENSIONS_MODIFY', 'STOP_LOSS_ORDER_REJECT',
]);

if (process.argv.includes('--report')) {
  if (!existsSync(JOURNAL)) { console.log('No journal yet. Run without --report first.'); process.exit(0); }
  const rows = readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log(`\nTRADE JOURNAL — ${rows.length} events, account ${ACC}\n`);

  const fills = rows.filter(r => r.type === 'ORDER_FILL');
  const closed = fills.filter(r => r.pl !== undefined && parseFloat(r.pl) !== 0);
  console.log(`  fills: ${fills.length}   closing fills: ${closed.length}`);
  if (closed.length) {
    const pls = closed.map(r => parseFloat(r.pl));
    const wins = pls.filter(p => p > 0);
    console.log(`  realised P/L: $${pls.reduce((a, b) => a + b, 0).toFixed(2)}` +
      `   win rate ${(wins.length / pls.length * 100).toFixed(0)}%` +
      `   avg win $${(wins.reduce((a, b) => a + b, 0) / (wins.length || 1)).toFixed(2)}` +
      `   avg loss $${(pls.filter(p => p <= 0).reduce((a, b) => a + b, 0) / (pls.filter(p => p <= 0).length || 1)).toFixed(2)}`);
  }
  // Stop modifications are the interesting signal: they are where discretion
  // overrides the plan.
  const stopMods = rows.filter(r => r.type === 'STOP_LOSS_ORDER' && r.replacesOrderID);
  console.log(`  stop-loss modifications: ${stopMods.length}   (each one is a decision worth reviewing)`);
  const byInstr = {};
  fills.forEach(r => { byInstr[r.instrument] = (byInstr[r.instrument] || 0) + 1; });
  const top = Object.entries(byInstr).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) console.log(`  most traded: ${top.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('');
  process.exit(0);
}

let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
if (!state) {
  // First run: start from now rather than pulling the whole account history,
  // which would flood the journal with trades placed before any of this existed.
  const last = await getLastTransactionId(ACC);
  state = { lastId: last };
  writeFileSync(STATE, JSON.stringify(state));
  console.log(`Journal started at transaction ${last}. Future trades will be recorded.`);
  console.log(`(To backfill instead, edit .track_state.json and lower lastId.)`);
  process.exit(0);
}

const { transactions, lastId } = await getTransactionsSince(state.lastId, ACC);
const fresh = transactions.filter(t => KEEP.has(t.type) && Number(t.id) > Number(state.lastId));

if (!fresh.length) { console.log(`No new activity since transaction ${state.lastId}.`); process.exit(0); }

for (const t of fresh) {
  appendFileSync(JOURNAL, JSON.stringify({
    id: t.id, time: t.time, type: t.type,
    instrument: t.instrument, units: t.units, price: t.price,
    pl: t.pl, reason: t.reason,
    tradeID: t.tradeID, orderID: t.orderID, replacesOrderID: t.replacesOrderID,
    sl: t.stopLossOnFill?.price, tp: t.takeProfitOnFill?.price,
  }) + '\n');
  const px = t.price ? ` @ ${t.price}` : '';
  const pl = t.pl && parseFloat(t.pl) !== 0 ? `   P/L $${parseFloat(t.pl).toFixed(2)}` : '';
  console.log(`  ${t.time.slice(0, 16)}  ${t.type.padEnd(24)} ${(t.instrument || '').padEnd(8)} ${(t.units || '').toString().padStart(8)}${px}${pl}`);
}
writeFileSync(STATE, JSON.stringify({ lastId }));
console.log(`\nrecorded ${fresh.length} event(s); journal now at transaction ${lastId}`);
