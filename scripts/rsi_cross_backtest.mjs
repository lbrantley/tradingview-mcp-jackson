#!/usr/bin/env node
// RSI-SMA Cross Reversal Backtest — V4 (level-to-level R:R)
//
// Pulls ~24 months of daily bars per pair, builds long-history price-action levels,
// finds RSI-SMA crosses at extremes, and evaluates each setup by:
//   - Weekly RSI extreme (gate)
//   - Sustained pre-cross extreme (gate)
//   - Target level exists in reversal direction (gate)
//   - R:R ≥ 3:1 between target level and stop swing (gate)
//
// Outcome: did price reach the target level within 30 days?

import { setSymbol, setTimeframe } from '../src/core/chart.js';
import { getOhlcv } from '../src/core/data.js';
import { writeFileSync } from 'fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SETTLE_MS = 4000;

const ALL_PAIRS = [
  'GBPCHF', 'AUDNZD', 'EURNZD', 'GBPNZD',
  'EURCHF', 'CADCHF', 'EURAUD', 'GBPJPY',
  'AUDCHF', 'GBPUSD', 'GBPCAD', 'USDCHF',
  'GBPAUD', 'CADJPY', 'EURCAD', 'USDCAD',
  'AUDUSD', 'NZDCHF', 'USDJPY', 'AUDJPY',
  'EURJPY', 'NZDCAD', 'EURUSD', 'AUDCAD',
  'EURGBP', 'NZDJPY', 'NZDUSD', 'CHFJPY',
];

// ── Wilder's RSI ──
function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) gains += ch; else losses -= ch;
  }
  let avgG = gains / period, avgL = losses / period;
  rsi[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] != null) { sum += values[j]; count++; }
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

function trueRange(bars) {
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return tr;
}

function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  let sum = 0, started = false;
  for (let i = 1; i < bars.length; i++) {
    if (tr[i] == null) continue;
    if (!started) {
      sum += tr[i];
      if (i === period) { out[i] = sum / period; started = true; }
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return out;
}

async function pullDailyAndWeeklyBars(pair) {
  const symbol = `OANDA:${pair}`;
  await setSymbol({ symbol });
  await sleep(SETTLE_MS);

  await setTimeframe({ timeframe: 'D' });
  await sleep(SETTLE_MS);
  const daily = await getOhlcv({ count: 500 });

  await setTimeframe({ timeframe: 'W' });
  await sleep(SETTLE_MS);
  const weekly = await getOhlcv({ count: 100 });

  return { daily: daily?.bars || [], weekly: weekly?.bars || [] };
}

function weeklyRSIAt(weeklyBars, weeklyRSI, unixTs) {
  for (let i = weeklyBars.length - 1; i >= 0; i--) {
    if (weeklyBars[i].time <= unixTs) return weeklyRSI[i];
  }
  return null;
}

function findCrosses(rsi, rsiSma) {
  const crosses = [];
  // Start scanning after we have at least 100 bars of history for level detection
  // and stop 31 bars before end (need 30-day forward window)
  for (let i = 100; i < rsi.length - 31; i++) {
    const prevR = rsi[i - 1], prevS = rsiSma[i - 1];
    const curR = rsi[i], curS = rsiSma[i];
    if (prevR == null || prevS == null || curR == null || curS == null) continue;

    if (prevR <= prevS && curR > curS && curR <= 40) {
      crosses.push({ idx: i, direction: 'bullish', rsi: curR });
    } else if (prevR >= prevS && curR < curS && curR >= 60) {
      crosses.push({ idx: i, direction: 'bearish', rsi: curR });
    }
  }
  return crosses;
}

// Build long-history significant levels using all bars BEFORE the current cross point
function buildLevelsAt(dailyBars, currentIdx) {
  // Use ALL bars before currentIdx (up to 500-bar window already in dailyBars)
  const bars = dailyBars.slice(0, currentIdx);
  if (bars.length < 50) return { resistance: [], support: [] };

  // Cluster tolerance: 0.15% of current price
  const tolerance = dailyBars[currentIdx].close * 0.0015;

  const swingHighs = [];
  const swingLows = [];
  // Stricter swing detection: 3-bar buffer
  for (let i = 3; i < bars.length - 3; i++) {
    const b = bars[i];
    if (b.high > bars[i-1].high && b.high > bars[i-2].high && b.high > bars[i-3].high &&
        b.high > bars[i+1].high && b.high > bars[i+2].high && b.high > bars[i+3].high) {
      swingHighs.push(b.high);
    }
    if (b.low < bars[i-1].low && b.low < bars[i-2].low && b.low < bars[i-3].low &&
        b.low < bars[i+1].low && b.low < bars[i+2].low && b.low < bars[i+3].low) {
      swingLows.push(b.low);
    }
  }

  const clusterPoints = (points) => {
    const sorted = [...points].sort((a, b) => a - b);
    const clusters = [];
    let cur = [];
    for (const p of sorted) {
      if (cur.length === 0 || p - cur[cur.length - 1] <= tolerance) cur.push(p);
      else { clusters.push(cur); cur = [p]; }
    }
    if (cur.length) clusters.push(cur);
    return clusters
      .filter(c => c.length >= 3)
      .map(c => ({
        price: c.reduce((a, b) => a + b, 0) / c.length,
        touches: c.length,
      }));
  };

  return {
    resistance: clusterPoints(swingHighs),
    support: clusterPoints(swingLows),
  };
}

// Find target & stop levels for a given cross
function findTargetAndStop(cross, dailyBars, levels, atrVal) {
  const i = cross.idx;
  const bar = dailyBars[i];
  const close = bar.close;
  const dir = cross.direction;

  let target = null;
  let entryLevel = null; // the resistance/support we're reversing FROM

  if (dir === 'bearish') {
    // Entry level: nearest resistance AT or ABOVE close (within 1 × ATR)
    const candidatesAbove = levels.resistance
      .filter(l => l.price >= close - 0.3 * atrVal && l.price <= close + 1.5 * atrVal)
      .sort((a, b) => a.price - b.price);
    entryLevel = candidatesAbove[0] || null;

    // Target: next major support BELOW current
    const targets = levels.support
      .filter(l => l.price < close - 0.5 * atrVal)
      .sort((a, b) => b.price - a.price); // highest first = nearest
    target = targets[0] || null;
  } else {
    // Bullish reversal — entry near support
    const candidatesBelow = levels.support
      .filter(l => l.price <= close + 0.3 * atrVal && l.price >= close - 1.5 * atrVal)
      .sort((a, b) => b.price - a.price);
    entryLevel = candidatesBelow[0] || null;

    const targets = levels.resistance
      .filter(l => l.price > close + 0.5 * atrVal)
      .sort((a, b) => a.price - b.price);
    target = targets[0] || null;
  }

  // Stop level: recent swing past the cross-bar in the trend (not reversal) direction
  // For bearish reversal: stop above recent swing high in last 10 bars
  // For bullish reversal: stop below recent swing low in last 10 bars
  const lookback = 10;
  const window = dailyBars.slice(Math.max(0, i - lookback), i + 1);
  const buffer = 0.3 * atrVal;
  let stop;
  if (dir === 'bearish') {
    stop = Math.max(...window.map(b => b.high)) + buffer;
  } else {
    stop = Math.min(...window.map(b => b.low)) - buffer;
  }

  if (!target) return { target: null, stop: null, entryLevel, rr: null };

  const rr = Math.abs(target.price - close) / Math.abs(stop - close);
  return { target, stop, entryLevel, rr };
}

function evaluateConfluence(cross, rsi, dailyBars, weeklyBars, weeklyRSI, atrSeries, levels) {
  const i = cross.idx;
  const dir = cross.direction;
  const bar = dailyBars[i];
  const atrVal = atrSeries[i] || (bar.high - bar.low);

  // GATE 1: Weekly RSI in extreme
  const wRSI = weeklyRSIAt(weeklyBars, weeklyRSI, bar.time);
  const weeklyExtreme = dir === 'bearish'
    ? (wRSI != null && wRSI >= 65)
    : (wRSI != null && wRSI <= 35);

  // GATE 2: Sustained pre-cross extreme
  let sustained = 0;
  for (let j = Math.max(0, i - 5); j < i; j++) {
    if (rsi[j] == null) continue;
    if (dir === 'bearish' && rsi[j] >= 60) sustained++;
    if (dir === 'bullish' && rsi[j] <= 40) sustained++;
  }
  const sustainedAgree = sustained >= 3;

  // GATE 3: Find target and stop levels; require target exists + R:R ≥ 3
  const { target, stop, entryLevel, rr } = findTargetAndStop(cross, dailyBars, levels, atrVal);
  const targetExists = target != null;
  const rrSufficient = rr != null && rr >= 3.0;

  const passed = weeklyExtreme && sustainedAgree && targetExists && rrSufficient;

  return {
    passed,
    checks: { weeklyExtreme, sustainedAgree, targetExists, rrSufficient },
    weeklyRSI: wRSI,
    entryLevel,
    target,
    stop,
    rr,
  };
}

// Outcome: did price reach the target level within 30 days?
// Also tracks if stop was hit first (would have been a losing trade)
function measureLevelOutcome(cross, dailyBars, target, stop) {
  if (!target) return { reachedTarget: false, hitStop: false, daysToHit: null, maxFavorPips: 0 };

  const i = cross.idx;
  const dir = cross.direction;
  const isBearish = dir === 'bearish';

  let reachedTarget = false;
  let hitStop = false;
  let daysToHit = null;
  let bestPrice = dailyBars[i].close;

  for (let j = i + 1; j <= Math.min(i + 30, dailyBars.length - 1); j++) {
    const b = dailyBars[j];
    if (isBearish) {
      if (b.low < bestPrice) bestPrice = b.low;
      if (b.high >= stop && !reachedTarget && !hitStop) { hitStop = true; daysToHit = j - i; break; }
      if (b.low <= target.price && !reachedTarget) { reachedTarget = true; daysToHit = j - i; break; }
    } else {
      if (b.high > bestPrice) bestPrice = b.high;
      if (b.low <= stop && !reachedTarget && !hitStop) { hitStop = true; daysToHit = j - i; break; }
      if (b.high >= target.price && !reachedTarget) { reachedTarget = true; daysToHit = j - i; break; }
    }
  }

  return {
    reachedTarget,
    hitStop,
    daysToHit,
    maxFavorPips: Math.abs(bestPrice - dailyBars[i].close),
  };
}

async function main() {
  const args = process.argv.slice(2);
  let pairs = ALL_PAIRS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pairs') pairs = args[i + 1].split(',').map(p => p.trim().toUpperCase());
  }

  const allResults = [];

  for (const pair of pairs) {
    process.stdout.write(`Analyzing ${pair}...`);
    try {
      const { daily, weekly } = await pullDailyAndWeeklyBars(pair);
      if (daily.length < 150 || weekly.length < 20) {
        console.log(' insufficient data');
        continue;
      }

      const dailyCloses = daily.map(b => b.close);
      const weeklyCloses = weekly.map(b => b.close);
      const rsi = computeRSI(dailyCloses, 14);
      const rsiSma = sma(rsi, 14);
      const weeklyRSI = computeRSI(weeklyCloses, 14);
      const atrSeries = atr(daily, 14);

      const crosses = findCrosses(rsi, rsiSma);
      const isJPY = pair.includes('JPY');
      const pipMul = isJPY ? 100 : 10000;

      for (const cross of crosses) {
        const levels = buildLevelsAt(daily, cross.idx);
        const conf = evaluateConfluence(cross, rsi, daily, weekly, weeklyRSI, atrSeries, levels);
        const outcome = measureLevelOutcome(cross, daily, conf.target, conf.stop);

        const bar = daily[cross.idx];
        const date = new Date(bar.time * 1000).toISOString().slice(0, 10);

        allResults.push({
          pair,
          date,
          direction: cross.direction,
          rsi: cross.rsi.toFixed(1),
          weeklyRSI: conf.weeklyRSI != null ? conf.weeklyRSI.toFixed(1) : '?',
          passed: conf.passed,
          checks: conf.checks,
          crossClose: bar.close,
          entryLevel: conf.entryLevel?.price ?? null,
          entryTouches: conf.entryLevel?.touches ?? null,
          target: conf.target?.price ?? null,
          targetTouches: conf.target?.touches ?? null,
          stop: conf.stop,
          rr: conf.rr,
          reachedTarget: outcome.reachedTarget,
          hitStop: outcome.hitStop,
          daysToHit: outcome.daysToHit,
          maxFavorPips: Math.round(outcome.maxFavorPips * pipMul),
        });
      }

      const passedCount = allResults.filter(r => r.pair === pair && r.passed).length;
      console.log(` ${crosses.length} crosses, ${passedCount} passed`);
    } catch (e) {
      console.log(` error: ${e.message}`);
    }
  }

  // Define "followed through" as reached the target level
  for (const r of allResults) r.followed = r.reachedTarget;

  let TP = 0, FP = 0, FN = 0, TN = 0;
  for (const r of allResults) {
    if (r.passed && r.followed) TP++;
    else if (r.passed && !r.followed) FP++;
    else if (!r.passed && r.followed) FN++;
    else TN++;
  }

  const total = allResults.length;
  const passedCount = allResults.filter(r => r.passed).length;
  const filteredCount = total - passedCount;
  const followCount = allResults.filter(r => r.followed).length;
  const precision = passedCount > 0 ? (TP / passedCount * 100).toFixed(1) : '—';
  const recall = followCount > 0 ? (TP / followCount * 100).toFixed(1) : '—';
  const filterCost = filteredCount > 0 ? (FN / filteredCount * 100).toFixed(1) : '—';
  const baselineFollow = total > 0 ? (followCount / total * 100).toFixed(1) : '—';

  console.log('\n' + '═'.repeat(80));
  console.log('CONFUSION MATRIX — V4 (level-to-level outcome)');
  console.log('═'.repeat(80));
  console.log(`Total crosses:    ${total}`);
  console.log(`Reached target:   ${followCount}  (baseline: ${baselineFollow}%)`);
  console.log(`Passed all gates: ${passedCount}`);
  console.log(`Filtered out:     ${filteredCount}`);
  console.log();
  console.log(`                    Reached target   Did NOT reach`);
  console.log(`Gates PASSED        TP: ${TP}              FP: ${FP}`);
  console.log(`Gates FAILED        FN: ${FN}              TN: ${TN}`);
  console.log();
  console.log(`Precision: ${precision}%`);
  console.log(`Recall:    ${recall}%`);
  console.log(`Filter cost: ${filterCost}%`);
  console.log();

  // True Positives — the great setups
  const truePositives = allResults.filter(r => r.passed && r.followed);
  console.log('═'.repeat(105));
  console.log(`TRUE POSITIVES — ${truePositives.length} setups that passed all gates AND reached target`);
  console.log('═'.repeat(105));
  console.log('Date       | Pair    | Dir      | RSI  | wRSI | R:R  | Entry→Target           | Touches | Days | Result');
  console.log('─'.repeat(105));
  for (const r of truePositives) {
    const d = r.pair.includes('JPY') ? 2 : 4;
    const path = `${(r.crossClose).toFixed(d)} → ${(r.target).toFixed(d)}`;
    console.log(
      `${r.date} | ${r.pair.padEnd(7)} | ${r.direction.padEnd(8)} | ${r.rsi.padEnd(4)} | ${r.weeklyRSI.padEnd(4)} | ${r.rr.toFixed(1).padEnd(4)} | ${path.padEnd(21)} | ${(r.entryTouches + '/' + r.targetTouches).padEnd(7)} | ${(r.daysToHit + '').padEnd(4)} | ✅`
    );
  }
  console.log();

  // False Positives — the losers we'd take
  const falsePositives = allResults.filter(r => r.passed && !r.followed);
  console.log('═'.repeat(105));
  console.log(`FALSE POSITIVES — ${falsePositives.length} setups that passed gates but did NOT reach target`);
  console.log('═'.repeat(105));
  console.log('Date       | Pair    | Dir      | RSI  | wRSI | R:R  | Entry→Target           | Hit Stop? | Best move');
  console.log('─'.repeat(105));
  for (const r of falsePositives) {
    const d = r.pair.includes('JPY') ? 2 : 4;
    const path = `${(r.crossClose).toFixed(d)} → ${(r.target).toFixed(d)}`;
    const stopFlag = r.hitStop ? '🔴 yes' : 'no';
    console.log(
      `${r.date} | ${r.pair.padEnd(7)} | ${r.direction.padEnd(8)} | ${r.rsi.padEnd(4)} | ${r.weeklyRSI.padEnd(4)} | ${r.rr.toFixed(1).padEnd(4)} | ${path.padEnd(21)} | ${stopFlag.padEnd(9)} | ${r.maxFavorPips}p`
    );
  }
  console.log();

  // False Negatives — missed opportunities
  const falseNegatives = allResults.filter(r => !r.passed && r.followed);
  console.log('═'.repeat(105));
  console.log(`FALSE NEGATIVES — ${falseNegatives.length} filtered setups that DID reach target`);
  console.log('═'.repeat(105));
  console.log('Date       | Pair    | Dir      | wRSI | R:R  | Why filtered                            | Move');
  console.log('─'.repeat(105));
  for (const r of falseNegatives) {
    const why = [];
    if (!r.checks.weeklyExtreme) why.push('weekly');
    if (!r.checks.sustainedAgree) why.push('sustained');
    if (!r.checks.targetExists) why.push('no target');
    if (!r.checks.rrSufficient) why.push('R:R<3');
    const rrStr = r.rr != null ? r.rr.toFixed(1) : '—';
    console.log(
      `${r.date} | ${r.pair.padEnd(7)} | ${r.direction.padEnd(8)} | ${r.weeklyRSI.padEnd(4)} | ${rrStr.padEnd(4)} | ${why.join('+').padEnd(40)} | ${r.maxFavorPips}p`
    );
  }
  console.log();

  // Save markdown
  const lines = [];
  lines.push('# RSI-SMA Cross Backtest V4 — Level-to-Level R:R\n');
  lines.push(`_Generated ${new Date().toISOString()}_\n`);
  lines.push('## Methodology\n');
  lines.push('- 500 daily bars (~24 months) per pair');
  lines.push('- Significant levels: ≥3 swing touches clustered within 0.15%');
  lines.push('- PASS gates: Weekly RSI extreme + sustained pre-cross + target level exists + R:R ≥ 3:1');
  lines.push('- Outcome: reached target level within 30 days\n');
  lines.push('## Confusion Matrix\n');
  lines.push(`| | Reached target | Did NOT reach |`);
  lines.push(`|--|---|---|`);
  lines.push(`| **PASSED** | TP: ${TP} | FP: ${FP} |`);
  lines.push(`| **FILTERED** | FN: ${FN} | TN: ${TN} |`);
  lines.push(`\n- Precision: **${precision}%**`);
  lines.push(`- Baseline: ${baselineFollow}% of all crosses reached their target`);
  lines.push(`- Recall: ${recall}%`);
  lines.push(`- Filter cost: ${filterCost}%\n`);

  const outPath = '/Users/leebrantley/tradingview-mcp-jackson/rsi_cross_backtest_results.md';
  writeFileSync(outPath, lines.join('\n'));
  console.log(`\nMarkdown report saved to: ${outPath}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
