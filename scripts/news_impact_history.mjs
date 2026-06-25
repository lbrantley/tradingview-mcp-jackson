#!/usr/bin/env node
// News Impact History — measure how a recurring monthly event has affected a pair.
//
// Heuristic: pull ~365 daily bars, slide a 28-day window, find the highest-range
// bar in each window (likely the news release), and measure the 3-day reaction.
//
// Usage:
//   node scripts/news_impact_history.mjs NZDJPY
//   node scripts/news_impact_history.mjs EURUSD 12   (last 12 monthly windows)
//
// Output: per-event row + aggregate stats (avg pips, direction bias, follow-through rate).

import { setSymbol, setTimeframe } from '../src/core/chart.js';
import { getOhlcv } from '../src/core/data.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SETTLE_MS = 4000;

async function main() {
  const pairArg = process.argv[2];
  const monthsArg = parseInt(process.argv[3] || '12', 10);
  if (!pairArg) {
    console.error('Usage: node scripts/news_impact_history.mjs <PAIR> [months]');
    console.error('Example: node scripts/news_impact_history.mjs NZDJPY 12');
    process.exit(1);
  }

  const symbol = pairArg.includes(':') ? pairArg : `OANDA:${pairArg}`;
  const pair = pairArg.replace(/^[A-Z]+:/, '');
  const isJPY = pair.includes('JPY');
  const pipMul = isJPY ? 100 : 10000;

  console.log(`\n📊 News Impact History — ${pair}`);
  console.log(`   Last ${monthsArg} monthly events (largest-range day per 28-day window)\n`);

  // Load chart
  console.log('Loading daily chart...');
  await setSymbol({ symbol });
  await sleep(SETTLE_MS);
  await setTimeframe({ timeframe: 'D' });
  await sleep(SETTLE_MS);

  // Pull enough bars: monthsArg × ~22 trading days + 30-bar buffer for context + post-event
  const desiredBars = Math.min(500, monthsArg * 22 + 60);
  const ohlcv = await getOhlcv({ count: desiredBars });
  if (!ohlcv?.bars || ohlcv.bars.length < 60) {
    console.error('Not enough daily bars returned.');
    process.exit(1);
  }
  const bars = ohlcv.bars;
  console.log(`Got ${bars.length} daily bars.\n`);

  // Average daily range across the whole window
  const ranges = bars.map(b => b.high - b.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const avgPips = Math.round(avgRange * pipMul);

  // Slide a 28-bar window from most recent → past; find the biggest-range bar in each
  const events = [];
  let cursor = bars.length - 1;
  const WINDOW = 22; // trading-day month (5 days × ~4.4 weeks)
  while (cursor >= WINDOW && events.length < monthsArg) {
    const start = Math.max(0, cursor - WINDOW + 1);
    let maxRange = 0;
    let idx = -1;
    for (let i = start; i <= cursor; i++) {
      const r = bars[i].high - bars[i].low;
      if (r > maxRange) { maxRange = r; idx = i; }
    }
    if (idx < 0) break;
    events.push(idx);
    cursor = idx - 10; // jump past this event before looking for the next
  }

  // Analyze each event
  const results = [];
  for (const idx of events) {
    const bar = bars[idx];
    const rangePips = Math.round((bar.high - bar.low) * pipMul);
    const ratio = ((bar.high - bar.low) / avgRange).toFixed(1);
    const date = new Date(bar.time * 1000).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    const newsDir = bar.close > bar.open ? 'bullish' : 'bearish';
    const newsDirPips = Math.round(Math.abs(bar.close - bar.open) * pipMul);

    // 3-day post-event reaction (close-to-close)
    const post = bars.slice(idx + 1, Math.min(bars.length, idx + 4));
    let postOutcome = 'no data';
    let postPips = 0;
    if (post.length > 0) {
      const lastClose = post[post.length - 1].close;
      postPips = Math.round((lastClose - bar.close) * pipMul);
      const moveSize = Math.abs(lastClose - bar.close);
      if (moveSize < avgRange * 0.3) postOutcome = 'absorbed (flat)';
      else if (lastClose > bar.close) postOutcome = 'continued bullish';
      else postOutcome = 'continued bearish';
    }

    results.push({ date, rangePips, ratio, newsDir, newsDirPips, postOutcome, postPips });
  }

  // Print rows newest → oldest
  console.log('Date         | Range    | vs Avg | Day Dir         | 3-Day Reaction');
  console.log('─'.repeat(80));
  for (const r of results) {
    const dirStr = `${r.newsDirPips} pips ${r.newsDir}`;
    const postStr = `${r.postPips > 0 ? '+' : ''}${r.postPips} pips, ${r.postOutcome}`;
    console.log(
      `${r.date.padEnd(12)} | ${(r.rangePips + ' pips').padEnd(8)} | ${(r.ratio + 'x').padEnd(6)} | ${dirStr.padEnd(15)} | ${postStr}`
    );
  }
  console.log('─'.repeat(80));

  // Aggregate stats
  const totalEvents = results.length;
  const bullishDays = results.filter(r => r.newsDir === 'bullish').length;
  const bearishDays = results.filter(r => r.newsDir === 'bearish').length;
  const bullishFollowed = results.filter(r => r.postOutcome === 'continued bullish').length;
  const bearishFollowed = results.filter(r => r.postOutcome === 'continued bearish').length;
  const absorbed = results.filter(r => r.postOutcome === 'absorbed (flat)').length;
  const avgRangePips = Math.round(results.reduce((a, r) => a + r.rangePips, 0) / Math.max(1, totalEvents));
  const avgRatio = (results.reduce((a, r) => a + parseFloat(r.ratio), 0) / Math.max(1, totalEvents)).toFixed(1);

  console.log(`\nSummary across ${totalEvents} events:`);
  console.log(`  Pair avg daily range: ${avgPips} pips`);
  console.log(`  Avg event-day range:  ${avgRangePips} pips (${avgRatio}x normal)`);
  console.log(`  Direction split:      ${bullishDays} bullish / ${bearishDays} bearish days`);
  console.log(`  3-day follow-through:`);
  console.log(`    Continued bullish:  ${bullishFollowed}`);
  console.log(`    Continued bearish:  ${bearishFollowed}`);
  console.log(`    Absorbed (flat):    ${absorbed}`);

  const followRate = ((bullishFollowed + bearishFollowed) / totalEvents * 100).toFixed(0);
  console.log(`  Follow-through rate:  ${followRate}% (vs ${(absorbed / totalEvents * 100).toFixed(0)}% absorbed)`);

  // Sanity disclaimer
  console.log(`\nNote: this heuristic identifies the largest-range day per 22-bar window`);
  console.log(`as a proxy for "the news event" — it may catch other shocks (FOMC, NFP,`);
  console.log(`geopolitics). Use as a directional guide, not a precise CPI-only signal.\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
