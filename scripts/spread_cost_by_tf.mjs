#!/usr/bin/env node
/**
 * What share of 1R does spread consume, per entry timeframe?
 *
 * Dropping to a lower timeframe shrinks the stop but not the spread, so the
 * cost per trade rises in direct proportion. This measures it rather than
 * assuming: median ATR per granularity against live spread.
 *
 * Usage: node scripts/spread_cost_by_tf.mjs [--pairs A,B] [--tfs M5,M15,H1,H4]
 */
import { getCandles, getPricing } from '../src/oanda.js';
import { atr } from '../src/indicators.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const PAIRS = (argOf('--pairs') || 'EURUSD,AUDUSD,EURGBP,USDJPY,USDCHF,GBPUSD,EURCHF,USDCAD').split(',');
const TFS = (argOf('--tfs') || 'M5,M15,H1,H4').split(',');

console.log('Spread as a share of a 1-ATR stop, by entry timeframe\n');
console.log('pair      spread  ' + TFS.map(t => (t + '-ATR  cost').padStart(14)).join(''));

for (const p of PAIRS) {
  const mul = /JPY$/.test(p) ? 100 : 10000;
  const px = await getPricing(p);
  const sp = px[p].spread * mul;
  const cells = [];
  for (const g of TFS) {
    const bars = await getCandles(p, { granularity: g, count: 400 });
    const a = atr(bars, 14).filter(Boolean).sort((x, y) => x - y);
    const med = a[Math.floor(a.length / 2)] * mul;
    cells.push(((med.toFixed(1) + 'p').padStart(7) + ' ' + (sp / med * 100).toFixed(0).padStart(4) + '%').padStart(14));
  }
  console.log('  ' + p.padEnd(8) + (sp.toFixed(1) + 'p').padStart(6) + '  ' + cells.join(''));
}
console.log('\ncost = spread / stop — the share of 1R paid before the trade begins.');
console.log('A lower entry timeframe is only cheap if the STOP still hangs off');
console.log('higher-timeframe structure; shrinking the stop with the timeframe');
console.log('multiplies the cost by the same factor.');
