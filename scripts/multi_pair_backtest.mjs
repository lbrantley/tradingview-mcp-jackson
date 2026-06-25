/**
 * Multi-pair backtest runner
 * For each pair: switch symbol → click "Update Report" → wait → screenshot strategy tester
 */
import { evaluate } from '../src/connection.js';
import { setSymbol } from '../src/core/chart.js';
import { captureScreenshot } from '../src/core/capture.js';

const PAIRS = [
  'OANDA:GBPUSD',   // baseline
  'OANDA:AUDJPY',
  'OANDA:EURUSD',
  'OANDA:GBPJPY',
  'OANDA:USDJPY',
  'OANDA:AUDUSD',
  'OANDA:EURJPY',
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function clickUpdateReport() {
  const result = await evaluate(`
    (function() {
      // Try multiple selectors for "Update Report" button
      var candidates = document.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < candidates.length; i++) {
        var text = (candidates[i].textContent || '').trim();
        if (text === 'Update report' || text === 'Update Report' || text === 'Refresh' || text.toLowerCase().includes('update report')) {
          candidates[i].click();
          return { found: true, text: text };
        }
      }
      // Also try aria-label
      var ariaBtn = document.querySelector('[aria-label*="Update"]') || document.querySelector('[aria-label*="Refresh"]');
      if (ariaBtn) {
        ariaBtn.click();
        return { found: true, aria: ariaBtn.getAttribute('aria-label') };
      }
      // List all visible button texts for debugging
      var btns = [];
      for (var j = 0; j < Math.min(candidates.length, 30); j++) {
        var t = (candidates[j].textContent || '').trim();
        if (t.length > 0 && t.length < 50) btns.push(t);
      }
      return { found: false, visibleButtons: btns.slice(0, 20) };
    })()
  `);
  return result;
}

async function main() {
  console.log('Starting multi-pair backtest run...\n');

  for (const pair of PAIRS) {
    const shortName = pair.replace('OANDA:', '');
    console.log(`\n=== ${shortName} ===`);

    // 1. Switch symbol
    try {
      await setSymbol({ symbol: pair });
      console.log(`  Switched to ${pair}`);
    } catch (e) {
      console.log(`  ERROR switching symbol: ${e.message}`);
      continue;
    }

    // 2. Wait for chart + strategy tester to load
    await sleep(5000);

    // 3. Click Update Report
    const clickResult = await clickUpdateReport();
    if (clickResult.found) {
      console.log(`  Clicked Update Report: "${clickResult.text || clickResult.aria}"`);
    } else {
      console.log(`  Update Report button NOT found. Visible buttons: ${JSON.stringify(clickResult.visibleButtons)}`);
      // Still try to screenshot — maybe it auto-updated
    }

    // 4. Wait for backtest to recalculate
    await sleep(8000);

    // 5. Screenshot strategy tester
    try {
      const shot = await captureScreenshot({ region: 'strategy_tester' });
      console.log(`  Screenshot saved: ${shot.path || shot.filename || JSON.stringify(shot)}`);
    } catch (e) {
      console.log(`  Screenshot error: ${e.message}`);
      // Try full screenshot
      try {
        const shot2 = await captureScreenshot({ region: 'full' });
        console.log(`  Full screenshot saved: ${shot2.path || shot2.filename || JSON.stringify(shot2)}`);
      } catch (e2) {
        console.log(`  Full screenshot also failed: ${e2.message}`);
      }
    }

    // Small buffer between pairs
    await sleep(2000);
  }

  console.log('\nAll pairs done. Check screenshots/ directory for results.');
}

main().catch(console.error);
