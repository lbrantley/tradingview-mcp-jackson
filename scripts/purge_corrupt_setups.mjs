#!/usr/bin/env node
/**
 * Purge corrupted setups from scanner_audit.json.
 *
 * Background: prior to the 2026-07-17 fix, the scanner had a chart-switch
 * settle race that caused it to store the PREVIOUS pair's price as the
 * entryPrice for newly detected setups. Result: brief_data.json audit numbers
 * are contaminated with synthetic "losses" from setups that were never
 * actually valid.
 *
 * This script:
 *   1. Connects to TV Desktop via CDP
 *   2. For each pending setup, switches to its pair and reads the live quote
 *   3. If stored entryPrice is >20% off live quote, marks setup as 'corrupt_purged'
 *   4. Writes cleaned audit back
 *
 * Usage:
 *   node scripts/purge_corrupt_setups.mjs           # dry-run report only
 *   node scripts/purge_corrupt_setups.mjs --apply   # actually modify audit
 *
 * Only touches PENDING setups. Closed (tp1_hit, stopped, expired) setups
 * keep their historical entryPrice — that's frozen history, even if wrong.
 * Purpose is to stop future review passes from wasting cycles on impossible
 * quotes.
 */
import { setSymbol } from '../src/core/chart.js';
import { getQuote } from '../src/core/data.js';
import { disconnect } from '../src/connection.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG = join(__dirname, '..', 'scanner_audit.json');
const APPLY = process.argv.includes('--apply');
const THRESHOLD_PCT = 20;  // >20% off live quote = corrupt

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForSymbolAndQuote(expectedSymbol, maxAttempts = 8) {
  await sleep(1500);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const q = await getQuote();
      if (q && q.symbol === expectedSymbol) return q;
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

async function main() {
  if (!existsSync(AUDIT_LOG)) {
    console.log('No scanner_audit.json found — nothing to purge.');
    process.exit(0);
  }

  const audit = JSON.parse(readFileSync(AUDIT_LOG, 'utf8'));
  const pending = audit.setups.filter(s => s.status === 'pending');
  console.log(`Loaded audit: ${audit.setups.length} total setups, ${pending.length} pending`);
  console.log(`Mode: ${APPLY ? 'APPLY (will modify audit)' : 'DRY RUN (no changes)'}\n`);

  // Group by symbol so we only switch charts once per pair
  const bySymbol = {};
  for (const s of pending) {
    if (!bySymbol[s.symbol]) bySymbol[s.symbol] = [];
    bySymbol[s.symbol].push(s);
  }

  const corruptFindings = [];
  const symbols = Object.keys(bySymbol).sort();

  for (const symbol of symbols) {
    process.stdout.write(`Checking ${symbol.replace('OANDA:', '')}... `);
    try {
      await setSymbol({ symbol });
      const quote = await waitForSymbolAndQuote(symbol);
      if (!quote) {
        console.log('chart-switch stuck, skipping');
        continue;
      }
      const livePrice = quote.close || quote.last;
      if (!livePrice) {
        console.log('no live price, skipping');
        continue;
      }

      const setups = bySymbol[symbol];
      const results = [];
      for (const s of setups) {
        const entry = s.entryPrice;
        if (!entry || entry <= 0) {
          results.push({ setup: s, verdict: 'null_entry', livePrice, offPct: null });
          continue;
        }
        const offPct = Math.abs(entry - livePrice) / livePrice * 100;
        if (offPct > THRESHOLD_PCT) {
          results.push({ setup: s, verdict: 'corrupt', livePrice, offPct });
        } else {
          results.push({ setup: s, verdict: 'ok', livePrice, offPct });
        }
      }
      const corrupt = results.filter(r => r.verdict === 'corrupt' || r.verdict === 'null_entry');
      console.log(`live ${livePrice} → ${setups.length} pending, ${corrupt.length} corrupt`);
      corruptFindings.push(...corrupt);
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`SUMMARY: ${corruptFindings.length} corrupt pending setups found`);
  console.log('═'.repeat(70));

  if (corruptFindings.length === 0) {
    console.log('Audit is clean.');
    await disconnect();
    process.exit(0);
  }

  for (const { setup, livePrice, offPct } of corruptFindings) {
    const off = offPct != null ? `${offPct.toFixed(1)}% off` : 'null entry';
    console.log(`  ${setup.symbol.replace('OANDA:', '').padEnd(8)} ${setup.type.padEnd(20)} entry=${setup.entryPrice} live=${livePrice} (${off})`);
  }

  if (APPLY) {
    const corruptIds = new Set(corruptFindings.map(c => c.setup.id));
    for (const s of audit.setups) {
      if (corruptIds.has(s.id)) {
        s.status = 'corrupt_purged';
        s.purgedAt = new Date().toISOString();
        s.purgeReason = 'entry_price_off_live_quote';
      }
    }
    writeFileSync(AUDIT_LOG, JSON.stringify(audit, null, 2));
    console.log(`\n✅ Marked ${corruptFindings.length} setups as 'corrupt_purged' in scanner_audit.json`);
  } else {
    console.log(`\n🔎 Dry run — no changes made. Re-run with --apply to purge.`);
  }

  await disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
