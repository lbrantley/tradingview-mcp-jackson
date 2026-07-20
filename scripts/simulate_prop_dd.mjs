#!/usr/bin/env node
/**
 * Prop-firm DD simulator.
 *
 * Replays historical scanner setups against typical prop-firm rules to
 * answer: "if I'd been trading only these setups on a $XX,000 prop account,
 * would I have blown the challenge in the last N days?"
 *
 * Ships as a decision-support tool for user_prop_firm_strategy (2026-07-19).
 * Not a strategy tester — assumes 1:1 execution of scanner setups.
 *
 * Usage:
 *   node scripts/simulate_prop_dd.mjs
 *     --account 50000       # account size in USD (default 50000)
 *     --risk 1.0            # risk per trade in % of account (default 1.0)
 *     --daily-dd 5          # max daily DD in % (default 5, FTMO-like)
 *     --total-dd 10         # max total DD in % (default 10)
 *     --profit-target 8     # profit target in % (default 8)
 *     --days 60             # window in days (default 60)
 *     --prop-grade-only     # only simulate PROP-GRADE setups
 *     --min-strength 3      # min alert strength to trade (default 3 = "tradeable")
 *
 * Output:
 *   - Day-by-day P/L on the simulated account
 *   - Peak DD (daily + total)
 *   - Whether any day would have violated daily DD or hit total DD
 *   - Whether profit target was hit
 *   - Trade count, WR, avg R
 *
 * Assumes:
 *   - Position sized to risk % of account with SL distance = 1R
 *   - TP1 = 1.5R, TP2 = 3R, TP3 = 5R (or actual stored TP if closer)
 *   - Trade exits at first hit level (TP or SL); if still pending at end,
 *     it's counted as flat (no floating P/L in the sim)
 *   - Manual SL-to-BE moves after +0.5R MFE (matches user's strategy) —
 *     only applied when --with-be-mgmt flag is passed
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG = join(__dirname, '..', 'scanner_audit.json');

// ─── Args ─────────────────────────────────────────────────────
function argVal(name, def) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : def;
}
function argFlag(name) { return process.argv.includes(`--${name}`); }

const ACCOUNT = parseFloat(argVal('account', '50000'));
const RISK_PCT = parseFloat(argVal('risk', '1.0'));
const DAILY_DD_PCT = parseFloat(argVal('daily-dd', '5'));
const TOTAL_DD_PCT = parseFloat(argVal('total-dd', '10'));
const PROFIT_TARGET_PCT = parseFloat(argVal('profit-target', '8'));
const DAYS = parseInt(argVal('days', '60'), 10);
const PROP_GRADE_ONLY = argFlag('prop-grade-only');
const MIN_STRENGTH = parseInt(argVal('min-strength', '3'), 10);
const WITH_BE = argFlag('with-be-mgmt');

// ─── Load + filter setups ─────────────────────────────────────
if (!existsSync(AUDIT_LOG)) {
  console.error('scanner_audit.json not found — run scanner first.');
  process.exit(1);
}
const audit = JSON.parse(readFileSync(AUDIT_LOG, 'utf8'));
const cutoffMs = Date.now() - DAYS * 24 * 3600 * 1000;
const closed = audit.setups.filter(s => {
  if (!s.exitTime) return false;
  if (new Date(s.exitTime).getTime() < cutoffMs) return false;
  if (s.status === 'corrupt_purged') return false;
  if ((s.strength ?? 0) < MIN_STRENGTH) return false;
  if (PROP_GRADE_ONLY && !s.propGrade) return false;
  return true;
});

console.log(`Prop-firm DD simulator`);
console.log(`═════════════════════════════════════════════════════════════════════`);
console.log(`Account:          $${ACCOUNT.toLocaleString()}`);
console.log(`Risk per trade:   ${RISK_PCT}%  ($${(ACCOUNT * RISK_PCT / 100).toFixed(0)})`);
console.log(`Daily DD limit:   ${DAILY_DD_PCT}%  ($${(ACCOUNT * DAILY_DD_PCT / 100).toFixed(0)})`);
console.log(`Total DD limit:   ${TOTAL_DD_PCT}%  ($${(ACCOUNT * TOTAL_DD_PCT / 100).toFixed(0)})`);
console.log(`Profit target:    ${PROFIT_TARGET_PCT}%  ($${(ACCOUNT * PROFIT_TARGET_PCT / 100).toFixed(0)})`);
console.log(`Window:           last ${DAYS} days`);
console.log(`Filter:           strength ≥ ${MIN_STRENGTH}${PROP_GRADE_ONLY ? ', PROP-GRADE only' : ''}${WITH_BE ? ', +BE mgmt' : ''}`);
console.log(`Setups qualifying: ${closed.length}`);
console.log(`═════════════════════════════════════════════════════════════════════\n`);

if (closed.length === 0) {
  console.log('No qualifying setups in this window. Cannot simulate.');
  process.exit(0);
}

// ─── Compute R for each setup ─────────────────────────────────
function rachievedFor(setup) {
  const ref = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
  const exit = setup.exitPrice;
  const sl = setup.sl;
  if (ref == null || exit == null || sl == null) return null;
  const isLong = (setup.suggestedDirection || setup.type).includes('LONG');
  const slDist = Math.abs(ref - sl);
  if (slDist === 0) return null;
  const priceDelta = isLong ? (exit - ref) : (ref - exit);
  return priceDelta / slDist;
}

// If user asked for BE management, cap losses at BE once MFE reached +0.5R.
// Not a full sim of live SL moves — approximation using stored maxFavorable.
function beAdjustedR(setup, rawR) {
  if (!WITH_BE || rawR >= 0) return rawR;
  const ref = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
  const sl = setup.sl;
  const mfe = setup.maxFavorable;
  if (ref == null || sl == null || mfe == null) return rawR;
  const isLong = (setup.suggestedDirection || setup.type).includes('LONG');
  const slDist = Math.abs(ref - sl);
  const mfeDist = isLong ? (mfe - ref) : (ref - mfe);
  const mfeR = slDist > 0 ? mfeDist / slDist : 0;
  // If MFE reached +0.5R and user would have moved SL to BE, loss becomes 0
  return mfeR >= 0.5 ? 0 : rawR;
}

// ─── Sort by exit time and replay ─────────────────────────────
const trades = closed
  .map(s => ({ setup: s, R: beAdjustedR(s, rachievedFor(s)) }))
  .filter(t => t.R != null)
  .sort((a, b) => new Date(a.setup.exitTime) - new Date(b.setup.exitTime));

let equity = ACCOUNT;
let highWaterMark = ACCOUNT;
const perDayPnL = {};
let maxTotalDD = 0;
let maxDailyDD = 0;
let dailyDDViolationDay = null;
let totalDDViolationDay = null;
let profitTargetHitDay = null;
let firstDay = null;
let lastDay = null;

for (const t of trades) {
  const day = t.setup.exitTime.slice(0, 10);
  if (!firstDay) firstDay = day;
  lastDay = day;
  const riskDollars = ACCOUNT * RISK_PCT / 100;  // fixed risk on original account
  const pnlDollars = t.R * riskDollars;
  equity += pnlDollars;
  perDayPnL[day] = (perDayPnL[day] || 0) + pnlDollars;
  if (equity > highWaterMark) highWaterMark = equity;
  const totalDD = (ACCOUNT - equity) / ACCOUNT * 100;  // from starting account
  if (totalDD > maxTotalDD) maxTotalDD = totalDD;
  if (totalDD >= TOTAL_DD_PCT && !totalDDViolationDay) totalDDViolationDay = day;
  const profitPct = (equity - ACCOUNT) / ACCOUNT * 100;
  if (profitPct >= PROFIT_TARGET_PCT && !profitTargetHitDay) profitTargetHitDay = day;
}

// Check daily DD
for (const [day, pnl] of Object.entries(perDayPnL)) {
  const dailyDD = -pnl / ACCOUNT * 100;
  if (dailyDD > maxDailyDD) maxDailyDD = dailyDD;
  if (dailyDD >= DAILY_DD_PCT && !dailyDDViolationDay) dailyDDViolationDay = day;
}

// ─── Report ───────────────────────────────────────────────────
const wins = trades.filter(t => t.R > 0).length;
const losses = trades.filter(t => t.R < 0).length;
const flats = trades.filter(t => t.R === 0).length;
const totalR = trades.reduce((s, t) => s + t.R, 0);
const avgR = trades.length > 0 ? totalR / trades.length : 0;
const finalEquity = equity;
const finalPct = (finalEquity - ACCOUNT) / ACCOUNT * 100;

console.log(`RESULTS (${firstDay} → ${lastDay})`);
console.log(`─────────────────────────────────────────────────────────────────────`);
console.log(`Trades:            ${trades.length}  (W: ${wins}, L: ${losses}, BE: ${flats})`);
console.log(`Win rate:          ${trades.length > 0 ? (wins / (wins + losses + flats) * 100).toFixed(1) : 0}%`);
console.log(`Total R:           ${totalR.toFixed(2)}`);
console.log(`Avg R per trade:   ${avgR.toFixed(2)}`);
console.log(`Final equity:      $${finalEquity.toFixed(0)}  (${finalPct >= 0 ? '+' : ''}${finalPct.toFixed(2)}%)`);
console.log(`Max daily DD:      ${maxDailyDD.toFixed(2)}%  (limit: ${DAILY_DD_PCT}%)`);
console.log(`Max total DD:      ${maxTotalDD.toFixed(2)}%  (limit: ${TOTAL_DD_PCT}%)`);
console.log(``);
console.log(`CHALLENGE OUTCOME`);
console.log(`─────────────────────────────────────────────────────────────────────`);
if (dailyDDViolationDay) {
  console.log(`❌ FAILED — daily DD violation on ${dailyDDViolationDay}`);
} else if (totalDDViolationDay) {
  console.log(`❌ FAILED — total DD violation on ${totalDDViolationDay}`);
} else if (profitTargetHitDay) {
  console.log(`✅ PASSED — profit target hit on ${profitTargetHitDay}`);
} else {
  console.log(`⚠️  IN PROGRESS — no violation and no profit target hit`);
  console.log(`   Would need ${((PROFIT_TARGET_PCT * ACCOUNT / 100 - (equity - ACCOUNT)) / (ACCOUNT * RISK_PCT / 100)).toFixed(1)}R more to pass`);
}
console.log(``);

console.log(`DAILY P/L (worst 5 days)`);
console.log(`─────────────────────────────────────────────────────────────────────`);
const dayEntries = Object.entries(perDayPnL).sort((a, b) => a[1] - b[1]);
for (const [day, pnl] of dayEntries.slice(0, 5)) {
  const pct = pnl / ACCOUNT * 100;
  const bar = '█'.repeat(Math.min(30, Math.floor(Math.abs(pct) * 3)));
  console.log(`  ${day}  ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(7)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)  ${bar}`);
}

if (WITH_BE) {
  const rawTrades = closed
    .map(s => ({ setup: s, R: rachievedFor(s) }))
    .filter(t => t.R != null);
  const rawTotalR = rawTrades.reduce((s, t) => s + t.R, 0);
  const savedR = totalR - rawTotalR;
  console.log(``);
  console.log(`BE MANAGEMENT IMPACT`);
  console.log(`─────────────────────────────────────────────────────────────────────`);
  console.log(`Without BE mgmt:   ${rawTotalR.toFixed(2)}R total`);
  console.log(`With BE mgmt:      ${totalR.toFixed(2)}R total`);
  console.log(`Saved by BE:       ${savedR >= 0 ? '+' : ''}${savedR.toFixed(2)}R`);
}
