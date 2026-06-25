/**
 * Multi-pair backtest runner for 4H S&D strategy
 * Switches symbol, waits for strategy recalc, extracts results
 */
import { setSymbol } from '../src/core/chart.js';
import { evaluate } from '../src/connection.js';

const PAIRS = [
  'OANDA:GBPCHF', 'OANDA:AUDNZD', 'OANDA:EURNZD', 'OANDA:GBPNZD',
  'OANDA:EURCHF', 'OANDA:CADCHF', 'OANDA:EURAUD', 'OANDA:GBPJPY',
  'OANDA:AUDCHF', 'OANDA:GBPUSD', 'OANDA:GBPCAD', 'OANDA:USDCHF',
  'OANDA:GBPAUD', 'OANDA:CADJPY', 'OANDA:EURCAD', 'OANDA:USDCAD',
  'OANDA:AUDUSD', 'OANDA:NZDCHF', 'OANDA:USDJPY', 'OANDA:AUDJPY',
  'OANDA:EURJPY', 'OANDA:NZDCAD', 'OANDA:EURUSD', 'OANDA:AUDCAD',
  'OANDA:EURGBP', 'OANDA:NZDJPY', 'OANDA:NZDUSD', 'OANDA:CHFJPY'
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function clickUpdateReport() {
  for (let i = 0; i < 15; i++) {
    const clicked = await evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.trim() === 'Update report');
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
    if (clicked) { console.log('  → Update Report clicked'); return true; }
    await sleep(2000);
  }
  console.log('  → Update Report not found (auto-recalc)');
  return false;
}

async function extractResults() {
  const result = await evaluate(`
    (() => {
      const walker = document.createTreeWalker(
        document.querySelector('[class*="reportContainer"]') || document.body,
        NodeFilter.SHOW_TEXT,
        { acceptNode: n => n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }
      );
      const texts = [];
      let node;
      while ((node = walker.nextNode())) texts.push(node.textContent.trim());
      return JSON.stringify(texts.slice(0, 35));
    })()`);
  return JSON.parse(result);
}

function parseResults(texts) {
  const idx = (label) => texts.indexOf(label);
  return {
    pf:     texts[idx('Profit factor')     + 1] ?? '?',
    wr:     texts[idx('Profitable trades') + 1] ?? '?',
    trades: texts[idx('Total trades')      + 1] ?? '?',
    dd:     texts[idx('Max equity drawdown') + 2] ?? '?',
    pnl:    texts[idx('Total P&L')         + 1] ?? '?',
  };
}

// ── Main ──────────────────────────────────────────────────────────────
console.log('Multi-pair test — 4H S&D v5.14\n');
console.log('Symbol     | PF     | WR         | Trades | DD%    | P&L');
console.log('-----------|--------|------------|--------|--------|----------');

const results = [];

for (const pair of PAIRS) {
  try {
    await setSymbol({ symbol: pair });
    await sleep(5000);          // wait for chart load
    await clickUpdateReport();  // trigger recalc
    await sleep(10000);         // wait for recalc to finish

    const texts = await extractResults();
    const r = parseResults(texts);
    results.push({ pair, ...r });

    console.log(
      `${pair.padEnd(10)} | ${r.pf.padEnd(6)} | ${r.wr.padEnd(10)} | ${r.trades.padEnd(6)} | ${r.dd.padEnd(6)} | ${r.pnl}`
    );
  } catch (e) {
    console.log(`${pair.padEnd(10)} | ERROR: ${e.message}`);
  }

  await sleep(3000);
}

console.log('\nDone.');
console.log(JSON.stringify(results, null, 2));
