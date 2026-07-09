#!/usr/bin/env node
/**
 * Refresh the currency index cache from TradingView.
 *
 * Called by deliver_review.mjs before each brief so the review always has
 * fresh index context. Also runnable standalone whenever a fresh read is
 * needed. Pauses any running scanner via SIGSTOP to avoid CDP contention,
 * resumes when done.
 *
 * Takes ~90 seconds — 8 indices × ~10s each including chart settle time.
 */
import { readCurrencyIndices } from '../src/currency_indices.js';
import { disconnect } from '../src/connection.js';
import { execSync } from 'child_process';

function findScannerPid() {
  try {
    const out = execSync('ps aux | grep "node scripts/scanner.mjs" | grep -v grep | grep -v refresh_currency_indices | grep -v deliver_review | grep -v prune_news',
      { encoding: 'utf8' });
    const lines = out.split('\n').filter(l => /node scripts\/scanner\.mjs\s*$/.test(l.trim()));
    if (lines.length === 0) return null;
    return parseInt(lines[0].trim().split(/\s+/)[1], 10);
  } catch { return null; }
}

async function main() {
  const scannerPid = findScannerPid();
  if (scannerPid) {
    console.log(`[refresh_indices] Pausing scanner PID ${scannerPid} (SIGSTOP)`);
    try { process.kill(scannerPid, 'SIGSTOP'); } catch (e) { console.error(`  pause failed: ${e.message}`); }
  } else {
    console.log('[refresh_indices] No running scanner detected — proceeding without pause');
  }

  try {
    console.log('[refresh_indices] Reading 8 TVC currency indices...');
    const result = await readCurrencyIndices();
    console.log(`[refresh_indices] Cached ${Object.keys(result.indices || {}).length} indices at ${result.generatedAt}`);
  } catch (e) {
    console.error(`[refresh_indices] error: ${e.message}`);
  } finally {
    if (scannerPid) {
      console.log(`[refresh_indices] Resuming scanner PID ${scannerPid} (SIGCONT)`);
      try { process.kill(scannerPid, 'SIGCONT'); } catch (e) { console.error(`  resume failed: ${e.message}`); }
    }
    await disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
