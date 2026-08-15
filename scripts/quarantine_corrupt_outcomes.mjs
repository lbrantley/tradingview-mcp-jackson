#!/usr/bin/env node
/**
 * Quarantine closed setups whose recorded OUTCOME cannot be trusted.
 *
 * Distinct from purge_corrupt_setups.mjs, which needs CDP and only re-checks
 * PENDING setups against live quotes. This one is fully offline and only
 * touches CLOSED setups (win/loss) whose outcome was fabricated by a bug.
 *
 * Classes quarantined:
 *
 *   wrong_side_tp3 — checkHistoricalHit() read `effTP3 = setup.tp3` without
 *     remapping for LTF-confirmed continuations. continuationLevels carries no
 *     tp3, so a flipped setup (REV LONG traded as CONT SHORT) inherited the
 *     reversal's tp3 sitting on the WRONG side of entry. TP3 is tested before
 *     TP2/TP1, so it fired on the first bar and returned outcome:'win' with an
 *     exitPrice on the losing side. 110 rows, all between 2026-06-01 and
 *     2026-07-07, mean -0.291R while labelled wins. Fixed at the source in
 *     scanner.mjs; these rows are the residue.
 *
 *   exit_price_bad — |R| > 20, meaning exitPrice came from the wrong symbol
 *     (the CDP quote race writes e.g. a JPY price onto a EURAUD trade).
 *
 * These are NOT repairable: review runs on 4H bars with getOhlcv({count:50}),
 * about 8 days of history, and every affected row is 37-73 days old. Re-running
 * --review would resolve all of them to null. Quarantine keeps the rows and the
 * evidence instead of rewriting history in place.
 *
 * Reversible: originalOutcome/originalStatus are preserved on each row, so
 * restoring is a field copy. A timestamped backup is written before any change.
 *
 * Usage:
 *   node scripts/quarantine_corrupt_outcomes.mjs           # dry-run report
 *   node scripts/quarantine_corrupt_outcomes.mjs --apply   # write changes
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const AUDIT_LOG = join(REPO, 'scanner_audit.json');
const APPLY = process.argv.includes('--apply');

// Mirror reviewSetups(): an LTF-confirmed pullback trades in suggestedDirection
// (the opposite of the stored type) against continuationLevels.
const effType = s => (s.ltfConfirmed && s.suggestedDirection ? s.suggestedDirection : s.type);
const effSL = s => (s.ltfConfirmed && s.continuationLevels?.sl != null
  ? s.continuationLevels.sl
  : s.sl);
const isClosed = s => s.outcome === 'win' || s.outcome === 'loss';

function rMultiple(s) {
  const sl = effSL(s);
  if (s.entryPrice == null || s.exitPrice == null || sl == null) return null;
  const risk = Math.abs(s.entryPrice - sl);
  if (!risk) return null;
  const move = /SHORT/.test(effType(s))
    ? s.entryPrice - s.exitPrice
    : s.exitPrice - s.entryPrice;
  const r = move / risk;
  return isFinite(r) ? r : null;
}

// Returns a reason string, or null when the row is trustworthy.
function classify(s) {
  if (!isClosed(s) || s.quarantined) return null;

  if (s.status === 'tp3_hit' && s.ltfConfirmed && s.suggestedDirection &&
      s.tp3 != null && s.entryPrice != null) {
    const onCorrectSide = effType(s).includes('LONG')
      ? s.tp3 > s.entryPrice
      : s.tp3 < s.entryPrice;
    if (!onCorrectSide) return 'wrong_side_tp3';
  }

  const r = rMultiple(s);
  if (r != null && Math.abs(r) > 20) return 'exit_price_bad';

  return null;
}

function main() {
  if (!existsSync(AUDIT_LOG)) {
    console.log('No scanner_audit.json found — nothing to quarantine.');
    process.exit(0);
  }

  const audit = JSON.parse(readFileSync(AUDIT_LOG, 'utf8'));
  const closed = audit.setups.filter(isClosed);
  const findings = [];
  for (const s of audit.setups) {
    const reason = classify(s);
    if (reason) findings.push({ setup: s, reason });
  }

  console.log(`Loaded audit: ${audit.setups.length} setups, ${closed.length} closed`);
  console.log(`Mode: ${APPLY ? 'APPLY (will modify audit)' : 'DRY RUN (no changes)'}\n`);

  const byReason = {};
  for (const f of findings) (byReason[f.reason] ||= []).push(f);

  for (const [reason, rows] of Object.entries(byReason)) {
    const rs = rows.map(f => rMultiple(f.setup)).filter(r => r != null && Math.abs(r) <= 20);
    const mean = rs.length ? (rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : '—';
    const wins = rows.filter(f => f.setup.outcome === 'win').length;
    console.log(`  ${reason.padEnd(18)} ${String(rows.length).padStart(3)} rows` +
                `  (${wins} labelled win)  meanR ${mean}`);
    const dates = rows.map(f => f.setup.timestamp).sort();
    if (dates.length) console.log(`  ${''.padEnd(18)} span ${dates[0].slice(0, 10)} → ${dates[dates.length - 1].slice(0, 10)}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`SUMMARY: ${findings.length} of ${closed.length} closed setups to quarantine ` +
              `(${(findings.length / closed.length * 100).toFixed(1)}%)`);
  console.log('═'.repeat(70));

  if (findings.length === 0) {
    console.log('Audit outcomes are clean.');
    return;
  }

  const remaining = closed.length - findings.length;
  console.log(`Trustworthy closed setups remaining: ${remaining}`);

  if (!APPLY) {
    console.log(`\n🔎 Dry run — no changes made. Re-run with --apply to quarantine.`);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const backup = join(REPO, `scanner_audit_pre_quarantine_${stamp}.json`);
  copyFileSync(AUDIT_LOG, backup);
  console.log(`\n💾 Backup written: ${backup.replace(REPO + '/', '')}`);

  const now = new Date().toISOString();
  for (const { setup, reason } of findings) {
    setup.originalOutcome = setup.outcome;
    setup.originalStatus = setup.status;
    setup.outcome = 'corrupt';        // drops it from win/loss and R stats
    setup.quarantined = true;
    setup.quarantineReason = reason;
    setup.quarantinedAt = now;
  }

  writeFileSync(AUDIT_LOG, JSON.stringify(audit, null, 2));
  console.log(`✅ Quarantined ${findings.length} setups (outcome → 'corrupt')`);
  console.log(`   Reversible: originalOutcome / originalStatus preserved on each row.`);
}

main();
