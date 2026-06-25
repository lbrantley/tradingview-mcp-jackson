/**
 * Clean single-run backtest for remaining pairs.
 * Ensures strategy tester is open, switches symbol, waits for "Update report" button, clicks it, screenshots.
 */
import { evaluate } from '../src/connection.js';
import { setSymbol } from '../src/core/chart.js';
import { captureScreenshot } from '../src/core/capture.js';
import { openPanel } from '../src/core/ui.js';

const PAIRS = [
  'OANDA:GBPJPY',
  'OANDA:USDJPY',
  'OANDA:AUDUSD',
  'OANDA:EURJPY',
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function ensureStrategyTesterOpen() {
  try {
    await openPanel({ panel: 'strategy-tester', action: 'open' });
    console.log('  Strategy tester opened');
  } catch(e) {
    console.log('  Strategy tester open attempt:', e.message);
  }
  await sleep(1500);
}

async function waitForUpdateReport(maxAttempts = 8, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await evaluate(`
      (function() {
        var candidates = document.querySelectorAll('button, [role="button"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = (candidates[i].textContent || '').trim();
          if (text === 'Update report' || text === 'Update Report') {
            candidates[i].click();
            return { found: true, text: text, attempt: ${i + 1} };
          }
        }
        return { found: false, attempt: ${i + 1} };
      })()
    `);
    if (result.found) {
      return result;
    }
    if (i < maxAttempts - 1) await sleep(intervalMs);
  }
  return { found: false, attempts: maxAttempts };
}

async function main() {
  console.log('Starting clean backtest run for remaining pairs...\n');

  // First ensure strategy tester is open
  await ensureStrategyTesterOpen();

  for (const pair of PAIRS) {
    const shortName = pair.replace('OANDA:', '');
    console.log(`\n=== ${shortName} ===`);

    // Switch symbol
    try {
      await setSymbol({ symbol: pair });
      console.log(`  Switched to ${pair}`);
    } catch (e) {
      console.log(`  ERROR switching: ${e.message}`);
      continue;
    }

    // Wait for chart + strategy recalc to start
    await sleep(5000);

    // Wait up to 16s for Update Report button to appear, then click it
    const clickResult = await waitForUpdateReport(8, 2000);
    if (clickResult.found) {
      console.log(`  Clicked Update Report on attempt ${clickResult.attempt}`);
    } else {
      console.log(`  Update Report not found after ${clickResult.attempts} attempts — screenshotting anyway`);
    }

    // Wait for recalc after clicking
    await sleep(8000);

    // Screenshot
    try {
      const shot = await captureScreenshot({ region: 'strategy_tester' });
      console.log(`  Screenshot: ${shot.file_path}`);
    } catch (e) {
      console.log(`  Screenshot error: ${e.message}`);
    }

    await sleep(2000);
  }

  console.log('\nDone.');
}

main().catch(console.error);
