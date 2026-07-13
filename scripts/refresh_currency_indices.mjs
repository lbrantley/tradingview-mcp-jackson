#!/usr/bin/env node
/**
 * Refresh the currency index cache from TradingView.
 *
 * Called by deliver_review.mjs before each brief so the review always has
 * fresh index context. Also runnable standalone whenever a fresh read is
 * needed. Pauses any running scanner (SIGSTOP on Unix, kill+detached-restart
 * on Windows via src/process_control.js) to avoid CDP contention.
 *
 * Takes ~90 seconds — 8 indices × ~10s each including chart settle time.
 */
import { readCurrencyIndices } from '../src/currency_indices.js';
import { disconnect } from '../src/connection.js';
import { findScannerPid, pauseScanner, resumeScanner } from '../src/process_control.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const log = (m) => console.log(`[refresh_indices] ${m}`);

async function main() {
  const scannerPid = findScannerPid();
  if (scannerPid) log(`Found running scanner: PID ${scannerPid}`);
  else log('No running scanner detected — proceeding without pause');
  const pauseCtx = pauseScanner(scannerPid, { log, cwd: REPO });

  try {
    log('Reading 8 TVC currency indices...');
    const result = await readCurrencyIndices();
    log(`Cached ${Object.keys(result.indices || {}).length} indices at ${result.generatedAt}`);
  } catch (e) {
    console.error(`[refresh_indices] error: ${e.message}`);
  } finally {
    resumeScanner(pauseCtx, { log });
    await disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
