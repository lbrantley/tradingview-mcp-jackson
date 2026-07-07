/**
 * Live Setup Scanner v2.0
 *
 * Cycles through 28 forex pairs, reads LuxAlgo indicators via MCP,
 * and alerts when high-probability trade setups are forming.
 *
 * Setup types detected:
 *   1. REVERSAL — Price in zone/OB + directional CHoCH + OM extremes
 *   2. CONTINUATION — Mid-trend pullback + S&O trend + OM confirming
 *
 * Self-auditing: logs setups, reviews outcomes on subsequent scans,
 * maintains a running health score for scanner accuracy.
 *
 * Usage:
 *   node scripts/scanner.mjs [--once] [--pairs GBPUSD,USDJPY]
 *   node scripts/scanner.mjs --review     (review past setup outcomes)
 */

import { setSymbol, setTimeframe } from '../src/core/chart.js';
import { getStudyValues, getPineLabels, getPineBoxes, getOhlcv, getQuote } from '../src/core/data.js';
import { evaluate, disconnect } from '../src/connection.js';
import { notify, notifyOnce } from '../src/notify.js';
import { observe, observeOnce } from '../src/observe.js';
import { generateBriefData } from '../src/brief_data.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG = join(__dirname, '..', 'scanner_audit.json');
const NEWS_CACHE = join(__dirname, '..', 'news_cache.json');
const NEWS_OVERRIDES = join(__dirname, '..', 'news_overrides.json');
const STRENGTH_CACHE = join(__dirname, '..', 'strength_cache.json');

// ═══════════════════════════════════════════════════════════════════
// PHASE 5 — CURRENCY STRENGTH CONFLUENCE
// 8 buckets, one per major currency. Each bucket averages that currency
// vs the other 7. Provides Daily-timeframe directional context that
// complements pair-level HTF analysis.
// ═══════════════════════════════════════════════════════════════════
const CURRENCY_BUCKETS = {
  USD: '(FX_IDC:USDJPY/100+FX_IDC:USDAUD+FX_IDC:USDCAD+FX_IDC:USDCHF+FX_IDC:USDEUR+FX_IDC:USDGBP+FX_IDC:USDNZD)/7',
  JPY: '(FX_IDC:JPYUSD/100+FX_IDC:JPYAUD/100+FX_IDC:JPYCAD/100+FX_IDC:JPYNZD/100+FX_IDC:JPYCHF/100+FX_IDC:JPYEUR/100+FX_IDC:JPYGBP/100)/7',
  GBP: '(FX_IDC:GBPUSD+FX_IDC:GBPJPY/100+FX_IDC:GBPAUD+FX_IDC:GBPCAD+FX_IDC:GBPNZD+FX_IDC:GBPCHF+FX_IDC:GBPEUR)/7',
  CHF: '(FX_IDC:CHFUSD+FX_IDC:CHFJPY/100+FX_IDC:CHFAUD+FX_IDC:CHFNZD+FX_IDC:CHFGBP+FX_IDC:CHFEUR+FX_IDC:CHFCAD)/7',
  EUR: '(FX_IDC:EURUSD+FX_IDC:EURGBP+FX_IDC:EURJPY/100+FX_IDC:EURCHF+FX_IDC:EURAUD+FX_IDC:EURNZD+FX_IDC:EURCAD)/7',
  AUD: '(FX_IDC:AUDUSD+FX_IDC:AUDJPY/100+FX_IDC:AUDGBP+FX_IDC:AUDCHF+FX_IDC:AUDEUR+FX_IDC:AUDNZD+FX_IDC:AUDCAD)/7',
  NZD: '(FX_IDC:NZDUSD+FX_IDC:NZDJPY/100+FX_IDC:NZDGBP+FX_IDC:NZDCHF+FX_IDC:NZDEUR+FX_IDC:NZDAUD+FX_IDC:NZDCAD)/7',
  CAD: '(FX_IDC:CADUSD+FX_IDC:CADJPY/100+FX_IDC:CADGBP+FX_IDC:CADCHF+FX_IDC:CADEUR+FX_IDC:CADAUD+FX_IDC:CADNZD)/7',
};

// ═══════════════════════════════════════════════════════════════════
// NEWS FILTER — Forex Factory high-impact events
// ═══════════════════════════════════════════════════════════════════
// Currency → affected pairs mapping
const CURRENCY_PAIRS = {
  USD: ['GBPUSD','EURUSD','USDJPY','USDCAD','USDCHF','AUDUSD','NZDUSD'],
  GBP: ['GBPUSD','GBPJPY','GBPCHF','GBPNZD','GBPCAD','GBPAUD','EURGBP'],
  EUR: ['EURUSD','EURJPY','EURCHF','EURNZD','EURCAD','EURAUD','EURGBP'],
  JPY: ['USDJPY','GBPJPY','EURJPY','AUDJPY','NZDJPY','CADJPY','CHFJPY'],
  CAD: ['USDCAD','GBPCAD','EURCAD','AUDCAD','NZDCAD','CADCHF','CADJPY'],
  AUD: ['AUDUSD','AUDJPY','AUDNZD','AUDCAD','AUDCHF','EURAUD','GBPAUD'],
  NZD: ['NZDUSD','NZDJPY','NZDCAD','NZDCHF','AUDNZD','EURNZD','GBPNZD'],
  CHF: ['USDCHF','GBPCHF','EURCHF','AUDCHF','NZDCHF','CADCHF','CHFJPY'],
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse news JSON')); }
      });
    }).on('error', reject);
  });
}

// Merge two event arrays, deduping by currency+title+date within a 120-min window.
// Prefers override values when both sources have the same event (overrides have user-validated F/P).
// 120min window: mid-week override entries from screenshots can drift 1h from the
// live FF feed timing (timezone-parse edge cases). Anything more than 2h apart is
// almost certainly a genuinely different event.
function dedupeMerge(ffEvents, overrideEvents) {
  if (!overrideEvents || overrideEvents.length === 0) return ffEvents;
  const all = [...ffEvents];
  for (const ov of overrideEvents) {
    const ovTime = new Date(ov.date).getTime();
    const dupeIdx = all.findIndex(e =>
      e.currency === ov.currency &&
      e.title === ov.title &&
      Math.abs(new Date(e.date).getTime() - ovTime) <= 7200000
    );
    if (dupeIdx >= 0) all[dupeIdx] = ov; // prefer override (user validated)
    else all.push(ov);
  }
  return all;
}

// Load manual override events from news_overrides.json — covers gaps in the FF
// JSON feed (which sometimes omits CAD events or other currencies). User updates
// this file weekly from Forex Factory screenshots.
function loadNewsOverrides() {
  if (!existsSync(NEWS_OVERRIDES)) return [];
  try {
    const data = JSON.parse(readFileSync(NEWS_OVERRIDES, 'utf8'));
    const events = (data.manualEvents || []).map(e => ({
      title: e.title,
      currency: e.currency,
      date: e.date,
      impact: e.impact || 'High',
      time: new Date(e.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }),
      day: new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
      forecast: e.forecast || '—',
      previous: e.previous || '—',
      affectedPairs: CURRENCY_PAIRS[e.currency] || [],
      source: 'override',
    }));
    return events;
  } catch (e) {
    console.log(`  Override file parse error: ${e.message}`);
    return [];
  }
}

async function getHighImpactNews() {
  // Check cache (refresh every 6 hours)
  if (existsSync(NEWS_CACHE)) {
    try {
      const cache = JSON.parse(readFileSync(NEWS_CACHE, 'utf8'));
      const cacheAge = (Date.now() - cache.fetchedAt) / (1000 * 60 * 60);
      if (cacheAge < 6 && cache.events) {
        // Even when using cache, re-merge overrides (cheap — local file)
        const overrides = loadNewsOverrides();
        return dedupeMerge(cache.events, overrides);
      }
    } catch (e) {}
  }

  try {
    console.log('  Fetching Forex Factory calendar (this week + next week)...');
    // Pull both this week and next week so the catalyst lens has a 7-day forward window.
    const [thisWeek, nextWeek] = await Promise.all([
      fetchJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json').catch(() => []),
      fetchJSON('https://nfs.faireconomy.media/ff_calendar_nextweek.json').catch(() => []),
    ]);
    const events = [...thisWeek, ...nextWeek];

    // Keep High AND Medium impact for the catalyst lens — Medium events (retail sales,
    // PMI, employment data) often drive day-to-day pair moves and are key reversal catalysts.
    const highImpact = events
      .filter(e => e.impact === 'High' || e.impact === 'Medium')
      .map(e => ({
        title: e.title,
        currency: e.country,
        date: e.date,
        impact: e.impact,
        time: new Date(e.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }),
        day: new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
        forecast: e.forecast || '—',
        previous: e.previous || '—',
        affectedPairs: CURRENCY_PAIRS[e.country] || [],
        source: 'ff',
      }));

    // Cache it
    writeFileSync(NEWS_CACHE, JSON.stringify({ fetchedAt: Date.now(), events: highImpact }, null, 2));

    // Merge in user-supplied overrides (manual screenshots from FF UI)
    const overrides = loadNewsOverrides();
    const merged = dedupeMerge(highImpact, overrides);
    if (overrides.length > 0) console.log(`  Loaded ${overrides.length} manual override event(s)`);
    return merged;
  } catch (err) {
    console.log(`  News fetch failed: ${err.message}`);
    return loadNewsOverrides(); // overrides still work even if FF fails
  }
}

// ─── Measure historical news impact from OHLCV data ──────────────
// For monthly events: look ~28 days back for a volatility spike on that pair
// Returns: { prevMove, prevDate, avgDailyRange } in price units
async function measureNewsImpact(symbol, eventTitle, eventCurrency) {
  try {
    // Get daily bars going back ~60 days to find the previous release
    const ohlcv = await getOhlcv({ count: 60 });
    if (!ohlcv || !ohlcv.bars || ohlcv.bars.length < 30) return null;

    const bars = ohlcv.bars;
    const isJPY = symbol.includes('JPY');
    const pipMultiplier = isJPY ? 100 : 10000;

    // Calculate average daily range
    const ranges = bars.map(b => Math.abs(b.high - b.low));
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const avgPips = Math.round(avgRange * pipMultiplier);

    // Most high-impact events are monthly — look 25-35 days back
    // Find the bar with the largest range in that window (likely the news bar)
    const targetStart = Math.max(0, bars.length - 35);
    const targetEnd = Math.max(0, bars.length - 20);
    let maxRange = 0;
    let newsBarIdx = -1;

    for (let i = targetStart; i < targetEnd && i < bars.length; i++) {
      const range = Math.abs(bars[i].high - bars[i].low);
      if (range > maxRange) {
        maxRange = range;
        newsBarIdx = i;
      }
    }

    if (newsBarIdx < 0) return null;
    const newsBar = bars[newsBarIdx];

    // ── News bar move ──
    const prevMove = Math.abs(newsBar.high - newsBar.low);
    const prevDate = new Date(newsBar.time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const newsDirection = newsBar.close > newsBar.open ? 'bullish' : 'bearish';
    const movePips = Math.round(prevMove * pipMultiplier);

    // ═══════════════════════════════════════════════════════
    // HISTORICAL SETUP CONTEXT at time of previous news
    // ═══════════════════════════════════════════════════════

    // ── 1. Trend context: was price above or below 50-bar SMA? ──
    let sma50 = 0;
    const smaStart = Math.max(0, newsBarIdx - 50);
    const smaCount = newsBarIdx - smaStart;
    if (smaCount > 0) {
      for (let i = smaStart; i < newsBarIdx; i++) sma50 += bars[i].close;
      sma50 /= smaCount;
    }
    const preTrend = newsBar.open > sma50 ? 'bullish' : 'bearish';
    const trendLabel = newsBar.open > sma50 ? 'above 50SMA (bullish trend)' : 'below 50SMA (bearish trend)';

    // ── 2. Range position: was price near recent highs, lows, or mid? ──
    // Look at 20-bar range before the news bar
    const rangeWindow = bars.slice(Math.max(0, newsBarIdx - 20), newsBarIdx);
    let recentHigh = -Infinity, recentLow = Infinity;
    for (const b of rangeWindow) {
      if (b.high > recentHigh) recentHigh = b.high;
      if (b.low < recentLow) recentLow = b.low;
    }
    const rangeSize = recentHigh - recentLow;
    const pricePosition = rangeSize > 0
      ? (newsBar.open - recentLow) / rangeSize
      : 0.5;
    const positionLabel = pricePosition > 0.7 ? 'premium (near highs)'
      : pricePosition < 0.3 ? 'discount (near lows)'
      : 'equilibrium (mid-range)';

    // ── 3. Pre-news momentum: last 5 bars before news ──
    const preNewsBars = bars.slice(Math.max(0, newsBarIdx - 5), newsBarIdx);
    let bullBars = 0, bearBars = 0;
    for (const b of preNewsBars) {
      if (b.close > b.open) bullBars++;
      else bearBars++;
    }
    const preMomentum = bullBars > bearBars ? 'bullish' : bearBars > bullBars ? 'bearish' : 'mixed';

    // ── 4. Post-news outcome: did news continue or reverse the pre-trend? ──
    // Look at the 3 bars after the news bar
    const postBars = bars.slice(newsBarIdx + 1, Math.min(bars.length, newsBarIdx + 4));
    let postDirection = 'unclear';
    if (postBars.length > 0) {
      const postClose = postBars[postBars.length - 1].close;
      const postMove = postClose - newsBar.close;
      if (Math.abs(postMove) > avgRange * 0.3) {
        postDirection = postMove > 0 ? 'bullish' : 'bearish';
      } else {
        postDirection = 'flat (absorbed)';
      }
    }

    // Did news confirm or reverse the pre-existing trend?
    let outcome;
    if (newsDirection === preTrend) {
      outcome = 'CONFIRMED trend';
    } else {
      outcome = 'REVERSED trend';
    }

    // Follow-through assessment
    let followThrough;
    if (postDirection === newsDirection) {
      followThrough = 'continued moving ' + newsDirection;
    } else if (postDirection === 'flat (absorbed)') {
      followThrough = 'move was absorbed (reverted)';
    } else if (postDirection === 'unclear') {
      followThrough = 'follow-through unclear';
    } else {
      followThrough = 'reversed after initial move';
    }

    return {
      movePips,
      avgPips,
      prevDate,
      direction: newsDirection,
      ratio: (prevMove / avgRange).toFixed(1),
      // Historical context
      context: {
        preTrend: trendLabel,
        rangePosition: positionLabel,
        preMomentum,
        newsOutcome: outcome,
        followThrough,
      },
    };
  } catch (err) {
    return null;
  }
}

function getNewsWarnings(symbol, newsEvents) {
  const pair = shortName(symbol);
  const warnings = [];
  const nowMs = Date.now();
  const HOURS_48 = 48 * 60 * 60 * 1000;

  for (const event of newsEvents) {
    // Scan-time warnings only flag HIGH-impact news. Medium events flow into the
    // catalyst lens via getCatalystWindow but don't clutter the per-setup warnings.
    if (event.impact && event.impact !== 'High') continue;
    // Check if this event affects this pair
    if (!event.affectedPairs.some(p => pair.includes(p.replace('/', '')) || p.includes(pair))) continue;

    const eventTime = new Date(event.date).getTime();
    const hoursUntil = (eventTime - nowMs) / (1000 * 60 * 60);

    // Only warn for upcoming events (next 48 hours) or very recent (last 2 hours)
    if (hoursUntil > -2 && hoursUntil < 48) {
      const urgency = hoursUntil < 4 ? 'IMMINENT' : hoursUntil < 12 ? 'TODAY' : 'UPCOMING';
      warnings.push({
        urgency,
        hoursUntil: hoursUntil.toFixed(1),
        title: event.title,
        currency: event.currency,
        time: `${event.day} ${event.time} EST`,
        forecast: event.forecast,
        previous: event.previous,
      });
    }
  }

  // Sort by urgency (closest first)
  warnings.sort((a, b) => parseFloat(a.hoursUntil) - parseFloat(b.hoursUntil));
  return warnings;
}

// ─── Configuration ───────────────────────────────────────────────
const ALL_PAIRS = [
  'OANDA:GBPCHF', 'OANDA:AUDNZD', 'OANDA:EURNZD', 'OANDA:GBPNZD',
  'OANDA:EURCHF', 'OANDA:CADCHF', 'OANDA:EURAUD', 'OANDA:GBPJPY',
  'OANDA:AUDCHF', 'OANDA:GBPUSD', 'OANDA:GBPCAD', 'OANDA:USDCHF',
  'OANDA:GBPAUD', 'OANDA:CADJPY', 'OANDA:EURCAD', 'OANDA:USDCAD',
  'OANDA:AUDUSD', 'OANDA:NZDCHF', 'OANDA:USDJPY', 'OANDA:AUDJPY',
  'OANDA:EURJPY', 'OANDA:NZDCAD', 'OANDA:EURUSD', 'OANDA:AUDCAD',
  'OANDA:EURGBP', 'OANDA:NZDJPY', 'OANDA:NZDUSD', 'OANDA:CHFJPY'
];

const SETTLE_MS = 2500;  // wait for chart + indicators to load after symbol switch
                          // (was 4000; trimmed for throughput — revert if reads return stale data)

// ─── Helpers ─────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shortName = sym => sym.replace('OANDA:', '');
const shortType = (t) => {
  if (t === 'REVERSAL LONG')     return 'REV LONG';
  if (t === 'REVERSAL SHORT')    return 'REV SHORT';
  if (t === 'CONTINUATION LONG') return 'CONT LONG';
  if (t === 'CONTINUATION SHORT')return 'CONT SHORT';
  return t;
};
const now = () => new Date().toLocaleTimeString('en-US', { hour12: false });

// ─── HTF TREND ENGINE — Daily + Weekly RSI(14) must agree ───────
// Same logic as Pine v7.0: bull = both > 50, bear = both < 50
// Counter-trend setups get reclassified as PULLBACK ALERTS
function calculateRSI(bars, period = 14) {
  if (!bars || bars.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < bars.length; i++) {
    const change = bars[i].close - bars[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Full RSI series (one value per bar) — needed for cross detection
function calculateRSISeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (!bars || bars.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch > 0) gains += ch; else losses -= ch;
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    avgG = (avgG * (period - 1) + Math.max(ch, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

// Simple moving average of a values array
function smaSeries(values, period) {
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

// Detect RSI/RSI-SMA cross at extreme zone in the last `recentBars` bars.
// Returns { direction, barsAgo, rsiAtCross, smaAtCross, crossPrice } or null.
function detectRsiSmaCross(rsiSeries, smaSeries, dailyBars, recentBars = 3) {
  const n = rsiSeries.length;
  if (n < 30) return null;
  for (let i = n - 1; i >= n - recentBars && i >= 1; i--) {
    const prevR = rsiSeries[i - 1], prevS = smaSeries[i - 1];
    const curR = rsiSeries[i], curS = smaSeries[i];
    if (prevR == null || prevS == null || curR == null || curS == null) continue;

    if (prevR <= prevS && curR > curS && curR <= 40) {
      return { direction: 'bullish', barsAgo: n - 1 - i, rsiAtCross: curR, smaAtCross: curS, crossPrice: dailyBars[i].close };
    }
    if (prevR >= prevS && curR < curS && curR >= 60) {
      return { direction: 'bearish', barsAgo: n - 1 - i, rsiAtCross: curR, smaAtCross: curS, crossPrice: dailyBars[i].close };
    }
  }
  return null;
}

// Build significant price-action levels from a long daily history.
// Levels = clusters of swing highs/lows (3-bar isolation) with ≥3 touches,
// clustered within 0.15% of current price.
function buildPriceLevels(dailyBars, currentPrice) {
  if (!dailyBars || dailyBars.length < 50) return { resistance: [], support: [] };
  // Wider clustering so nearby touches collapse to one level (manual TA does this).
  const tolerance = currentPrice * 0.003;
  const swingHighs = [];
  const swingLows = [];
  for (let i = 3; i < dailyBars.length - 3; i++) {
    const b = dailyBars[i];
    if (b.high > dailyBars[i-1].high && b.high > dailyBars[i-2].high && b.high > dailyBars[i-3].high &&
        b.high > dailyBars[i+1].high && b.high > dailyBars[i+2].high && b.high > dailyBars[i+3].high) {
      swingHighs.push(b.high);
    }
    if (b.low < dailyBars[i-1].low && b.low < dailyBars[i-2].low && b.low < dailyBars[i-3].low &&
        b.low < dailyBars[i+1].low && b.low < dailyBars[i+2].low && b.low < dailyBars[i+3].low) {
      swingLows.push(b.low);
    }
  }
  const cluster = (pts) => {
    const sorted = [...pts].sort((a, b) => a - b);
    const clusters = [];
    let cur = [];
    for (const p of sorted) {
      if (cur.length === 0 || p - cur[cur.length - 1] <= tolerance) cur.push(p);
      else { clusters.push(cur); cur = [p]; }
    }
    if (cur.length) clusters.push(cur);
    return clusters
      .filter(c => c.length >= 2) // double-tops/bottoms count; user's manual TA does this
      .map(c => ({
        price: c.reduce((a, b) => a + b, 0) / c.length,
        low: Math.min(...c),
        high: Math.max(...c),
        touches: c.length,
      }))
      .sort((a, b) => a.price - b.price);
  };
  return {
    resistance: cluster(swingHighs),
    support: cluster(swingLows),
  };
}

// Find the highest swing high / lowest swing low in the recent window.
// These are single-touch "last swing" extremes — when price approaches them,
// it's a possible reversal zone even without confirmed multi-touch S/R.
function findLastSwingExtremes(dailyBars, lookbackBars = 60) {
  if (!dailyBars || dailyBars.length < 10) return { highestSwingHigh: null, lowestSwingLow: null };
  const start = Math.max(0, dailyBars.length - lookbackBars);
  let highest = null, lowest = null;
  for (let i = start + 3; i < dailyBars.length - 3; i++) {
    const b = dailyBars[i];
    if (b.high > dailyBars[i-1].high && b.high > dailyBars[i-2].high && b.high > dailyBars[i-3].high &&
        b.high > dailyBars[i+1].high && b.high > dailyBars[i+2].high && b.high > dailyBars[i+3].high) {
      if (highest == null || b.high > highest.price) highest = { price: b.high, time: b.time };
    }
    if (b.low < dailyBars[i-1].low && b.low < dailyBars[i-2].low && b.low < dailyBars[i-3].low &&
        b.low < dailyBars[i+1].low && b.low < dailyBars[i+2].low && b.low < dailyBars[i+3].low) {
      if (lowest == null || b.low < lowest.price) lowest = { price: b.low, time: b.time };
    }
  }
  return { highestSwingHigh: highest, lowestSwingLow: lowest };
}

async function getHTFTrend() {
  // Switch to Daily, get 500 bars (~24 months) — needed for long-history levels + cross detection.
  await setTimeframe({ timeframe: 'D' });
  await sleep(SETTLE_MS);
  const dailyOhlcv = await getOhlcv({ count: 500 });
  const dailyBars = dailyOhlcv?.bars || [];
  const dRSI = calculateRSI(dailyBars, 14);

  // RSI/RSI-SMA cross detection (user's trigger: cross at ≥60 / ≤40 in last 3 daily bars)
  const rsiSeries = calculateRSISeries(dailyBars, 14);
  const rsiSmaSer = smaSeries(rsiSeries, 14);
  const rsiSmaCross = detectRsiSmaCross(rsiSeries, rsiSmaSer, dailyBars, 3);

  // Long-history price-action levels (using all available daily bars).
  const currentPrice = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1].close : 0;
  const levels = buildPriceLevels(dailyBars, currentPrice);
  const lastSwings = findLastSwingExtremes(dailyBars, 60);

  // Multi-week / multi-month extremes from daily bars
  let dailyHigh = -Infinity, dailyLow = Infinity;
  let dailyHighDate = null, dailyLowDate = null;
  for (const b of dailyBars) {
    if (b.high > dailyHigh) { dailyHigh = b.high; dailyHighDate = b.time; }
    if (b.low < dailyLow)  { dailyLow  = b.low;  dailyLowDate  = b.time; }
  }

  // Switch to Weekly
  await setTimeframe({ timeframe: 'W' });
  await sleep(SETTLE_MS);
  const weeklyOhlcv = await getOhlcv({ count: 50 });
  const weeklyBars = weeklyOhlcv?.bars || [];
  const wRSI = calculateRSI(weeklyBars, 14);

  // Weekly extremes (longer-term)
  let weeklyHigh = -Infinity, weeklyLow = Infinity;
  for (const b of weeklyBars) {
    if (b.high > weeklyHigh) weeklyHigh = b.high;
    if (b.low < weeklyLow)  weeklyLow  = b.low;
  }

  // Switch back to 4H
  await setTimeframe({ timeframe: '240' });
  await sleep(SETTLE_MS);

  return {
    dRSI: Math.round(dRSI * 10) / 10,
    wRSI: Math.round(wRSI * 10) / 10,
    daily: dRSI > 50 ? 'bullish' : 'bearish',
    weekly: wRSI > 50 ? 'bullish' : 'bearish',
    htfBullish: dRSI > 50 && wRSI > 50,
    htfBearish: dRSI < 50 && wRSI < 50,
    aligned: (dRSI > 50) === (wRSI > 50),
    // Multi-week / multi-month extremes
    dailyHigh, dailyLow, dailyHighDate, dailyLowDate,
    weeklyHigh, weeklyLow,
    dailyBarsCount: dailyBars.length,
    weeklyBarsCount: weeklyBars.length,
    // New: RSI/SMA cross trigger + long-history price levels + last swing extremes
    rsiSmaCross,
    levels,
    lastSwings,
  };
}

// ─── Detect macro reversal candidates ────────────────────────────
// A counter-trend setup becomes a MACRO REVERSAL CANDIDATE when:
// 1. HTF is in extreme zone (D or W RSI > 65 for shorts, < 35 for longs)
// 2. Price is at multi-week/month high/low (within 0.5%)
// 3. OM HyperWave is in extreme zone (>80 or <20) — BONUS confidence
//
// These are potential trend-change catches at major extremes.
function checkMacroReversal(direction, price, data, htf) {
  const isLong = direction === 'long';

  // 1. HTF must be extreme (overstretched, ready to reverse) — original trigger
  const htfExtreme = isLong
    ? (htf.dRSI < 35 || htf.wRSI < 35)   // long reversal at oversold HTF
    : (htf.dRSI > 65 || htf.wRSI > 65);  // short reversal at overbought HTF

  // 2. NEW: Daily RSI/SMA cross at extreme (last 3 daily bars) — user's trigger
  const rsiCross = htf.rsiSmaCross;
  const crossMatch = rsiCross &&
    ((isLong && rsiCross.direction === 'bullish') ||
     (!isLong && rsiCross.direction === 'bearish'));

  // Fire on either trigger.
  if (!htfExtreme && !crossMatch) return null;

  // 2. Price at multi-week extreme (within 0.5% of daily high/low over ~5 months)
  const tolerance = price * 0.005;
  const atDailyExtreme = isLong
    ? (price - htf.dailyLow) <= tolerance
    : (htf.dailyHigh - price) <= tolerance;

  // Also check weekly extreme for an even stronger signal
  const atWeeklyExtreme = isLong
    ? (price - htf.weeklyLow) <= tolerance * 2
    : (htf.weeklyHigh - price) <= tolerance * 2;

  // NEW: For RSI/SMA cross trigger, allow proximity to a significant
  // multi-touch price level to satisfy the location requirement.
  let atSignificantLevel = false;
  const levelTolerance = price * 0.003;
  if (htf.levels) {
    if (isLong) {
      atSignificantLevel = (htf.levels.support || []).some(l => Math.abs(l.price - price) <= levelTolerance && l.price <= price + levelTolerance);
    } else {
      atSignificantLevel = (htf.levels.resistance || []).some(l => Math.abs(l.price - price) <= levelTolerance && l.price >= price - levelTolerance);
    }
  }

  // NEW: Approaching the last swing high (for shorts) or swing low (for longs).
  // Single-touch but structurally significant — catches "double top/bottom" forming reversals.
  let approachingLastSwing = false;
  let lastSwingInfo = null;
  const swingTolerance = price * 0.005; // within 0.5%
  if (htf.lastSwings) {
    if (isLong && htf.lastSwings.lowestSwingLow) {
      const sw = htf.lastSwings.lowestSwingLow;
      if (Math.abs(price - sw.price) <= swingTolerance && price >= sw.price - swingTolerance) {
        approachingLastSwing = true;
        lastSwingInfo = { type: 'lowestSwingLow', price: sw.price };
      }
    } else if (!isLong && htf.lastSwings.highestSwingHigh) {
      const sw = htf.lastSwings.highestSwingHigh;
      if (Math.abs(price - sw.price) <= swingTolerance && price <= sw.price + swingTolerance) {
        approachingLastSwing = true;
        lastSwingInfo = { type: 'highestSwingHigh', price: sw.price };
      }
    }
  }

  // Require: HTF-extreme OR cross OR at-significant-level OR approaching-last-swing.
  // (4HR/1HR structural confirmation is handled downstream.)
  if (!atDailyExtreme && !atWeeklyExtreme && !crossMatch && !atSignificantLevel && !approachingLastSwing) return null;

  // 3. OM HyperWave extreme (bonus confidence)
  const hw = num(data.om['HyperWave']);
  const omExtreme = isLong ? hw < 20 : hw > 80;

  // Confidence scoring
  let confidence = 'low';
  let score = 0;
  if (atWeeklyExtreme) score += 2;
  if (atDailyExtreme) score += 1;
  if (omExtreme) score += 2;
  if (htf.dRSI > 70 || htf.dRSI < 30) score += 1;
  if (htf.wRSI > 70 || htf.wRSI < 30) score += 1;
  if (crossMatch) score += 2;            // RSI/SMA cross active
  if (atSignificantLevel) score += 1;    // at a significant level

  if (score >= 5) confidence = 'high';
  else if (score >= 3) confidence = 'moderate';

  return {
    htfRSI: { d: htf.dRSI, w: htf.wRSI },
    atDailyExtreme,
    atWeeklyExtreme,
    multiWeekHigh: htf.dailyHigh,
    multiWeekLow: htf.dailyLow,
    multiMonthHigh: htf.weeklyHigh,
    multiMonthLow: htf.weeklyLow,
    distanceFromExtreme: isLong
      ? ((price - htf.dailyLow) / price * 100).toFixed(2) + '%'
      : ((htf.dailyHigh - price) / price * 100).toFixed(2) + '%',
    omExtreme,
    omHW: hw,
    confidence,
    score,
    // NEW: trigger metadata so the report + level-based TPs can use it
    rsiSmaCross: rsiCross || null,
    atSignificantLevel,
    approachingLastSwing,
    lastSwingInfo,
    levels: htf.levels || { resistance: [], support: [] },
  };
}

// ═══════════════════════════════════════════════════════════════════
// CURRENCY STRENGTH READER (Phase 5)
// Reads the 8 currency strength buckets on Daily TF.
// Each bucket = that currency's average vs the other 7.
// Cached for 4 hours since Daily values don't change fast.
// ═══════════════════════════════════════════════════════════════════
function classifyStrength(s) {
  const ts = s.trendStrength;
  const bc = s.barColor;
  const hw = s.hyperWave;
  const mf = s.moneyFlow;

  let direction = 'neutral';
  let strength = 'ranging';

  if (ts > 50) {
    if (bc > 0 && hw > 50) {
      direction = 'bullish';
      strength = (ts > 70 && hw > 60 && mf > 55) ? 'strong' : 'normal';
    } else if (bc < 0 && hw < 50) {
      direction = 'bearish';
      strength = (ts > 70 && hw < 40 && mf < 45) ? 'strong' : 'normal';
    } else {
      direction = bc >= 0 ? 'leaning_bull' : 'leaning_bear';
    }
  } else {
    // Ranging — use momentum lean only
    if (hw > 60) direction = 'leaning_bull';
    else if (hw < 40) direction = 'leaning_bear';
  }

  return { direction, strength };
}

async function readCurrencyStrengths(forceRefresh = false) {
  // Cache (4h TTL — Daily values don't change fast)
  if (!forceRefresh && existsSync(STRENGTH_CACHE)) {
    try {
      const cache = JSON.parse(readFileSync(STRENGTH_CACHE, 'utf8'));
      const ageHours = (Date.now() - cache.fetchedAt) / 3600000;
      if (ageHours < 4) {
        console.log(`  Using cached currency strengths (${ageHours.toFixed(1)}h old)`);
        return cache.strengths;
      }
    } catch (e) {}
  }

  console.log('  Reading 8 currency strength buckets (Daily TF)...');
  const strengths = {};

  // Switch to Daily
  await setTimeframe({ timeframe: 'D' });
  await sleep(SETTLE_MS);

  for (const [currency, formula] of Object.entries(CURRENCY_BUCKETS)) {
    try {
      process.stdout.write(`    ${currency}X...`);
      await setSymbol({ symbol: formula });
      await sleep(SETTLE_MS + 1000);  // formula symbols need more settle time

      const studyVals = await getStudyValues();
      const so = studyVals.studies.find(s => s.name.includes('Signals & Overlays'))?.values || {};
      const om = studyVals.studies.find(s => s.name.includes('Oscillator Matrix'))?.values || {};

      const reading = {
        trendStrength: num(so['Trend Strength']),
        barColor: num(so['Bar Color Value']),
        hyperWave: num(om['HyperWave']),
        moneyFlow: num(om['Money Flow']),
        confluence: num(om['Confluence Meter Value']),
      };

      const cls = classifyStrength(reading);
      strengths[currency] = { ...reading, ...cls };
      process.stdout.write(` ${cls.direction}${cls.strength === 'strong' ? ' (strong)' : ''}\n`);
    } catch (err) {
      process.stdout.write(` error: ${err.message}\n`);
      strengths[currency] = null;
    }
  }

  // Switch back to 4H for normal scanning
  await setTimeframe({ timeframe: '240' });
  await sleep(SETTLE_MS);

  // Cache
  writeFileSync(STRENGTH_CACHE, JSON.stringify({ fetchedAt: Date.now(), strengths }, null, 2));
  return strengths;
}

// ═══════════════════════════════════════════════════════════════════
// CONFLUENCE ASSESSMENT
// For a pair like AUDCHF + LONG: want AUD bullish + CHF bearish.
// Returns a verdict + per-currency reading.
// ═══════════════════════════════════════════════════════════════════
function assessConfluence(symbol, alertType, strengths) {
  const pair = symbol.replace('OANDA:', '');
  const base = pair.slice(0, 3);
  const quote = pair.slice(3, 6);

  const baseS = strengths[base];
  const quoteS = strengths[quote];

  if (!baseS || !quoteS) {
    return { verdict: 'unknown', score: 0, base: null, quote: null };
  }

  const isLong = alertType.includes('LONG');

  // For LONG: want base STRONG, quote WEAK
  // For SHORT: want base WEAK, quote STRONG
  const wantBaseBull = isLong;
  const wantQuoteBull = !isLong;

  // Score each side individually (-2 to +2)
  function sideScore(s, wantBull) {
    if (wantBull) {
      if (s.direction === 'bullish' && s.strength === 'strong') return 2;
      if (s.direction === 'bullish') return 1;
      if (s.direction === 'leaning_bull') return 0.5;
      if (s.direction === 'neutral') return 0;
      if (s.direction === 'leaning_bear') return -0.5;
      if (s.direction === 'bearish' && s.strength === 'strong') return -2;
      if (s.direction === 'bearish') return -1;
    } else {
      if (s.direction === 'bearish' && s.strength === 'strong') return 2;
      if (s.direction === 'bearish') return 1;
      if (s.direction === 'leaning_bear') return 0.5;
      if (s.direction === 'neutral') return 0;
      if (s.direction === 'leaning_bull') return -0.5;
      if (s.direction === 'bullish' && s.strength === 'strong') return -2;
      if (s.direction === 'bullish') return -1;
    }
    return 0;
  }

  const baseScore = sideScore(baseS, wantBaseBull);
  const quoteScore = sideScore(quoteS, wantQuoteBull);
  const score = baseScore + quoteScore;

  let verdict;
  if (score >= 3.5) verdict = 'very_strong';
  else if (score >= 2) verdict = 'strong';
  else if (score >= 1) verdict = 'partial';
  else if (score >= -0.5) verdict = 'neutral';
  else if (score >= -2) verdict = 'weak';
  else verdict = 'contradicts';

  return {
    verdict,
    score: Math.round(score * 10) / 10,
    base: { currency: base, ...baseS, score: baseScore },
    quote: { currency: quote, ...quoteS, score: quoteScore },
  };
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 3 — LTF (1HR) CONFIRMATION
// For pullback alerts: check 1HR for CHoCH in the CONT direction.
// If confirmed, promote pullback alert to actionable continuation setup
// with LTF-based SL/TP levels.
// ═══════════════════════════════════════════════════════════════════
async function checkLTFConfirmation(pair, expectedDirection) {
  // Assumes chart is already on 1HR (caller switches once for batch)
  try {
    await setSymbol({ symbol: pair });
    await sleep(SETTLE_MS);

    const [labels, ohlcv, quote] = await Promise.all([
      getPineLabels({ study_filter: 'Price Action Concepts', verbose: true, max_labels: 10 }),
      getOhlcv({ count: 60 }),
      getQuote(),
    ]);

    const BULL = 4282726130;
    const BEAR = 4286683400;
    const recent = labels.studies[0]?.labels || [];

    // Filter to structural events (BOS / CHoCH variants) — newest at end
    const structural = recent.filter(l =>
      ['BOS', 'CHoCH', 'CHoCH+'].includes(l.text)
    );

    if (structural.length === 0) {
      return { confirmed: false, reason: 'no PAC structure events on 1HR' };
    }

    // Prefer higher-tier structural events among the last few labels.
    // Priority: CHoCH+ > BOS > CHoCH. Tie-break by recency (newer wins).
    const priority = { 'CHoCH+': 3, 'BOS': 2, 'CHoCH': 1 };
    const lastFew = structural.slice(-5);
    let mostRecent = lastFew[lastFew.length - 1];
    let bestScore = -1;
    for (let i = 0; i < lastFew.length; i++) {
      const tierScore = (priority[lastFew[i].text] || 0) * 100;
      const recencyScore = i; // newer = higher index
      const total = tierScore + recencyScore;
      if (total > bestScore) {
        bestScore = total;
        mostRecent = lastFew[i];
      }
    }
    const direction = mostRecent.textColor === BULL ? 'bullish'
                    : mostRecent.textColor === BEAR ? 'bearish' : 'unknown';

    // Compute bar age by finding which 1HR bar's high/low matches the label price.
    // PAC labels are placed at swing high (bearish events) or swing low (bullish events).
    const bars = ohlcv?.bars || [];
    let barsAgo = null;
    if (bars.length > 0 && mostRecent.price != null) {
      const labelPrice = mostRecent.price;
      const isBearLabel = direction === 'bearish';
      // The PAC label price is rounded to 2 decimals — match with tolerance
      const tolerance = isBearLabel
        ? Math.max(...bars.map(b => b.high)) * 0.005
        : Math.max(...bars.map(b => b.high)) * 0.005;

      let bestMatchIdx = -1;
      let bestDist = Infinity;
      for (let i = bars.length - 1; i >= 0; i--) {
        const refPrice = isBearLabel ? bars[i].high : bars[i].low;
        const d = Math.abs(refPrice - labelPrice);
        if (d < bestDist) {
          bestDist = d;
          bestMatchIdx = i;
        }
      }
      if (bestMatchIdx >= 0) {
        barsAgo = (bars.length - 1) - bestMatchIdx;
      }
    }

    const matches = direction === expectedDirection;
    if (!matches) {
      return {
        confirmed: false,
        reason: `latest 1HR ${mostRecent.text} is ${direction}, want ${expectedDirection}`,
        latestEvent: mostRecent.text,
        latestDirection: direction,
        barsAgo,
      };
    }

    // Confirmed — get current price and calculate continuation levels
    const price = quote.close || quote.last;
    const levels = calcContinuationLevels(pair, price, bars, expectedDirection);

    return {
      confirmed: true,
      direction,
      eventType: mostRecent.text,
      eventPrice: mostRecent.price,
      barsAgo,
      currentPrice: price,
      levels,
    };
  } catch (err) {
    return { confirmed: false, reason: `error: ${err.message}` };
  }
}

function calcContinuationLevels(pair, price, bars, direction) {
  const isLong = direction === 'bullish';
  const buffer = price * 0.0005;

  // SL from recent 1HR swing low/high (8-bar lookback ≈ 32 hours of 1HR)
  const recent = bars.slice(-12);
  let sl = NaN;
  if (recent.length >= 5) {
    if (isLong) {
      let swingLow = Infinity;
      for (const b of recent) if (b.low < swingLow) swingLow = b.low;
      if (swingLow < price) sl = swingLow - buffer;
    } else {
      let swingHigh = -Infinity;
      for (const b of recent) if (b.high > swingHigh) swingHigh = b.high;
      if (swingHigh > price) sl = swingHigh + buffer;
    }
  }

  // Validate SL not too tight (must be at least 0.1% from entry)
  if (!isNaN(sl) && Math.abs(price - sl) < price * 0.001) sl = NaN;

  // SL fallback when swing-based detection failed: use 0.6% of price as breathing room.
  // For non-JPY pairs this is ~60 pips, for JPY ~60 pips — reasonable continuation stop.
  if (isNaN(sl)) {
    sl = isLong ? price - price * 0.006 : price + price * 0.006;
  }

  // TPs: R-multiple projections from SL distance.
  // Continuations break recent swing structure by definition — looking for
  // the "next swing above current price" finds nothing or a sub-pip target.
  // R-based TPs scale with the structural SL and guarantee a usable R:R.
  const slDist = !isNaN(sl) ? Math.abs(price - sl) : NaN;
  let tp1 = NaN, tp2 = NaN;
  if (!isNaN(slDist) && slDist > 0) {
    if (isLong) {
      tp1 = price + slDist * 1.5;
      tp2 = price + slDist * 3.0;
    } else {
      tp1 = price - slDist * 1.5;
      tp2 = price - slDist * 3.0;
    }
  }

  const rr1 = (!isNaN(tp1) && slDist > 0) ? Math.abs(tp1 - price) / slDist : NaN;
  const rr2 = (!isNaN(tp2) && slDist > 0) ? Math.abs(tp2 - price) / slDist : NaN;

  return { entry: price, sl, tp1, tp2, rr1, rr2 };
}

// ─── Read all indicator data for current symbol ──────────────────
async function readIndicators() {
  const [studyValues, pacLabels, pacBoxes, ohlcv] = await Promise.all([
    getStudyValues(),
    getPineLabels({ study_filter: 'Price Action Concepts', max_labels: 20, verbose: true }),
    getPineBoxes({ study_filter: 'Price Action Concepts' }),
    getOhlcv({ count: 5, summary: true }),
  ]);

  // Extract S&O values
  const soStudy = studyValues.studies.find(s => s.name.includes('Signals & Overlays'));
  const so = soStudy ? soStudy.values : {};

  // Extract PAC values
  const pacStudy = studyValues.studies.find(s => s.name.includes('Price Action Concepts'));
  const pac = pacStudy ? pacStudy.values : {};

  // Extract OM values
  const omStudy = studyValues.studies.find(s => s.name.includes('Oscillator Matrix'));
  const om = omStudy ? omStudy.values : {};

  // Extract recent PAC labels (BOS/CHoCH events)
  const pacLabelStudy = pacLabels.studies.find(s => s.name.includes('Price Action Concepts'));
  const recentLabels = pacLabelStudy ? pacLabelStudy.labels : [];

  // Extract PAC boxes (zones, OBs, FVGs)
  const pacBoxStudy = pacBoxes.studies.find(s => s.name.includes('Price Action Concepts'));
  const zones = pacBoxStudy ? pacBoxStudy.zones : [];

  return { so, pac, om, recentLabels, zones, ohlcv };
}

// ─── Parse numeric value from study string ───────────────────────
function num(val) {
  if (val == null) return NaN;
  return parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
}

// ─── Calculate SL/TP levels for a setup ──────────────────────────
function calcTargets(direction, price, data) {
  const { so, pac, recentLabels, zones, ohlcv } = data;
  const isLong = direction === 'long';

  const smartTrail = num(so['Smart Trail']);
  const soStopLoss = num(so['Stop Loss']);
  const soTakeProfit = num(so['Take Profit']);
  const premiumBot = num(pac['Premium Bottom']);
  const eqTop = num(pac['Equilibrium Top']);
  const eqBot = num(pac['Equilibrium Bottom']);
  const discountTop = num(pac['Discount Top']);

  // Buffer beyond structure (small fraction of price for safety)
  const buffer = price * 0.0005;  // 5 pips on majors, 0.5 pips on JPY adjusted by price scale

  // ── STRUCTURAL STOP LOSS HIERARCHY ──
  // 1. CONTAINING ZONE FAR BOUNDARY — if price is inside a zone, SL above (short)
  //    or below (long) that zone with buffer
  // 2. LAST SWING HIGH/LOW from OHLCV bars (lookback ~10 bars on 4H = 1.5 days)
  // 3. SMART TRAIL — only if reasonable distance, validated direction
  // 4. S&O Stop Loss plot — last resort if all else fails
  let sl = NaN;
  let slSource = '';

  // Step 1: Containing zone's far boundary
  for (const z of zones) {
    if (price >= z.low && price <= z.high) {
      sl = isLong ? (z.low - buffer) : (z.high + buffer);
      slSource = 'zone-far-boundary';
      break;
    }
  }

  // Step 2: Last swing high/low from recent OHLCV bars
  if (isNaN(sl) && ohlcv?.bars && ohlcv.bars.length >= 5) {
    const lookback = Math.min(15, ohlcv.bars.length);
    const recent = ohlcv.bars.slice(-lookback);
    if (isLong) {
      // Find the lowest low below price
      let swingLow = Infinity;
      for (const b of recent) if (b.low < swingLow) swingLow = b.low;
      if (swingLow !== Infinity && swingLow < price) {
        sl = swingLow - buffer;
        slSource = 'swing-low';
      }
    } else {
      // Find the highest high above price
      let swingHigh = -Infinity;
      for (const b of recent) if (b.high > swingHigh) swingHigh = b.high;
      if (swingHigh !== -Infinity && swingHigh > price) {
        sl = swingHigh + buffer;
        slSource = 'swing-high';
      }
    }
  }

  // Step 3: Smart Trail (only if within reasonable distance — not too tight)
  if (isNaN(sl) && !isNaN(smartTrail) && smartTrail !== price) {
    const stDist = Math.abs(price - smartTrail);
    const minDist = price * 0.001;  // need at least 10 pips on majors / 1 pip on JPY
    if (stDist >= minDist) {
      if (isLong && smartTrail < price) { sl = smartTrail; slSource = 'smart-trail'; }
      if (!isLong && smartTrail > price) { sl = smartTrail; slSource = 'smart-trail'; }
    }
  }

  // Step 4: S&O Stop Loss plot — last resort
  if (isNaN(sl) && !isNaN(soStopLoss) && soStopLoss > 0 && soStopLoss !== price) {
    const slsDist = Math.abs(price - soStopLoss);
    const minDist = price * 0.001;
    if (slsDist >= minDist) {
      if (isLong && soStopLoss < price) { sl = soStopLoss; slSource = 'so-stop'; }
      if (!isLong && soStopLoss > price) { sl = soStopLoss; slSource = 'so-stop'; }
    }
  }

  // Final validation: SL must be at least 0.1% from entry (avoids tight-SL bug)
  if (!isNaN(sl)) {
    const dist = Math.abs(price - sl);
    const minStructDist = price * 0.001;  // 10 pips on majors, 1 pip on JPY
    if (dist < minStructDist) sl = NaN;  // reject — too tight to be real structure
  }

  // ── TAKE PROFITS ──
  // TP1: S&O Take Profit plot or equilibrium level
  // TP2: Next structure level from PAC labels (BOS/CHoCH price in trade direction)
  // TP3: Next opposing zone or premium/discount boundary
  let tp1 = NaN, tp2 = NaN, tp3 = NaN;

  // TP1: S&O Take Profit or equilibrium
  if (!isNaN(soTakeProfit) && soTakeProfit > 0) {
    tp1 = soTakeProfit;
  } else if (isLong && !isNaN(eqTop)) {
    tp1 = eqTop;
  } else if (!isLong && !isNaN(eqBot)) {
    tp1 = eqBot;
  }

  // TP2: next structure level from recent labels in trade direction
  const structureLevels = recentLabels
    .filter(l => ['BOS', 'CHoCH', 'CHoCH+'].includes(l.text) && l.price != null)
    .map(l => l.price)
    .sort((a, b) => isLong ? a - b : b - a);

  for (const lvl of structureLevels) {
    if (isLong && lvl > price) { tp2 = lvl; break; }
    if (!isLong && lvl < price) { tp2 = lvl; break; }
  }

  // TP3: next opposing zone or premium/discount boundary
  if (isLong) {
    // Target: premium zone or next supply zone above
    if (!isNaN(premiumBot) && premiumBot > price) {
      tp3 = premiumBot;
    } else {
      for (const z of zones) {
        if (z.low > price) { tp3 = z.low; break; }
      }
    }
  } else {
    // Target: discount zone or next demand zone below
    if (!isNaN(discountTop) && discountTop < price) {
      tp3 = discountTop;
    } else {
      const reversed = [...zones].reverse();
      for (const z of reversed) {
        if (z.high < price) { tp3 = z.high; break; }
      }
    }
  }

  // ── R:R calculation + filter out targets too close (< 0.5R) ──
  const slDist = Math.abs(price - sl);
  const MIN_RR = 0.5;

  let rr1 = (!isNaN(tp1) && slDist > 0) ? Math.abs(tp1 - price) / slDist : NaN;
  let rr2 = (!isNaN(tp2) && slDist > 0) ? Math.abs(tp2 - price) / slDist : NaN;
  let rr3 = (!isNaN(tp3) && slDist > 0) ? Math.abs(tp3 - price) / slDist : NaN;

  // Filter: clear targets that are too close or wrong direction
  if (!isNaN(rr1) && rr1 < MIN_RR) { tp1 = NaN; rr1 = NaN; }
  if (!isNaN(rr2) && rr2 < MIN_RR) { tp2 = NaN; rr2 = NaN; }
  if (!isNaN(rr3) && rr3 < MIN_RR) { tp3 = NaN; rr3 = NaN; }

  // Validate direction: for longs TPs must be above price, for shorts below
  if (isLong) {
    if (!isNaN(tp1) && tp1 <= price) { tp1 = NaN; rr1 = NaN; }
    if (!isNaN(tp2) && tp2 <= price) { tp2 = NaN; rr2 = NaN; }
    if (!isNaN(tp3) && tp3 <= price) { tp3 = NaN; rr3 = NaN; }
    if (!isNaN(sl) && sl >= price)   { sl = NaN; }
  } else {
    if (!isNaN(tp1) && tp1 >= price) { tp1 = NaN; rr1 = NaN; }
    if (!isNaN(tp2) && tp2 >= price) { tp2 = NaN; rr2 = NaN; }
    if (!isNaN(tp3) && tp3 >= price) { tp3 = NaN; rr3 = NaN; }
    if (!isNaN(sl) && sl <= price)   { sl = NaN; }
  }

  // Collect all valid TPs, sort by distance from entry (closest first)
  const allTPs = [
    { price: tp1, rr: rr1 },
    { price: tp2, rr: rr2 },
    { price: tp3, rr: rr3 },
  ].filter(t => !isNaN(t.price) && !isNaN(t.rr));

  // Sort: for longs, closest above price first; for shorts, closest below price first
  allTPs.sort((a, b) => {
    const distA = Math.abs(a.price - price);
    const distB = Math.abs(b.price - price);
    return distA - distB;
  });

  // Reassign TP1 (nearest), TP2 (mid), TP3 (furthest)
  tp1 = allTPs[0]?.price ?? NaN;  rr1 = allTPs[0]?.rr ?? NaN;
  tp2 = allTPs[1]?.price ?? NaN;  rr2 = allTPs[1]?.rr ?? NaN;
  tp3 = allTPs[2]?.price ?? NaN;  rr3 = allTPs[2]?.rr ?? NaN;

  // R-multiple fallback: if structural sources didn't produce TPs and we have
  // a valid SL, project 1.5R / 3R / 5R from entry. Preserves structural priority
  // when available; guarantees actionable targets when not.
  if (!isNaN(sl) && slDist > 0) {
    const dir = isLong ? 1 : -1;
    if (isNaN(tp1)) { tp1 = price + dir * slDist * 1.5; rr1 = 1.5; }
    if (isNaN(tp2)) { tp2 = price + dir * slDist * 3.0; rr2 = 3.0; }
    if (isNaN(tp3)) { tp3 = price + dir * slDist * 5.0; rr3 = 5.0; }
  }

  return { sl, tp1, tp2, tp3, rr1, rr2, rr3 };
}

// ─── Analyze a single pair ───────────────────────────────────────
function analyzeSetup(symbol, price, data) {
  const { so, pac, om, recentLabels, zones } = data;
  const alerts = [];

  // ── S&O readings ──
  const trendStrength = num(so['Trend Strength']);
  const barColor = num(so['Bar Color Value']);
  const smartTrail = num(so['Smart Trail']);
  const bullSignal = num(so['Bullish']);
  const bearSignal = num(so['Bearish']);
  const bullPlus = num(so['Bullish+']);
  const bearPlus = num(so['Bearish+']);

  // Trend direction from S&O
  const soTrendBull = barColor > 0;
  const soTrendBear = barColor < 0;
  const soTrending = trendStrength > 50;

  // ── OM readings ──
  const hyperWave = num(om['HyperWave']);
  const moneyFlow = num(om['Money Flow']);
  const confluence = num(om['Confluence Meter Value']);
  const hwUp = num(om['HWO Up']);
  const hwDown = num(om['HWO Down']);

  const omBullish = hyperWave > 50 || moneyFlow > 50;
  const omBearish = hyperWave < 50 || moneyFlow < 50;
  const omOverbought = hyperWave > 80;
  const omOversold = hyperWave < 20;

  // ── PAC readings ──
  const premiumBot = num(pac['Premium Bottom']);
  const eqTop = num(pac['Equilibrium Top']);
  const eqBot = num(pac['Equilibrium Bottom']);
  const discountTop = num(pac['Discount Top']);

  const inPremium = !isNaN(premiumBot) && price > premiumBot;
  const inDiscount = !isNaN(discountTop) && price < discountTop;
  const inEQ = !isNaN(eqTop) && !isNaN(eqBot) && price >= eqBot && price <= eqTop;

  // ── Recent structure events from labels ──
  // PAC uses textColor to distinguish bullish (teal) vs bearish (red) labels.
  // We detect the two distinct colors and assign direction based on which color
  // appears on labels at lower prices (bullish) vs higher prices (bearish).
  const BULLISH_COLOR = 4282726130;   // teal/green in LuxAlgo PAC
  const BEARISH_COLOR = 4286683400;   // red/gray in LuxAlgo PAC

  const isBull = l => l.textColor === BULLISH_COLOR;
  const isBear = l => l.textColor === BEARISH_COLOR;

  const bullishBOS = recentLabels.filter(l => l.text === 'BOS' && isBull(l));
  const bearishBOS = recentLabels.filter(l => l.text === 'BOS' && isBear(l));
  const bullishCHoCH = recentLabels.filter(l => (l.text === 'CHoCH' || l.text === 'CHoCH+') && isBull(l));
  const bearishCHoCH = recentLabels.filter(l => (l.text === 'CHoCH' || l.text === 'CHoCH+') && isBear(l));

  // Last structure event determines current direction
  const allStructure = recentLabels.filter(l => ['BOS', 'CHoCH', 'CHoCH+'].includes(l.text));
  const lastStructure = allStructure.length > 0 ? allStructure[allStructure.length - 1] : null;
  const lastStructureBullish = lastStructure ? isBull(lastStructure) : null;
  const lastStructureBearish = lastStructure ? isBear(lastStructure) : null;

  // ── Check if price is near a zone ──
  let nearZone = null;
  let zoneType = null;
  for (const z of zones) {
    const dist = Math.min(Math.abs(price - z.high), Math.abs(price - z.low));
    const zoneSize = Math.abs(z.high - z.low);
    const threshold = zoneSize * 2 || price * 0.002; // within 2x zone size or 0.2%

    if (price >= z.low && price <= z.high) {
      nearZone = z;
      zoneType = 'inside';
      break;
    } else if (dist < threshold) {
      nearZone = z;
      zoneType = price < z.low ? 'approaching_demand' : 'approaching_supply';
    }
  }

  // ── Smart Trail position ──
  const aboveTrail = !isNaN(smartTrail) && price > smartTrail;
  const belowTrail = !isNaN(smartTrail) && price < smartTrail;

  // ═══════════════════════════════════════════════════════════════
  // SETUP DETECTION
  // ═══════════════════════════════════════════════════════════════

  // ── REVERSAL LONG ──
  // Price in discount/demand zone + BULLISH CHoCH + OM oversold or shifting
  if (inDiscount || (nearZone && zoneType === 'inside' && !isNaN(eqBot) && price < eqBot)) {
    const bullChoch = bullishCHoCH.length > 0;
    const omShifting = omOversold || (hyperWave < 30 && moneyFlow < 45);
    // Structure should be shifting bullish (last event bullish, or bullish CHoCH present)
    const structureAligning = bullChoch || lastStructureBullish;

    if (structureAligning || omShifting) {
      const targets = calcTargets('long', price, data);
      const strength = (bullChoch ? 2 : 0) + (omOversold ? 2 : 0) + (nearZone ? 1 : 0) + (belowTrail ? 1 : 0);
      alerts.push({
        type: 'REVERSAL LONG',
        strength: Math.min(strength, 5),
        details: [
          inDiscount ? 'In discount zone' : 'Price in demand area',
          nearZone ? `Near zone ${nearZone.low.toFixed(4)}-${nearZone.high.toFixed(4)}` : null,
          bullChoch ? `Bullish CHoCH detected (${bullishCHoCH.length})` : (lastStructureBullish ? 'Last structure event: bullish' : 'No bullish CHoCH yet — watch for it'),
          omOversold ? `OM oversold (HW: ${hyperWave.toFixed(1)})` : `OM: HW ${hyperWave.toFixed(1)}`,
          belowTrail ? `Below Smart Trail (${smartTrail.toFixed(4)})` : null,
        ].filter(Boolean),
        targets,
        action: bullChoch
          ? 'Drop to 1HR — look for bullish structure confirmation to enter long'
          : 'Watch for BULLISH CHoCH on 4HR — setup forming',
      });
    }
  }

  // ── REVERSAL SHORT ──
  // Price in premium/supply zone + BEARISH CHoCH + OM overbought or shifting
  if (inPremium || (nearZone && zoneType === 'inside' && !isNaN(eqTop) && price > eqTop)) {
    const bearChoch = bearishCHoCH.length > 0;
    const omShifting = omOverbought || (hyperWave > 70 && moneyFlow > 55);
    const structureAligning = bearChoch || lastStructureBearish;

    if (structureAligning || omShifting) {
      const targets = calcTargets('short', price, data);
      const strength = (bearChoch ? 2 : 0) + (omOverbought ? 2 : 0) + (nearZone ? 1 : 0) + (aboveTrail ? 1 : 0);
      alerts.push({
        type: 'REVERSAL SHORT',
        strength: Math.min(strength, 5),
        details: [
          inPremium ? 'In premium zone' : 'Price in supply area',
          nearZone ? `Near zone ${nearZone.low.toFixed(4)}-${nearZone.high.toFixed(4)}` : null,
          bearChoch ? `Bearish CHoCH detected (${bearishCHoCH.length})` : (lastStructureBearish ? 'Last structure event: bearish' : 'No bearish CHoCH yet — watch for it'),
          omOverbought ? `OM overbought (HW: ${hyperWave.toFixed(1)})` : `OM: HW ${hyperWave.toFixed(1)}`,
          aboveTrail ? `Above Smart Trail (${smartTrail.toFixed(4)})` : null,
        ].filter(Boolean),
        targets,
        action: bearChoch
          ? 'Drop to 1HR — look for bearish structure confirmation to enter short'
          : 'Watch for BEARISH CHoCH on 4HR — setup forming',
      });
    }
  }

  // ── CONTINUATION LONG ──
  // HTF bullish + price pulling back (OM dipping but not bearish) + near S&O trail or zone
  if (soTrendBull && soTrending && omBullish && !omOverbought) {
    const pullingBack = barColor <= 0;  // purple or red candle in bull trend = pullback
    const nearTrail = !isNaN(smartTrail) && Math.abs(price - smartTrail) / price < 0.003;

    if (pullingBack || nearTrail) {
      const targets = calcTargets('long', price, data);
      const strength = (soTrending ? 1 : 0) + (omBullish ? 1 : 0) + (nearTrail ? 2 : 0) + (pullingBack ? 1 : 0);
      alerts.push({
        type: 'CONTINUATION LONG',
        strength: Math.min(strength, 5),
        details: [
          `Trend: bullish (strength ${trendStrength.toFixed(0)}%)`,
          `OM: HW ${hyperWave.toFixed(1)}, MF ${moneyFlow.toFixed(1)}`,
          pullingBack ? 'Candle pulling back (purple/red in bull trend)' : null,
          nearTrail ? `Near Smart Trail support (${smartTrail.toFixed(4)})` : null,
          nearZone ? `Near zone ${nearZone.low.toFixed(4)}-${nearZone.high.toFixed(4)}` : null,
          confluence > 60 ? `Strong confluence (${confluence.toFixed(0)}%)` : null,
        ].filter(Boolean),
        targets,
        action: 'Look for bounce off Smart Trail or zone — enter long on confirmation',
      });
    }
  }

  // ── CONTINUATION SHORT ──
  if (soTrendBear && soTrending && omBearish && !omOversold) {
    const pullingBack = barColor >= 0;  // purple or green candle in bear trend = pullback
    const nearTrail = !isNaN(smartTrail) && Math.abs(price - smartTrail) / price < 0.003;

    if (pullingBack || nearTrail) {
      const targets = calcTargets('short', price, data);
      const strength = (soTrending ? 1 : 0) + (omBearish ? 1 : 0) + (nearTrail ? 2 : 0) + (pullingBack ? 1 : 0);
      alerts.push({
        type: 'CONTINUATION SHORT',
        strength: Math.min(strength, 5),
        details: [
          `Trend: bearish (strength ${trendStrength.toFixed(0)}%)`,
          `OM: HW ${hyperWave.toFixed(1)}, MF ${moneyFlow.toFixed(1)}`,
          pullingBack ? 'Candle pulling back (purple/green in bear trend)' : null,
          nearTrail ? `Near Smart Trail resistance (${smartTrail.toFixed(4)})` : null,
          nearZone ? `Near zone ${nearZone.low.toFixed(4)}-${nearZone.high.toFixed(4)}` : null,
          confluence < 40 ? `Strong bearish confluence (${confluence.toFixed(0)}%)` : null,
        ].filter(Boolean),
        targets,
        action: 'Look for rejection off Smart Trail or zone — enter short on confirmation',
      });
    }
  }

  // Deduplicate: if same direction (both long or both short) appears twice,
  // keep the one with higher strength. Different directions can coexist.
  const deduped = [];
  for (const alert of alerts) {
    const dir = alert.type.includes('LONG') ? 'LONG' : 'SHORT';
    const existing = deduped.find(a =>
      (a.type.includes('LONG') ? 'LONG' : 'SHORT') === dir
    );
    if (existing) {
      // Keep the higher strength one; if tied, prefer reversal over continuation
      if (alert.strength > existing.strength ||
         (alert.strength === existing.strength && alert.type.includes('REVERSAL'))) {
        deduped.splice(deduped.indexOf(existing), 1, alert);
      }
    } else {
      deduped.push(alert);
    }
  }

  return deduped;
}

// ─── Format alert for console output ─────────────────────────────
function fmtPrice(v, digits = 4) {
  return (v == null || isNaN(v)) ? '—' : v.toFixed(digits);
}
function fmtRR(v) {
  return (v == null || isNaN(v)) ? '—' : v.toFixed(1) + 'R';
}

function formatAlert(symbol, price, alert) {
  const stars = '★'.repeat(alert.strength) + '☆'.repeat(5 - alert.strength);
  const d = symbol.includes('JPY') ? 2 : 4;  // JPY pairs use 2 decimal places
  const t = alert.targets || {};

  const lines = [
    ``,
    `${'═'.repeat(60)}`,
    `  ${alert.type}  ${stars}  ${shortName(symbol)} @ ${price.toFixed(d)}`,
    `${'═'.repeat(60)}`,
    ...alert.details.map(det => `  • ${det}`),
    ``,
  ];

  // Add targets section if available
  if (t.sl || t.tp1 || t.tp2 || t.tp3) {
    lines.push(`  ── Levels ──`);
    if (!isNaN(t.sl))  lines.push(`  SL:  ${fmtPrice(t.sl, d)}  (risk: ${fmtPrice(Math.abs(price - t.sl), d)})`);
    if (!isNaN(t.tp1)) lines.push(`  TP1: ${fmtPrice(t.tp1, d)}  ${fmtRR(t.rr1)}`);
    if (!isNaN(t.tp2)) lines.push(`  TP2: ${fmtPrice(t.tp2, d)}  ${fmtRR(t.rr2)}`);
    if (!isNaN(t.tp3)) lines.push(`  TP3: ${fmtPrice(t.tp3, d)}  ${fmtRR(t.rr3)}`);
    lines.push(``);
  }

  // Add news warnings if any
  const news = alert.newsWarnings || [];
  if (news.length > 0) {
    lines.push(`  ── ⚠ News Risk ──`);
    for (const n of news) {
      const tag = n.urgency === 'IMMINENT' ? '🔴' : n.urgency === 'TODAY' ? '🟡' : '🟠';
      lines.push(`  ${tag} ${n.urgency} (${n.hoursUntil}h): ${n.currency} ${n.title}`);
      lines.push(`     ${n.time}  |  Forecast: ${n.forecast}  |  Previous: ${n.previous}`);
      if (n.impact) {
        const imp = n.impact;
        lines.push(`     Last impact (~${imp.prevDate}): ${imp.movePips} pips ${imp.direction} (${imp.ratio}x avg range of ${imp.avgPips} pips)`);
        if (imp.context) {
          const ctx = imp.context;
          lines.push(`     Setup was: ${ctx.preTrend}, in ${ctx.rangePosition}, momentum ${ctx.preMomentum}`);
          lines.push(`     News ${ctx.newsOutcome} → then ${ctx.followThrough}`);
        }
      }
    }
    lines.push(``);
  }

  lines.push(`  → ${alert.action}`);
  lines.push(`${'─'.repeat(60)}`);

  return lines.join('\n');
}

// ─── Main scan loop ──────────────────────────────────────────────
async function scanAll(pairs) {
  const allAlerts = [];

  // Fetch high-impact news for the week
  const newsEvents = await getHighImpactNews();
  if (newsEvents.length > 0) {
    console.log(`  ${newsEvents.length} high-impact events this week\n`);
  }

  // Read 8 currency strength buckets (Phase 5) — cached 4h
  const strengths = await readCurrencyStrengths();

  console.log(`\n[${now()}] Scanning ${pairs.length} pairs...\n`);

  for (const pair of pairs) {
    const sym = shortName(pair);
    process.stdout.write(`  Scanning ${sym}...`);

    try {
      // Switch to pair
      await setSymbol({ symbol: pair });
      await sleep(SETTLE_MS);

      // Get price
      const quote = await getQuote();
      const price = quote.close || quote.last;

      if (!price) {
        console.log(' no price data, skipping');
        continue;
      }

      // Read indicators
      const data = await readIndicators();

      // Analyze
      const alerts = analyzeSetup(pair, price, data);

      // Always fetch HTF — needed to detect Daily RSI/SMA cross even on no-other-setup pairs.
      const htf = await getHTFTrend();

      // If a Daily RSI/SMA cross fired and no alert in that direction exists yet, synthesize one.
      if (htf.rsiSmaCross) {
        const crossDir = htf.rsiSmaCross.direction;
        const wantType = crossDir === 'bearish' ? 'REVERSAL SHORT' : 'REVERSAL LONG';
        if (!alerts.some(a => a.type === wantType)) {
          alerts.push({
            type: wantType,
            strength: 2,
            details: [`Daily RSI/SMA cross ${crossDir} at RSI ${htf.rsiSmaCross.rsiAtCross.toFixed(1)} (${htf.rsiSmaCross.barsAgo}b ago)`],
            targets: { sl: NaN, tp1: NaN, tp2: NaN, tp3: NaN, rr1: NaN, rr2: NaN, rr3: NaN },
            action: 'Daily RSI/SMA cross — drop to 4HR for CHoCH/BOS confirmation, then 1HR entry',
            rsiCrossSynthetic: true,
          });
        }
      }

      if (alerts.length > 0) {
        console.log(` ${alerts.length} setup(s) found! [HTF: D=${htf.dRSI} W=${htf.wRSI} → ${htf.htfBullish ? 'BULL' : htf.htfBearish ? 'BEAR' : 'mixed'}]`);

        for (const a of alerts) {
          a.htf = htf;
          const isLong = a.type.includes('LONG');
          const aligned = (isLong && htf.htfBullish) || (!isLong && htf.htfBearish);
          a.htfAligned = aligned;

          // Counter-trend setup: check if it's a macro reversal candidate first
          if (!aligned) {
            const macroRev = checkMacroReversal(isLong ? 'long' : 'short', price, data, htf);

            if (macroRev) {
              // MACRO REVERSAL CANDIDATE — potential trend change at extreme
              a.macroReversal = true;
              a.macroContext = macroRev;

              // Fallback PAC freshness check via current-price proximity (covers cases
              // where no structural entryZone gets computed). Any unmitigated PAC box
              // near current price = active institutional zone.
              if (data.zones && data.zones.length > 0) {
                const tol = price * 0.003;
                a.pacFresh = data.zones.some(pz =>
                  Math.abs((pz.high + pz.low) / 2 - price) <= tol
                );
              } else {
                a.pacFresh = false;
              }
              // Star cap based on confidence: high=3, moderate=2, low=1
              const cap = macroRev.confidence === 'high' ? 3
                        : macroRev.confidence === 'moderate' ? 2 : 1;
              a.strength = Math.min(cap, a.strength);

              // Build the trade plan from structural levels:
              //   entry = nearest level we expect price to reject from (limit order zone)
              //   SL    = next level past entry + buffer (invalidation if level breaks)
              //   TP1/2/3 = cascading levels in the reversal direction
              const levels = macroRev.levels;
              const buffer = price * 0.002;
              if (levels && (levels.resistance.length || levels.support.length)) {
                let entryLevel = null, entryZone = null, sl = null, tp1 = null, tp2 = null, tp3 = null;
                // Cap how far a suggested limit-order entry can be from current price (1.5%).
                const maxLimitDist = price * 0.015;
                if (isLong) {
                  // REV LONG: prefer support strictly BELOW current as limit entry; fall back to current price if no nearby level.
                  const supportsBelow = levels.support
                    .filter(l => l.price < price && (price - l.price) <= maxLimitDist)
                    .sort((x, y) => y.price - x.price);
                  const chosen = supportsBelow[0];
                  const entry = chosen?.price ?? price;
                  entryLevel = chosen?.price ?? null;
                  entryZone = chosen ? { low: chosen.low, high: chosen.high } : null;
                  // SL: next support BELOW entry, with buffer.
                  const supportsFurtherBelow = levels.support.filter(l => l.price < entry - buffer).sort((x, y) => y.price - x.price);
                  if (supportsFurtherBelow[0]) sl = supportsFurtherBelow[0].price - buffer;
                  // TPs: cascading resistances above entry.
                  const above = levels.resistance.filter(l => l.price > entry + buffer).sort((x, y) => x.price - y.price);
                  if (above[0]) tp1 = above[0].price;
                  if (above[1]) tp2 = above[1].price;
                  if (above[2]) tp3 = above[2].price;
                } else {
                  // REV SHORT: prefer resistance strictly ABOVE current as limit entry; fall back to current price if no nearby level.
                  const resistAbove = levels.resistance
                    .filter(l => l.price > price && (l.price - price) <= maxLimitDist)
                    .sort((x, y) => x.price - y.price);
                  const chosen = resistAbove[0];
                  const entry = chosen?.price ?? price;
                  entryLevel = chosen?.price ?? null;
                  entryZone = chosen ? { low: chosen.low, high: chosen.high } : null;
                  const resistFurtherAbove = levels.resistance.filter(l => l.price > entry + buffer).sort((x, y) => x.price - y.price);
                  if (resistFurtherAbove[0]) sl = resistFurtherAbove[0].price + buffer;
                  const below = levels.support.filter(l => l.price < entry - buffer).sort((x, y) => y.price - x.price);
                  if (below[0]) tp1 = below[0].price;
                  if (below[1]) tp2 = below[1].price;
                  if (below[2]) tp3 = below[2].price;
                }
                // SL fallback when no further structural level was found:
                // use entry zone + ~5× zone width buffer (structurally meaningful), or
                // entry + 0.5% if no zone. Catches the AUDCAD-style "no resistance above" gap.
                if (entryLevel != null && sl == null) {
                  if (entryZone) {
                    const zoneWidth = Math.max(entryZone.high - entryZone.low, price * 0.0005);
                    sl = isLong
                      ? entryZone.low - zoneWidth * 5
                      : entryZone.high + zoneWidth * 5;
                  } else {
                    sl = isLong ? entryLevel - entryLevel * 0.005 : entryLevel + entryLevel * 0.005;
                  }
                }

                // Only override calcTargets when we found a structural level for entry.
                if (entryLevel != null) {
                  a.entryLevel = entryLevel;
                  a.entryZone = entryZone;
                  // PAC freshness via zone overlap (preferred when a structural zone exists).
                  if (entryZone && data.zones && data.zones.length > 0) {
                    a.pacFresh = data.zones.some(pz =>
                      pz.high >= entryZone.low && pz.low <= entryZone.high
                    );
                  }
                  const refPrice = entryLevel;
                  const slDist = sl != null ? Math.abs(refPrice - sl) : NaN;
                  const rr1 = (tp1 != null && slDist > 0) ? Math.abs(tp1 - refPrice) / slDist : NaN;
                  const rr2 = (tp2 != null && slDist > 0) ? Math.abs(tp2 - refPrice) / slDist : NaN;
                  const rr3 = (tp3 != null && slDist > 0) ? Math.abs(tp3 - refPrice) / slDist : NaN;
                  a.targets = { sl, tp1, tp2, tp3, rr1, rr2, rr3 };
                  a.tpSource = 'levels';
                }
              }
            } else {
              // Just a pullback against trend
              a.pullbackAlert = true;
              a.originalType = a.type;
              a.suggestedDirection = isLong ? 'CONTINUATION SHORT' : 'CONTINUATION LONG';
              a.strength = Math.max(1, Math.min(2, a.strength - 2));
            }
          }

          a.newsWarnings = getNewsWarnings(pair, newsEvents);
          if (a.newsWarnings.length > 0) {
            const impact = await measureNewsImpact(pair, a.newsWarnings[0].title, a.newsWarnings[0].currency);
            if (impact) {
              for (const w of a.newsWarnings) w.impact = impact;
            }
          }

          // Phase 5: Currency Strength Confluence
          a.confluence = assessConfluence(pair, a.type, strengths);

          // Level-proximity check: flag continuation signals approaching major opposing
          // long-history levels. Cap strength at 3★ when within 0.5% of an opposing
          // multi-touch level (resistance for longs, support for shorts).
          if (htf?.levels && a.type.includes('CONTINUATION')) {
            const tol = price * 0.005;
            const opposing = isLong
              ? (htf.levels.resistance || []).find(l => l.price > price && (l.price - price) <= tol)
              : (htf.levels.support || []).find(l => l.price < price && (price - l.price) <= tol);
            if (opposing) {
              a.nearOpposingLevel = { price: opposing.price, touches: opposing.touches };
              a.strength = Math.min(a.strength, 3);
            }
          }

          allAlerts.push({ symbol: pair, price, alert: a });
        }
      } else {
        console.log(' no setups');
      }
    } catch (err) {
      console.log(` error: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3 — LTF (1HR) CONFIRMATION for pullback alerts
  // After 4H scan complete, batch-check pullback alerts on 1HR.
  // ═══════════════════════════════════════════════════════════════
  const pullbackToCheck = allAlerts.filter(a => a.alert.pullbackAlert);
  if (pullbackToCheck.length > 0) {
    console.log(`\n[${now()}] Phase 3: Checking 1HR confirmation for ${pullbackToCheck.length} pullback alerts...`);

    // Switch to 1HR once for the batch
    await setTimeframe({ timeframe: '60' });
    await sleep(SETTLE_MS);

    for (const item of pullbackToCheck) {
      const sym = shortName(item.symbol);
      process.stdout.write(`  ${sym}...`);

      // Expected direction: the OPPOSITE of original (CONT direction)
      const isLong = item.alert.type.includes('LONG');
      const expectedDirection = isLong ? 'bearish' : 'bullish';

      const ltf = await checkLTFConfirmation(item.symbol, expectedDirection);

      if (ltf.confirmed) {
        // PROMOTE to actionable continuation setup
        item.alert.ltfConfirmed = true;
        item.alert.ltfEvent = ltf.eventType;
        item.alert.ltfEventPrice = ltf.eventPrice;
        item.alert.ltfBarsAgo = ltf.barsAgo;
        item.alert.continuationLevels = ltf.levels;
        item.alert.continuationDirection = ltf.direction;
        // Update stars based on confirmation (3 stars baseline for confirmed CONT)
        // Boost to 4★ if the confirmation is fresh (within last 3 1HR bars)
        if (ltf.barsAgo != null && ltf.barsAgo <= 3) {
          item.alert.strength = Math.max(4, item.alert.strength);
        } else {
          item.alert.strength = Math.max(3, item.alert.strength);
        }

        // Level-proximity check for the LTF-confirmed direction.
        const htf = item.alert.htf;
        const effLong = ltf.direction === 'bullish';
        if (htf?.levels) {
          const tol = item.price * 0.005;
          const opposing = effLong
            ? (htf.levels.resistance || []).find(l => l.price > item.price && (l.price - item.price) <= tol)
            : (htf.levels.support || []).find(l => l.price < item.price && (item.price - l.price) <= tol);
          if (opposing) {
            item.alert.nearOpposingLevel = { price: opposing.price, touches: opposing.touches };
            item.alert.strength = Math.min(item.alert.strength, 3);
          }
        }

        const ageStr = ltf.barsAgo != null ? ` ${ltf.barsAgo}b ago` : '';
        console.log(` ✅ CONFIRMED (${ltf.eventType} ${ltf.direction}${ageStr})`);
      } else {
        console.log(` waiting (${ltf.reason})`);
      }
    }

    // Switch back to 4H
    await setTimeframe({ timeframe: '240' });
    await sleep(SETTLE_MS);
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3b — 1HR confirmation for MACRO REVERSAL candidates.
  // For reversals at historic levels: the 4HR CHoCH is the trigger,
  // 1HR CHoCH/BOS in the SAME direction confirms entry.
  // ═══════════════════════════════════════════════════════════════
  const macroToCheck = allAlerts.filter(a => a.alert.macroReversal);
  if (macroToCheck.length > 0) {
    console.log(`\n[${now()}] Phase 3b: Checking 1HR confirmation for ${macroToCheck.length} macro reversal candidates...`);
    const phase3bStart = Date.now();
    await setTimeframe({ timeframe: '60' });
    await sleep(SETTLE_MS);

    for (const item of macroToCheck) {
      const sym = shortName(item.symbol);
      process.stdout.write(`  ${sym}...`);

      // Expected direction: SAME as the original reversal alert (not flipped).
      const isLong = item.alert.type.includes('LONG');
      const expectedDirection = isLong ? 'bullish' : 'bearish';

      const ltf = await checkLTFConfirmation(item.symbol, expectedDirection);
      if (ltf.confirmed) {
        item.alert.ltfConfirmed = true;
        item.alert.ltfEvent = ltf.eventType;
        item.alert.ltfEventPrice = ltf.eventPrice;
        item.alert.ltfBarsAgo = ltf.barsAgo;
        // Fresh confirmation boosts to 4★, otherwise 3★ floor.
        if (ltf.barsAgo != null && ltf.barsAgo <= 3) {
          item.alert.strength = Math.max(4, item.alert.strength);
        } else {
          item.alert.strength = Math.max(3, item.alert.strength);
        }
        const ageStr = ltf.barsAgo != null ? ` ${ltf.barsAgo}b ago` : '';
        console.log(` ✅ CONFIRMED REVERSAL (${ltf.eventType} ${ltf.direction}${ageStr})`);
      } else {
        console.log(` waiting (${ltf.reason})`);
      }
    }

    await setTimeframe({ timeframe: '240' });
    await sleep(SETTLE_MS);

    // Op-health: phase 3b averages 2-3min over 5-7 candidates; flag if it
    // ever exceeds 5min so dev can profile chart-switch overhead or settle
    // waits before they compound into a real throughput problem on Azure.
    const phase3bSec = (Date.now() - phase3bStart) / 1000;
    if (phase3bSec > 300) {
      observe({
        type: 'op_health',
        severity: 'warn',
        message: `Phase 3b took ${phase3bSec.toFixed(0)}s (>5min threshold)`,
        data: {
          candidates: macroToCheck.length,
          perCandidateSec: (phase3bSec / Math.max(macroToCheck.length, 1)).toFixed(1),
          settleMs: SETTLE_MS,
        },
      });
    }
  }

  return allAlerts;
}

// ─── News Catalyst Lens helpers ──────────────────────────────────
// Parse a news value string (e.g. "0.6%", "118K", "<1.00%") to a number, or null.
function parseNewsValue(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (s === '' || s === '—' || s === '-') return null;
  s = s.replace(/^[<>]/, '').replace(/%$/, '').trim();
  let mult = 1;
  if (s.endsWith('K')) { mult = 1000; s = s.slice(0, -1); }
  else if (s.endsWith('M')) { mult = 1000000; s = s.slice(0, -1); }
  else if (s.endsWith('B')) { mult = 1000000000; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isNaN(n) ? null : n * mult;
}

// Infer currency strength/weakness direction from forecast-vs-previous + title rules.
function inferCatalystDirection(event) {
  const f = parseNewsValue(event.forecast);
  const p = parseNewsValue(event.previous);
  if (f === null || p === null) return null;
  // Events where higher value = currency WEAKNESS (rare — mainly unemployment-style)
  const title = event.title.toLowerCase();
  const inverted = title.includes('unemployment') || title.includes('jobless') || title.includes('claimant');
  const diff = f - p;
  if (diff === 0) return 'neutral';
  const strengthening = inverted ? diff < 0 : diff > 0;
  return strengthening ? 'strength' : 'weakness';
}

// Tailwind/headwind/neutral for a given setup direction + which side the news is on.
function catalystAlignment(setupType, side, direction) {
  if (!direction || direction === 'neutral') return 'neutral';
  const isLong = setupType.includes('LONG');
  const isBase = side === 'base';
  if (isLong) {
    if (isBase) return direction === 'strength' ? 'tailwind' : 'headwind';
    return direction === 'weakness' ? 'tailwind' : 'headwind';
  } else {
    if (isBase) return direction === 'weakness' ? 'tailwind' : 'headwind';
    return direction === 'strength' ? 'tailwind' : 'headwind';
  }
}

// Evaluate the 5 entry gates + catalyst alignment for a macro reversal alert.
// Returns { allGreen, gates, catalystStatus, tailwinds, headwinds }.
function evaluateGates(symbol, alert, newsEvents) {
  const phase3b = alert.ltfConfirmed === true;
  const pacFresh = alert.pacFresh === true;
  const conf = alert.macroContext?.confidence;
  const confidenceOK = alert.strength >= 3 && (conf === 'moderate' || conf === 'high');
  const noOpposingLevel = !alert.nearOpposingLevel;
  // Imminent news: anything in next 4 hours on the pair
  const newsClear = !(alert.newsWarnings || []).some(w => {
    const h = parseFloat(w.hoursUntil);
    return h >= -2 && h < 4;
  });

  // Catalyst alignment over 7-day window — with chronological ordering.
  // The FIRST actionable catalyst (tailwind or headwind) hits during the trade's
  // active life and matters more than the total count. Later catalysts can be
  // exited before via active trade management.
  let tailwinds = 0, headwinds = 0;
  let firstActionable = null;
  if (newsEvents && newsEvents.length > 0) {
    const catalysts = getCatalystWindow(symbol, newsEvents, 168);
    const annotated = catalysts.map(c => {
      const dir = inferCatalystDirection(c);
      const align = catalystAlignment(alert.type, c.side, dir);
      return { ...c, align };
    });
    for (const c of annotated) {
      if (c.align === 'tailwind') tailwinds++;
      else if (c.align === 'headwind') headwinds++;
    }
    firstActionable = annotated
      .filter(c => c.align === 'tailwind' || c.align === 'headwind')
      .sort((a, b) => a.hoursUntil - b.hoursUntil)[0] || null;
  }

  // catalystStatus reflects the FIRST actionable catalyst (timing matters).
  let catalystStatus = 'neutral';
  if (firstActionable) catalystStatus = firstActionable.align;

  const allGatesPass = phase3b && pacFresh && confidenceOK && noOpposingLevel && newsClear;
  // ALL GREEN: all gates + first catalyst is favorable (tailwind or no actionable catalysts).
  // Later headwinds don't block ALL GREEN because the trader manages position before they hit.
  const allGreen = allGatesPass && catalystStatus !== 'headwind';

  return {
    allGreen,
    allGatesPass,
    gates: { phase3b, pacFresh, confidenceOK, noOpposingLevel, newsClear },
    catalystStatus,
    tailwinds,
    headwinds,
    firstActionable,
  };
}

// Get high-impact events affecting either side of the pair within `hoursWindow` (default 7 days).
function getCatalystWindow(symbol, newsEvents, hoursWindow = 168) {
  const pair = shortName(symbol);
  const baseCcy = pair.slice(0, 3);
  const quoteCcy = pair.slice(3, 6);
  const nowMs = Date.now();
  const out = [];
  for (const event of (newsEvents || [])) {
    if (event.currency !== baseCcy && event.currency !== quoteCcy) continue;
    const eventTime = new Date(event.date).getTime();
    const hoursUntil = (eventTime - nowMs) / 3600000;
    if (hoursUntil < -2 || hoursUntil > hoursWindow) continue;
    out.push({
      ...event,
      hoursUntil,
      side: event.currency === baseCcy ? 'base' : 'quote',
    });
  }
  out.sort((a, b) => a.hoursUntil - b.hoursUntil);
  return out;
}

// ─── Report ──────────────────────────────────────────────────────
async function printReport(allAlerts) {
  if (allAlerts.length === 0) {
    console.log(`\n[${now()}] No setups found across all pairs.\n`);
    return;
  }

  // Sort by strength (highest first), then by best R:R
  allAlerts.sort((a, b) => {
    if (b.alert.strength !== a.alert.strength) return b.alert.strength - a.alert.strength;
    const rrA = a.alert.targets?.rr3 || a.alert.targets?.rr2 || a.alert.targets?.rr1 || 0;
    const rrB = b.alert.targets?.rr3 || b.alert.targets?.rr2 || b.alert.targets?.rr1 || 0;
    return rrB - rrA;
  });

  // Calculate expiry time for each setup (72 market hours from now)
  const expiryLabel = () => {
    const exp = new Date(Date.now() + 72 * 3600 * 1000); // rough estimate, doesn't skip weekends for display
    return exp.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  };

  // Split into 4 categories (Phase 3 adds confirmed continuations)
  const alignedAlerts = allAlerts.filter(a => !a.alert.pullbackAlert && !a.alert.macroReversal);
  const macroAlerts = allAlerts.filter(a => a.alert.macroReversal);
  const confirmedCont = allAlerts.filter(a => a.alert.pullbackAlert && a.alert.ltfConfirmed);
  const pullbackAlerts = allAlerts.filter(a => a.alert.pullbackAlert && !a.alert.ltfConfirmed);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SETUP SCANNER REPORT — ${now()}`);
  console.log(`  ${alignedAlerts.length} HTF-aligned  |  ${macroAlerts.length} macro reversal  |  ${confirmedCont.length} confirmed cont  |  ${pullbackAlerts.length} pullback watch  |  Expiry: ~${expiryLabel()}`);
  console.log(`${'═'.repeat(80)}`);

  // ── NEWS SUMMARY ──
  const allNews = allAlerts.flatMap(a => a.alert.newsWarnings || []);
  const uniqueNews = [...new Map(allNews.map(n => [`${n.currency}-${n.title}-${n.time}`, n])).values()];
  if (uniqueNews.length > 0) {
    console.log(`\n  ── HIGH-IMPACT NEWS THIS WEEK ──`);
    for (const n of uniqueNews) {
      const tag = n.urgency === 'IMMINENT' ? '🔴' : n.urgency === 'TODAY' ? '🟡' : '🟠';
      console.log(`  ${tag} ${n.time}: ${n.currency} ${n.title} (F: ${n.forecast} / P: ${n.previous})`);
    }
    console.log(``);
  }

  // ── SETUP TABLE ──
  // Short type labels for table readability
  const shortType = (t) => {
    if (t === 'REVERSAL LONG')     return 'REV LONG';
    if (t === 'REVERSAL SHORT')    return 'REV SHORT';
    if (t === 'CONTINUATION LONG') return 'CONT LONG';
    if (t === 'CONTINUATION SHORT')return 'CONT SHORT';
    return t;
  };

  // Confluence verdict icon — Phase 5
  const confIcon = (c) => {
    if (!c || c.verdict === 'unknown') return '?';
    if (c.verdict === 'very_strong') return '✅✅';
    if (c.verdict === 'strong')      return '✅';
    if (c.verdict === 'partial')     return '✓';
    if (c.verdict === 'neutral')     return '·';
    if (c.verdict === 'weak')        return '⚠';
    if (c.verdict === 'contradicts') return '🚫';
    return '?';
  };

  if (alignedAlerts.length > 0) {
    console.log(`  ── HTF-ALIGNED SETUPS (${alignedAlerts.length}) ──`);
    console.log(`  ${'─'.repeat(108)}`);
    console.log(`  ${'Pair'.padEnd(9)} ${'Direction'.padEnd(12)} ${'★'.padEnd(6)} ${'Entry'.padEnd(9)} ${'SL'.padEnd(9)} ${'TP1'.padEnd(9)} ${'TP2'.padEnd(9)} ${'TP3'.padEnd(9)} ${'Best'.padEnd(6)} ${'News'.padEnd(5)} CS`);
    console.log(`  ${'─'.repeat(108)}`);

    for (const { symbol, price, alert } of alignedAlerts) {
      const d = symbol.includes('JPY') ? 2 : 4;
      const t = alert.targets || {};
      const bestRR = !isNaN(t.rr3) ? t.rr3 : !isNaN(t.rr2) ? t.rr2 : !isNaN(t.rr1) ? t.rr1 : NaN;
      const newsCount = (alert.newsWarnings || []).length;
      const stars = '★'.repeat(alert.strength);

      const hasBlock = (alert.newsWarnings || []).some(n =>
        n.impact?.context && (() => {
          const isLong = alert.type.includes('LONG');
          const newsHelps = (isLong && n.impact.direction === 'bullish') || (!isLong && n.impact.direction === 'bearish');
          const newsStuck = n.impact.context.followThrough.includes('continued');
          return !newsHelps && newsStuck;
        })()
      );
      const riskIcon = hasBlock ? '🚫' : newsCount > 0 ? '⚠' : '✅';
      const csIcon = confIcon(alert.confluence);
      const levelWarn = alert.nearOpposingLevel
        ? `  ⚠ at ${alert.type.includes('LONG') ? 'R' : 'S'} ${alert.nearOpposingLevel.price.toFixed(d)} (${alert.nearOpposingLevel.touches}×)`
        : '';

      console.log(`  ${shortName(symbol).padEnd(9)} ${shortType(alert.type).padEnd(12)} ${stars.padEnd(6)} ${price.toFixed(d).padEnd(9)} ${fmtPrice(t.sl, d).padEnd(9)} ${fmtPrice(t.tp1, d).padEnd(9)} ${fmtPrice(t.tp2, d).padEnd(9)} ${fmtPrice(t.tp3, d).padEnd(9)} ${fmtRR(bestRR).padEnd(6)} ${riskIcon.padEnd(5)} ${csIcon}${levelWarn}`);
    }
    console.log(`  ${'─'.repeat(108)}`);
    console.log(`  News: ✅ clear  ⚠ upcoming  🚫 AGAINST trade  |  CS: ✅✅ very strong  ✅ strong  ✓ partial  · neutral  ⚠ weak  🚫 contradicts\n`);
  }

  // ── 🎯 TRIGGERED SETUPS — limit-order entries that filled since detection ──
  // Pulls from audit log to surface pending setups whose entry zone got hit.
  // Filters: only show setups with a valid SL + at least TP1 (complete trade plan).
  // Dedupes per-pair by keeping the most recent triggered setup.
  try {
    const log = loadAuditLog();
    let triggered = log.setups.filter(s => {
      if (s.status !== 'pending' || !s.triggered) return false;
      const eSL = s.ltfConfirmed && s.continuationLevels?.sl != null ? s.continuationLevels.sl : s.sl;
      const eTP1 = s.ltfConfirmed && s.continuationLevels?.tp1 != null ? s.continuationLevels.tp1 : s.tp1;
      return eSL != null && eTP1 != null;
    });
    // Dedupe per pair — keep most recent triggerTime.
    const bySymbol = {};
    for (const s of triggered) {
      const cur = bySymbol[s.symbol];
      if (!cur || new Date(s.triggerTime) > new Date(cur.triggerTime)) bySymbol[s.symbol] = s;
    }
    triggered = Object.values(bySymbol);
    if (triggered.length > 0) {
      console.log(`  🎯 TRIGGERED SETUPS (${triggered.length}) — limit zones reached since detection`);
      console.log(`  ${'─'.repeat(170)}`);
      console.log(`  ${'St'.padEnd(3)} ${'Pair'.padEnd(9)} ${'Direction'.padEnd(12)} ${'★'.padEnd(4)} ${'Zone'.padEnd(18)} ${'Fill'.padEnd(9)} ${'Current'.padEnd(9)} ${'SL'.padEnd(9)} ${'TP1'.padEnd(9)} ${'TP2'.padEnd(9)} ${'TP3'.padEnd(9)} ${'P/L'.padEnd(8)} ${'R'.padEnd(6)} ${'MFE'.padEnd(8)} ${'MAE'.padEnd(8)} ${'When'.padEnd(10)}`);
      console.log(`  ${'─'.repeat(170)}`);
      const shortTypeLocal = (t) =>
        t === 'REVERSAL LONG' ? 'REV LONG' :
        t === 'REVERSAL SHORT' ? 'REV SHORT' :
        t === 'CONTINUATION LONG' ? 'CONT LONG' :
        t === 'CONTINUATION SHORT' ? 'CONT SHORT' : t;
      for (const s of triggered) {
        const d = s.symbol.includes('JPY') ? 2 : 4;
        const pipMul = s.symbol.includes('JPY') ? 100 : 10000;
        // Match reviewSetups' direction logic: only honor suggestedDirection
        // when ltfConfirmed — otherwise the trade is still tracked as the
        // original type (e.g., a REV LONG stays a LONG even if scanner now
        // suggests CONT SHORT). Mismatch here caused stopped LONGs to render
        // with SHORT P/L math, inflating the win count.
        const effectiveType = s.ltfConfirmed && s.suggestedDirection ? s.suggestedDirection : s.type;
        const isLong = effectiveType.includes('LONG');
        const stars = '★'.repeat(s.strength || 0);
        const dir = shortTypeLocal(effectiveType);
        const zone = s.entryZone
          ? `${s.entryZone.low.toFixed(d)}-${s.entryZone.high.toFixed(d)}`
          : (s.entryLevel ?? s.entryPrice ?? '?').toFixed?.(d) ?? '?';
        const fill = (s.triggerPrice ?? s.triggerLevel ?? 0).toFixed(d);
        const cur = s.lastPrice ?? s.triggerPrice;
        // Effective levels: prefer continuation levels when Phase 3 confirmed.
        const eSL = s.ltfConfirmed && s.continuationLevels?.sl != null ? s.continuationLevels.sl : s.sl;
        const eTP1 = s.ltfConfirmed && s.continuationLevels?.tp1 != null ? s.continuationLevels.tp1 : s.tp1;
        const eTP2 = s.ltfConfirmed && s.continuationLevels?.tp2 != null ? s.continuationLevels.tp2 : s.tp2;
        const eTP3 = s.tp3;
        const trigPx = s.triggerPrice ?? s.triggerLevel ?? null;
        const plPips = (cur != null && trigPx != null)
          ? Math.round((isLong ? cur - trigPx : trigPx - cur) * pipMul)
          : 0;
        const slDist = (eSL != null && trigPx != null) ? Math.abs(trigPx - eSL) : null;
        const moveSize = (cur != null && trigPx != null) ? (isLong ? cur - trigPx : trigPx - cur) : null;
        const rAchieved = (slDist != null && moveSize != null && slDist > 0) ? (moveSize / slDist).toFixed(2) : '—';
        const mfePips = (s.maxFavorable != null && trigPx != null)
          ? Math.round((isLong ? s.maxFavorable - trigPx : trigPx - s.maxFavorable) * pipMul)
          : 0;
        const maePips = (s.maxAdverse != null && trigPx != null)
          ? Math.round((isLong ? trigPx - s.maxAdverse : s.maxAdverse - trigPx) * pipMul)
          : 0;
        const ageHrs = ((Date.now() - new Date(s.triggerTime).getTime()) / 3600000).toFixed(1);
        // State indicator based on R achieved.
        const rNum = parseFloat(rAchieved);
        let state = '🟡'; // chop / break-even
        if (!isNaN(rNum)) {
          if (rNum >= 1.0) state = '🏆';     // TP1+ reached
          else if (rNum > 0.1) state = '🟢';  // in profit
          else if (rNum > -0.3) state = '🟡'; // chop
          else if (rNum > -0.7) state = '🟠'; // mild adverse
          else state = '🔴';                 // deep adverse, near SL
        }
        console.log(`  ${state.padEnd(3)} ${shortName(s.symbol).padEnd(9)} ${dir.padEnd(12)} ${stars.padEnd(4)} ${zone.padEnd(18)} ${fill.padEnd(9)} ${fmtPrice(cur, d).padEnd(9)} ${fmtPrice(eSL, d).padEnd(9)} ${fmtPrice(eTP1, d).padEnd(9)} ${fmtPrice(eTP2, d).padEnd(9)} ${fmtPrice(eTP3, d).padEnd(9)} ${(plPips + 'p').padEnd(8)} ${(rAchieved + 'R').padEnd(6)} ${(mfePips + 'p').padEnd(8)} ${(maePips + 'p').padEnd(8)} ${(ageHrs + 'h').padEnd(10)}`);
      }
      console.log(`  ${'─'.repeat(170)}`);
      console.log(`  St: 🏆 TP+ reached | 🟢 in profit | 🟡 chop | 🟠 mild adverse | 🔴 near SL  |  Zone = planned entry  |  Fill = actual trigger\n`);
    }

    // ── ✅ RECENT OUTCOMES — trades that closed in last 24h ──
    const cutoff = Date.now() - 24 * 3600000;
    const recent = log.setups
      .filter(s => s.status !== 'pending' && s.exitTime && new Date(s.exitTime).getTime() >= cutoff)
      .sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime));
    if (recent.length > 0) {
      const wins = recent.filter(s => s.outcome === 'win').length;
      const losses = recent.filter(s => s.outcome === 'loss').length;
      const expired = recent.filter(s => s.outcome === 'expired').length;
      console.log(`  ✅ RECENT OUTCOMES (last 24h) — ${wins}W / ${losses}L / ${expired}E`);
      console.log(`  ${'─'.repeat(108)}`);
      console.log(`  ${'Outcome'.padEnd(10)} ${'Pair'.padEnd(9)} ${'Direction'.padEnd(12)} ${'★'.padEnd(4)} ${'Entry'.padEnd(9)} ${'Exit'.padEnd(9)} ${'P/L'.padEnd(8)} ${'Closed'.padEnd(10)}`);
      console.log(`  ${'─'.repeat(108)}`);
      const shortTypeLocal2 = (t) =>
        t === 'REVERSAL LONG' ? 'REV LONG' :
        t === 'REVERSAL SHORT' ? 'REV SHORT' :
        t === 'CONTINUATION LONG' ? 'CONT LONG' :
        t === 'CONTINUATION SHORT' ? 'CONT SHORT' : t;
      for (const s of recent) {
        const d = s.symbol.includes('JPY') ? 2 : 4;
        const pipMul = s.symbol.includes('JPY') ? 100 : 10000;
        // Match reviewSetups' direction logic (see TRIGGERED loop above).
        const effectiveType = s.ltfConfirmed && s.suggestedDirection ? s.suggestedDirection : s.type;
        const isLong = effectiveType.includes('LONG');
        const stars = '★'.repeat(s.strength || 0);
        const dir = shortTypeLocal2(effectiveType);
        const ref = s.entryLevel ?? s.entryPrice ?? s.triggerPrice ?? null;
        const exitPrice = s.exitPrice ?? null;
        const pl = (ref != null && exitPrice != null)
          ? Math.round((isLong ? exitPrice - ref : ref - exitPrice) * pipMul)
          : 0;
        const icon = s.outcome === 'win' ? '✅' : s.outcome === 'loss' ? '❌' : '⏱';
        const label = s.status === 'tp3_hit' ? 'TP3 hit'
                    : s.status === 'tp2_hit' ? 'TP2 hit'
                    : s.status === 'tp1_hit' ? 'TP1 hit'
                    : s.status === 'stopped' ? 'Stopped'
                    : 'Expired';
        const ageHrs = ((Date.now() - new Date(s.exitTime).getTime()) / 3600000).toFixed(1);
        console.log(`  ${(icon + ' ' + label).padEnd(10)} ${shortName(s.symbol).padEnd(9)} ${dir.padEnd(12)} ${stars.padEnd(4)} ${fmtPrice(ref, d).padEnd(9)} ${fmtPrice(exitPrice, d).padEnd(9)} ${(pl + 'p').padEnd(8)} ${(ageHrs + 'h ago').padEnd(10)}`);
      }
      console.log(`  ${'─'.repeat(108)}\n`);
    }
  } catch (e) {
    // informational — never block report
  }

  // ── MACRO REVERSAL CANDIDATES — counter-trend at extremes ──
  // Pre-fetch news once so we can evaluate gates + render the catalyst lens.
  let macroNewsEvents = null;
  if (macroAlerts.length > 0) {
    try { macroNewsEvents = await getHighImpactNews(); } catch (e) { macroNewsEvents = []; }
  }
  if (macroAlerts.length > 0) {
    console.log(`  💎 MACRO REVERSAL CANDIDATES (${macroAlerts.length}) — counter-trend at HTF extreme — high risk/reward`);
    console.log(`  ${'─'.repeat(108)}`);
    console.log(`  ${'Pair'.padEnd(9)} ${'Direction'.padEnd(12)} ${'★'.padEnd(4)} ${'Entry'.padEnd(9)} ${'SL'.padEnd(9)} ${'TP1'.padEnd(9)} ${'Conf'.padEnd(8)} ${'HTF (D/W)'.padEnd(13)} ${'Dist'.padEnd(7)} CS`);
    console.log(`  ${'─'.repeat(108)}`);
    for (const { symbol, price, alert } of macroAlerts) {
      const d = symbol.includes('JPY') ? 2 : 4;
      const t = alert.targets || {};
      const stars = '★'.repeat(alert.strength);
      const ctx = alert.macroContext || {};
      const htfStr = `${alert.htf?.dRSI ?? '?'}/${alert.htf?.wRSI ?? '?'}`;
      const csIcon = confIcon(alert.confluence);
      const confirmBadge = alert.ltfConfirmed
        ? `  ✅ 1HR ${alert.ltfEvent}${alert.ltfBarsAgo != null ? ` ${alert.ltfBarsAgo}b` : ''}`
        : '';
      // Show zone range when available (low–high) instead of single price.
      // Honors the "zones not levels" insight — price reverses inside a band, not at one tick.
      const z = alert.entryZone;
      const entryDisplay = z
        ? `${z.low.toFixed(d)}-${z.high.toFixed(d)}`
        : (alert.entryLevel ?? price).toFixed(d);
      const entryNote = alert.entryLevel != null && Math.abs(alert.entryLevel - price) > price * 0.001
        ? ` (mkt ${price.toFixed(d)})`
        : '';
      // Freshness badge: PAC box overlap = unmitigated institutional zone (per LuxAlgo).
      const freshBadge = alert.entryZone != null
        ? (alert.pacFresh ? '  🟢 PAC-fresh' : '  🟡 historical')
        : '';
      const swingBadge = ctx.approachingLastSwing
        ? `  📍 at last ${ctx.lastSwingInfo?.type === 'highestSwingHigh' ? 'swing high' : 'swing low'} ${ctx.lastSwingInfo?.price?.toFixed(d) ?? ''}`
        : '';
      // 5-gate + catalyst evaluation → 🌟 ALL GREEN when everything aligns.
      const gateInfo = evaluateGates(symbol, alert, macroNewsEvents);
      const allGreenBadge = gateInfo.allGreen
        ? gateInfo.firstActionable
          ? `  🌟 ALL GREEN (5/5 + 📈 1st catalyst in ${(gateInfo.firstActionable.hoursUntil / 24).toFixed(1)}d)`
          : `  🌟 ALL GREEN (5/5 + clean window)`
        : '';
      if (gateInfo.allGreen) {
        const catalystSuffix = gateInfo.firstActionable
          ? ` | catalyst in ${(gateInfo.firstActionable.hoursUntil / 24).toFixed(1)}d`
          : ' | clean window';
        // Include full trade plan when available; flag "levels TBD" when not.
        const hasLevels = t.sl != null && t.tp1 != null;
        // Detection anomaly: scanner shouldn't promote an ALL GREEN setup
        // without SL/TP. Log to observations so dev can investigate the gate
        // logic and the macroAlert builder for the missing levels path.
        if (!hasLevels) {
          observe({
            type: 'detection_anomaly',
            severity: 'warn',
            message: `ALL GREEN fired without SL or TP1`,
            data: {
              symbol,
              alertType: alert.type,
              entry: alert.entryLevel ?? price,
              sl: t.sl,
              tp1: t.tp1,
              hasEntryZone: !!alert.entryZone,
            },
          });
        }
        const planLine = hasLevels
          ? `SL ${fmtPrice(t.sl, d)} | TP1 ${fmtPrice(t.tp1, d)}${t.tp2 != null ? ' | TP2 ' + fmtPrice(t.tp2, d) : ''}${t.tp3 != null ? ' | TP3 ' + fmtPrice(t.tp3, d) : ''}`
          : 'levels TBD — set manually';
        notifyOnce(`ALLGREEN:${symbol}:${alert.type}`, {
          title: `🌟 ${shortName(symbol)} ${shortType(alert.type)}`,
          message: `Entry ${entryDisplay}\n${planLine}${catalystSuffix}`,
          priority: 1,
          sound: 'magic',
        });

        // Approach alert — fires when price is within ~20 pips of the entry zone
        // boundary but hasn't crossed yet. Gives you lead time before fill.
        // 4h cooldown so we don't ping every scan as price hovers near the zone.
        const pipMul = symbol.includes('JPY') ? 100 : 10000;
        let approachPips = null;
        if (alert.entryZone) {
          const z = alert.entryZone;
          const isLong = alert.type.includes('LONG');
          if (isLong && price > z.high) approachPips = Math.round((price - z.high) * pipMul);
          else if (!isLong && price < z.low) approachPips = Math.round((z.low - price) * pipMul);
        } else if (alert.entryLevel != null) {
          approachPips = Math.round(Math.abs(price - alert.entryLevel) * pipMul);
        }
        if (approachPips !== null && approachPips > 0 && approachPips <= 20) {
          notifyOnce(`APPROACH:${symbol}:${alert.type}`, {
            title: `📍 ${shortName(symbol)} ${shortType(alert.type)} approaching`,
            message: `Now ${price.toFixed(d)} | Entry ${entryDisplay} | ~${approachPips}p away`,
            priority: 0,
          });
        }
      }
      console.log(`  ${shortName(symbol).padEnd(9)} ${shortType(alert.type).padEnd(12)} ${stars.padEnd(4)} ${entryDisplay.padEnd(15)} ${fmtPrice(t.sl, d).padEnd(9)} ${fmtPrice(t.tp1, d).padEnd(9)} ${(ctx.confidence || '?').padEnd(8)} ${htfStr.padEnd(13)} ${(ctx.distanceFromExtreme || '—').padEnd(7)} ${csIcon}${confirmBadge}${entryNote}${freshBadge}${swingBadge}${allGreenBadge}`);
    }
    console.log(`  ${'─'.repeat(108)}`);
    console.log(`  Catching potential trend changes at multi-week/month extremes. Confirm on 1HR before entry.\n`);

    // ── NEWS CATALYST LENS (7-day window) ──
    // For each macro reversal candidate, list upcoming high-impact events on the pair's
    // currencies, infer F-vs-P direction, and flag tailwind/headwind for the setup.
    try {
      const newsEvents = macroNewsEvents || await getHighImpactNews();
      if (newsEvents && newsEvents.length > 0) {
        console.log(`  📅 NEWS CATALYST WINDOW — next 7 days (does the news support the reversal?)`);
        console.log(`  ${'─'.repeat(108)}`);
        for (const { symbol, alert } of macroAlerts) {
          const catalysts = getCatalystWindow(symbol, newsEvents, 168);
          if (catalysts.length === 0) {
            console.log(`  ${shortName(symbol)} ${shortType(alert.type)}: no high-impact catalysts in window`);
            continue;
          }
          let tailwinds = 0, headwinds = 0, neutral = 0;
          const lines = [];
          for (const c of catalysts) {
            const dir = inferCatalystDirection(c);
            const align = catalystAlignment(alert.type, c.side, dir);
            const icon = align === 'tailwind' ? '📈' : align === 'headwind' ? '📉' : '➖';
            if (align === 'tailwind') tailwinds++;
            else if (align === 'headwind') headwinds++;
            else neutral++;
            const hrs = c.hoursUntil;
            const when = hrs < 0 ? `${Math.abs(hrs).toFixed(0)}h ago`
                       : hrs < 24 ? `in ${hrs.toFixed(0)}h`
                       : `in ${(hrs / 24).toFixed(1)}d`;
            lines.push(`    ${when.padEnd(10)} ${c.currency} ${c.title.padEnd(38)} F: ${String(c.forecast).padEnd(8)} P: ${String(c.previous).padEnd(8)} ${icon}`);
          }
          console.log(`  ${shortName(symbol)} ${shortType(alert.type)}: ${tailwinds} 📈 tailwind | ${headwinds} 📉 headwind | ${neutral} ➖ neutral`);
          for (const l of lines) console.log(l);
          if (tailwinds > headwinds + 1) {
            console.log(`    ★ Net catalyst alignment: REVERSAL THESIS BUILDING`);
          } else if (headwinds > tailwinds + 1) {
            console.log(`    ⚠ Net catalyst alignment: NEWS WORKING AGAINST setup`);
          }
          console.log('');
        }
        console.log(`  ${'─'.repeat(108)}\n`);
      }
    } catch (e) {
      // catalyst lens is informational; don't break the report
    }
  }

  // ── CONFIRMED CONTINUATIONS — pullback alerts with 1HR confirmation ──
  if (confirmedCont.length > 0) {
    console.log(`  ✅ CONFIRMED CONTINUATIONS (${confirmedCont.length}) — pullback + 1HR CHoCH confirmation`);
    console.log(`  ${'─'.repeat(115)}`);
    console.log(`  ${'Pair'.padEnd(9)} ${'Direction'.padEnd(12)} ${'★'.padEnd(6)} ${'Entry'.padEnd(9)} ${'SL'.padEnd(9)} ${'TP1'.padEnd(9)} ${'TP2'.padEnd(9)} ${'Best'.padEnd(6)} ${'1HR Event'.padEnd(9)} ${'Age'.padEnd(7)} CS`);
    console.log(`  ${'─'.repeat(115)}`);
    for (const { symbol, alert } of confirmedCont) {
      const d = symbol.includes('JPY') ? 2 : 4;
      const lvl = alert.continuationLevels || {};
      const stars = '★'.repeat(alert.strength);
      const csIcon = confIcon(alert.confluence);
      const direction = alert.suggestedDirection || alert.type;
      const bestRR = !isNaN(lvl.rr2) ? lvl.rr2 : (!isNaN(lvl.rr1) ? lvl.rr1 : NaN);
      const ltfEvent = alert.ltfEvent || '?';
      // Bar age with freshness indicator
      const barsAgo = alert.ltfBarsAgo;
      const ageDisplay = barsAgo != null
        ? (barsAgo <= 1 ? `🔥 ${barsAgo}b` : barsAgo <= 3 ? `${barsAgo}b` : barsAgo <= 6 ? `${barsAgo}b ⚠` : `${barsAgo}b ❄`)
        : '?';
      const levelWarn = alert.nearOpposingLevel
        ? `  ⚠ at ${direction.includes('LONG') ? 'R' : 'S'} ${alert.nearOpposingLevel.price.toFixed(d)} (${alert.nearOpposingLevel.touches}×)`
        : '';
      console.log(`  ${shortName(symbol).padEnd(9)} ${shortType(direction).padEnd(12)} ${stars.padEnd(6)} ${fmtPrice(lvl.entry, d).padEnd(9)} ${fmtPrice(lvl.sl, d).padEnd(9)} ${fmtPrice(lvl.tp1, d).padEnd(9)} ${fmtPrice(lvl.tp2, d).padEnd(9)} ${fmtRR(bestRR).padEnd(6)} ${ltfEvent.padEnd(9)} ${ageDisplay.padEnd(7)} ${csIcon}${levelWarn}`);
    }
    console.log(`  ${'─'.repeat(115)}`);
    console.log(`  Age: 🔥 fresh (≤1 bar)  |  unmarked = 2-3 bars  |  ⚠ stale (4-6 bars)  |  ❄ old (7+ bars)\n`);
  }

  // ── PULLBACK ALERTS — counter-trend setups still waiting for LTF confirmation ──
  if (pullbackAlerts.length > 0) {
    console.log(`  ⚠️  PULLBACK ALERTS (${pullbackAlerts.length}) — no 1HR confirmation yet, do NOT enter original direction`);
    console.log(`  ${'─'.repeat(100)}`);
    console.log(`  ${'Pair'.padEnd(9)} ${'Was'.padEnd(12)} ${'Wait For'.padEnd(20)} ${'HTF (D/W RSI)'.padEnd(15)} Reasoning`);
    console.log(`  ${'─'.repeat(100)}`);
    for (const { symbol, price, alert } of pullbackAlerts) {
      const htfStr = `${alert.htf?.dRSI ?? '?'}/${alert.htf?.wRSI ?? '?'} ${alert.htf?.htfBullish ? 'BULL' : alert.htf?.htfBearish ? 'BEAR' : 'mixed'}`;
      const reasoning = alert.htf?.htfBullish
        ? 'Pullback in uptrend — wait for bullish CHoCH on 1HR'
        : alert.htf?.htfBearish
        ? 'Pullback in downtrend — wait for bearish CHoCH on 1HR'
        : 'HTF mixed — wait for clarity';
      console.log(`  ${shortName(symbol).padEnd(9)} ${shortType(alert.originalType || alert.type).padEnd(12)} ${shortType(alert.suggestedDirection || '').padEnd(20)} ${htfStr.padEnd(15)} ${reasoning}`);
    }
    console.log(`  ${'─'.repeat(100)}\n`);
  }

  // ── TOP PICKS — detailed analysis (HTF-aligned only) ──
  const topPicks = alignedAlerts.filter(a => a.alert.strength >= 4);
  if (topPicks.length > 0) {
    console.log(`${'═'.repeat(80)}`);
    console.log(`  TOP PICKS (${topPicks.length}) — Why These Are The Best Setups`);
    console.log(`${'═'.repeat(80)}`);

    for (const { symbol, price, alert } of topPicks) {
      const d = symbol.includes('JPY') ? 2 : 4;
      const t = alert.targets || {};
      const stars = '★'.repeat(alert.strength) + '☆'.repeat(5 - alert.strength);
      const bestRR = !isNaN(t.rr3) ? t.rr3 : !isNaN(t.rr2) ? t.rr2 : !isNaN(t.rr1) ? t.rr1 : NaN;
      const news = alert.newsWarnings || [];

      console.log(`\n  ┌${'─'.repeat(76)}┐`);
      console.log(`  │  ${alert.type}  ${stars}  ${shortName(symbol)} @ ${price.toFixed(d)}`.padEnd(78) + '│');
      console.log(`  ├${'─'.repeat(76)}┤`);

      // Why this setup
      const reasons = [];
      for (const det of alert.details) {
        if (det.includes('CHoCH')) reasons.push(det);
        if (det.includes('OM o')) reasons.push(det);
        if (det.includes('premium') || det.includes('discount') || det.includes('demand') || det.includes('supply')) reasons.push(det);
        if (det.includes('Smart Trail')) reasons.push(det);
      }
      if (reasons.length > 0) {
        console.log(`  │  WHY: ${reasons.join(' + ')}`.padEnd(78) + '│');
      }

      // Trade plan
      console.log(`  │`.padEnd(78) + '│');
      console.log(`  │  TRADE PLAN:`.padEnd(78) + '│');
      console.log(`  │    Entry:  ${price.toFixed(d)}`.padEnd(78) + '│');
      if (!isNaN(t.sl))  console.log(`  │    SL:     ${fmtPrice(t.sl, d)}  (risk: ${fmtPrice(Math.abs(price - t.sl), d)})`.padEnd(78) + '│');
      if (!isNaN(t.tp1)) console.log(`  │    TP1:    ${fmtPrice(t.tp1, d)}  (${fmtRR(t.rr1)})`.padEnd(78) + '│');
      if (!isNaN(t.tp2)) console.log(`  │    TP2:    ${fmtPrice(t.tp2, d)}  (${fmtRR(t.rr2)})`.padEnd(78) + '│');
      if (!isNaN(t.tp3)) console.log(`  │    TP3:    ${fmtPrice(t.tp3, d)}  (${fmtRR(t.rr3)})`.padEnd(78) + '│');
      if (!isNaN(bestRR)) console.log(`  │    Best:   ${fmtRR(bestRR)} reward-to-risk`.padEnd(78) + '│');

      // News risk assessment
      if (news.length > 0) {
        console.log(`  │`.padEnd(78) + '│');
        console.log(`  │  NEWS RISK:`.padEnd(78) + '│');
        for (const n of news) {
          const tag = n.urgency === 'IMMINENT' ? '🔴' : n.urgency === 'TODAY' ? '🟡' : '🟠';
          console.log(`  │    ${tag} ${n.currency} ${n.title} in ${n.hoursUntil}h`.padEnd(78) + '│');
          console.log(`  │       F: ${n.forecast}  |  P: ${n.previous}`.padEnd(78) + '│');
          if (n.impact) {
            const imp = n.impact;
            console.log(`  │       History: ${imp.movePips}pip ${imp.direction} (${imp.ratio}x avg)`.padEnd(78) + '│');
            if (imp.context) {
              const ctx = imp.context;
              console.log(`  │       Was: ${ctx.rangePosition}, trend ${ctx.preTrend.split('(')[0].trim()}`.padEnd(78) + '│');
              console.log(`  │       ${ctx.newsOutcome} → ${ctx.followThrough}`.padEnd(78) + '│');

              // Risk verdict for this specific setup
              const isLong = alert.type.includes('LONG');
              const newsHelps = (isLong && imp.direction === 'bullish') || (!isLong && imp.direction === 'bearish');
              const newsStuck = imp.context.followThrough.includes('continued') || imp.context.followThrough.includes('unclear');
              let verdict;
              if (newsHelps && newsStuck) {
                verdict = '✅ News historically SUPPORTS this direction';
              } else if (newsHelps && !newsStuck) {
                verdict = '⚠️  News helped initially but reversed — be cautious';
              } else if (!newsHelps && newsStuck) {
                verdict = '🚫 News historically AGAINST this direction — high risk';
              } else {
                verdict = '⚠️  News went against but didn\'t stick — moderate risk';
              }
              console.log(`  │       → ${verdict}`.padEnd(78) + '│');
            }
          }
        }
      } else {
        console.log(`  │`.padEnd(78) + '│');
        console.log(`  │  NEWS RISK: None — clear calendar`.padEnd(78) + '│');
      }

      // Currency Strength Confluence (Phase 5)
      const c = alert.confluence;
      if (c && c.verdict !== 'unknown') {
        console.log(`  │`.padEnd(78) + '│');
        const verdictLabel = {
          very_strong: '✅✅ VERY STRONG confluence',
          strong: '✅ Strong confluence',
          partial: '✓ Partial confluence',
          neutral: '· Neutral',
          weak: '⚠ Weak confluence',
          contradicts: '🚫 Currency strength CONTRADICTS direction',
        }[c.verdict] || '?';
        console.log(`  │  CURRENCY STRENGTH: ${verdictLabel} (score ${c.score})`.padEnd(78) + '│');
        if (c.base && c.quote) {
          const fmt = (s) => `${s.direction}${s.strength === 'strong' ? '/strong' : ''} (TS ${s.trendStrength?.toFixed(0)}%, HW ${s.hyperWave?.toFixed(0)})`;
          console.log(`  │    ${c.base.currency}X: ${fmt(c.base)}`.padEnd(78) + '│');
          console.log(`  │    ${c.quote.currency}X: ${fmt(c.quote)}`.padEnd(78) + '│');
        }
      }

      // Action
      console.log(`  │`.padEnd(78) + '│');
      console.log(`  │  ACTION: ${alert.action}`.padEnd(78) + '│');
      console.log(`  └${'─'.repeat(76)}┘`);
    }
  }

  // ── LOWER-RATED ALIGNED SETUPS (3 stars — watch list) ──
  const watchList = alignedAlerts.filter(a => a.alert.strength < 4);
  if (watchList.length > 0) {
    console.log(`\n  ── WATCH LIST (${watchList.length}) — Lower conviction, monitor for improvement ──`);
    for (const { symbol, price, alert } of watchList) {
      const d = symbol.includes('JPY') ? 2 : 4;
      const t = alert.targets || {};
      const bestRR = !isNaN(t.rr3) ? t.rr3 : !isNaN(t.rr2) ? t.rr2 : !isNaN(t.rr1) ? t.rr1 : NaN;
      console.log(`  • ${shortName(symbol).padEnd(8)} ${shortType(alert.type).padEnd(12)} SL: ${fmtPrice(t.sl, d).padEnd(8)} TP1: ${fmtPrice(t.tp1, d).padEnd(8)} Best: ${fmtRR(bestRR)}`);
    }
  }

  console.log(`\n${'═'.repeat(80)}\n`);
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT SYSTEM — log setups, review outcomes, health score
// ═══════════════════════════════════════════════════════════════════
function loadAuditLog() {
  if (!existsSync(AUDIT_LOG)) return { setups: [], health: { total: 0, wins: 0, losses: 0, pending: 0, expired: 0 } };
  return JSON.parse(readFileSync(AUDIT_LOG, 'utf8'));
}

function saveAuditLog(log) {
  writeFileSync(AUDIT_LOG, JSON.stringify(log, null, 2));
}

function logSetups(allAlerts) {
  const log = loadAuditLog();
  const timestamp = new Date().toISOString();

  for (const { symbol, price, alert } of allAlerts) {
    const t = alert.targets || {};
    // Deduplicate: don't log the same setup type for the same pair if already pending
    const existing = log.setups.find(s =>
      s.symbol === symbol && s.type === alert.type && s.status === 'pending'
    );
    if (existing) continue;

    log.setups.push({
      id: `${shortName(symbol)}-${Date.now()}`,
      timestamp,
      symbol,
      type: alert.type,
      strength: alert.strength,
      entryPrice: price,
      sl: isNaN(t.sl) ? null : t.sl,
      tp1: isNaN(t.tp1) ? null : t.tp1,
      tp2: isNaN(t.tp2) ? null : t.tp2,
      tp3: isNaN(t.tp3) ? null : t.tp3,
      rr1: isNaN(t.rr1) ? null : t.rr1,
      // HTF context
      htfAligned: alert.htfAligned ?? null,
      pullbackAlert: alert.pullbackAlert ?? false,
      macroReversal: alert.macroReversal ?? false,
      macroConfidence: alert.macroContext?.confidence ?? null,
      htfDaily: alert.htf?.daily ?? null,
      htfWeekly: alert.htf?.weekly ?? null,
      htfDRSI: alert.htf?.dRSI ?? null,
      htfWRSI: alert.htf?.wRSI ?? null,
      originalType: alert.originalType ?? null,
      suggestedDirection: alert.suggestedDirection ?? null,
      // Phase 5: Currency strength confluence at log time
      csVerdict: alert.confluence?.verdict ?? null,
      csScore: alert.confluence?.score ?? null,
      csBase: alert.confluence?.base ? {
        currency: alert.confluence.base.currency,
        direction: alert.confluence.base.direction,
        strength: alert.confluence.base.strength,
        trendStrength: alert.confluence.base.trendStrength,
      } : null,
      csQuote: alert.confluence?.quote ? {
        currency: alert.confluence.quote.currency,
        direction: alert.confluence.quote.direction,
        strength: alert.confluence.quote.strength,
        trendStrength: alert.confluence.quote.trendStrength,
      } : null,
      // Phase 3: LTF confirmation
      ltfConfirmed: alert.ltfConfirmed ?? false,
      ltfEvent: alert.ltfEvent ?? null,
      ltfEventPrice: alert.ltfEventPrice ?? null,
      ltfBarsAgo: alert.ltfBarsAgo ?? null,
      continuationDirection: alert.continuationDirection ?? null,
      continuationLevels: alert.continuationLevels ?? null,
      // Entry zone for limit-order setups (macro reversals at structural levels)
      entryZone: alert.entryZone ?? null,
      entryLevel: alert.entryLevel ?? null,
      // Trigger tracking: did price reach the entry zone (limit fill)?
      triggered: false,
      triggerPrice: null,
      triggerLevel: null,
      triggerTime: null,
      status: 'pending',       // pending | tp1_hit | tp2_hit | tp3_hit | stopped | expired
      outcome: null,           // win | loss | expired
      exitPrice: null,
      exitTime: null,
      maxFavorable: null,      // best price reached in trade direction
      maxAdverse: null,        // worst price reached against trade
    });
  }

  log.health.pending = log.setups.filter(s => s.status === 'pending').length;
  saveAuditLog(log);
  return log.setups.filter(s => s.status === 'pending').length;
}

// ─── Calculate market hours between two dates (skip weekends) ────
// Forex market: open Sun 17:00 EST (22:00 UTC) → Fri 17:00 EST (22:00 UTC)
// Weekend = Fri 22:00 UTC to Sun 22:00 UTC (48 hours excluded per weekend)
// Returns ms until Sunday 22:00 UTC (forex market reopen), or 0 if market is open.
// Forex closes Fri 22:00 UTC → reopens Sun 22:00 UTC (5pm ET during EST, 6pm ET during EDT).
function msUntilMarketOpen(now = new Date()) {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  // Friday after 22:00 UTC, or all of Saturday, or Sunday before 22:00 UTC = closed
  const isClosed =
    (day === 5 && hour >= 22) ||
    (day === 6) ||
    (day === 0 && hour < 22);
  if (!isClosed) return 0;
  const reopen = new Date(now);
  // Walk forward to Sunday
  while (reopen.getUTCDay() !== 0) {
    reopen.setUTCDate(reopen.getUTCDate() + 1);
  }
  reopen.setUTCHours(22, 0, 0, 0);
  if (reopen <= now) reopen.setUTCDate(reopen.getUTCDate() + 7);
  return reopen - now;
}

function calcMarketHours(start, end) {
  const MS_PER_HOUR = 3600000;
  const totalHours = (end - start) / MS_PER_HOUR;
  if (totalHours <= 0) return 0;

  // Walk through each weekend between start and end
  // Find the first Friday 22:00 UTC on or after start
  let weekendHours = 0;
  const fri = new Date(start);

  // Advance to the nearest Friday
  while (fri.getUTCDay() !== 5) {
    fri.setUTCDate(fri.getUTCDate() + 1);
  }
  fri.setUTCHours(22, 0, 0, 0);

  // If start is already past this Friday's close, jump to next week
  if (fri <= start) {
    fri.setUTCDate(fri.getUTCDate() + 7);
  }

  // Count each weekend that falls within [start, end]
  while (fri < end) {
    const weekendStart = new Date(fri);                      // Fri 22:00 UTC
    const weekendEnd = new Date(fri);
    weekendEnd.setUTCDate(weekendEnd.getUTCDate() + 2);     // Sun 22:00 UTC

    // Clamp to [start, end]
    const effectiveStart = weekendStart < start ? start : weekendStart;
    const effectiveEnd = weekendEnd > end ? end : weekendEnd;

    if (effectiveEnd > effectiveStart) {
      weekendHours += (effectiveEnd - effectiveStart) / MS_PER_HOUR;
    }

    // Next Friday
    fri.setUTCDate(fri.getUTCDate() + 7);
  }

  return Math.max(0, totalHours - weekendHours);
}

// ─── Check if price hit TP/SL during setup lifetime using OHLCV ──
// Reads recent bars and checks if high/low reached any target
async function checkHistoricalHit(setup) {
  try {
    const ohlcv = await getOhlcv({ count: 50 });
    if (!ohlcv || !ohlcv.bars) return null;

    // Phase 3: For confirmed continuations, use CONT-direction levels
    const effectiveType = setup.ltfConfirmed && setup.suggestedDirection ? setup.suggestedDirection : setup.type;
    const isLong = effectiveType.includes('LONG');
    const effSL = setup.ltfConfirmed && setup.continuationLevels?.sl != null ? setup.continuationLevels.sl : setup.sl;
    const effTP1 = setup.ltfConfirmed && setup.continuationLevels?.tp1 != null ? setup.continuationLevels.tp1 : setup.tp1;
    const effTP2 = setup.ltfConfirmed && setup.continuationLevels?.tp2 != null ? setup.continuationLevels.tp2 : setup.tp2;
    const effTP3 = setup.tp3;

    const setupTime = new Date(setup.timestamp).getTime() / 1000; // unix seconds

    // Filter bars after setup was created
    const relevantBars = ohlcv.bars.filter(b => b.time >= setupTime);
    if (relevantBars.length === 0) return null;

    // Check each bar's high/low against SL and TPs
    for (const bar of relevantBars) {
      // Check SL first (if hit before TP, it's a loss)
      if (effSL != null) {
        const slHit = isLong ? bar.low <= effSL : bar.high >= effSL;
        if (slHit) {
          return {
            status: 'stopped',
            outcome: 'loss',
            exitPrice: effSL,
            exitTime: new Date(bar.time * 1000).toISOString(),
          };
        }
      }

      // Check TPs (highest first)
      if (effTP3 != null) {
        const hit = isLong ? bar.high >= effTP3 : bar.low <= effTP3;
        if (hit) return { status: 'tp3_hit', outcome: 'win', exitPrice: effTP3, exitTime: new Date(bar.time * 1000).toISOString() };
      }
      if (effTP2 != null) {
        const hit = isLong ? bar.high >= effTP2 : bar.low <= effTP2;
        if (hit) return { status: 'tp2_hit', outcome: 'win', exitPrice: effTP2, exitTime: new Date(bar.time * 1000).toISOString() };
      }
      if (effTP1 != null) {
        const hit = isLong ? bar.high >= effTP1 : bar.low <= effTP1;
        if (hit) return { status: 'tp1_hit', outcome: 'win', exitPrice: effTP1, exitTime: new Date(bar.time * 1000).toISOString() };
      }
    }

    return null; // no TP or SL hit found in historical bars
  } catch (err) {
    return null;
  }
}

async function reviewSetups() {
  const log = loadAuditLog();
  const pending = log.setups.filter(s => s.status === 'pending');

  if (pending.length === 0) {
    console.log('\n  No pending setups to review.\n');
    return;
  }

  console.log(`\n[${now()}] Reviewing ${pending.length} pending setup(s)...\n`);
  const EXPIRY_MARKET_HOURS = 72; // setups expire after 72 MARKET hours (excludes weekends)

  for (const setup of pending) {
    const sym = shortName(setup.symbol);
    process.stdout.write(`  Reviewing ${sym} ${setup.type}...`);

    try {
      // Calculate market hours elapsed (skip weekends: Fri 17:00 EST → Sun 17:00 EST)
      const marketHours = calcMarketHours(new Date(setup.timestamp), new Date());

      if (marketHours > EXPIRY_MARKET_HOURS) {
        // Before expiring, switch to pair and check OHLCV to see if TP/SL were hit historically
        await setSymbol({ symbol: setup.symbol });
        await sleep(SETTLE_MS);

        const hitResult = await checkHistoricalHit(setup);
        if (hitResult) {
          Object.assign(setup, hitResult);
          if (hitResult.outcome === 'win') log.health.wins++;
          else if (hitResult.outcome === 'loss') log.health.losses++;
          log.health.pending--;
          console.log(` ${hitResult.status} (retroactive, ${marketHours.toFixed(0)} market hrs)`);
          continue;
        }

        setup.status = 'expired';
        setup.outcome = 'expired';
        setup.exitTime = new Date().toISOString();
        log.health.expired++;
        log.health.pending--;
        console.log(` expired (${marketHours.toFixed(0)} market hrs)`);
        continue;
      }

      // Get current price
      await setSymbol({ symbol: setup.symbol });
      await sleep(SETTLE_MS);
      const quote = await getQuote();
      const currentPrice = quote.close || quote.last;

      if (!currentPrice) {
        console.log(' no price, skipping');
        continue;
      }

      // Sanity check: reject price reads that are wildly off entry. This guards
      // against bad feed / phantom quote from TV that would otherwise trigger
      // an SL "hit" at an impossible level (e.g., USDJPY exit 215.535 vs entry
      // 162.278 — a 33% "move" that can't happen in a currency pair).
      const referencePx = setup.entryLevel ?? setup.entryPrice ?? setup.triggerPrice;
      if (referencePx != null) {
        const deviation = Math.abs(currentPrice - referencePx) / referencePx;
        if (deviation > 0.10) {
          observeOnce(`BAD_QUOTE:${setup.symbol}:${Math.floor(Date.now() / 3600000)}`, {
            type: 'detection_anomaly',
            severity: 'warn',
            message: `${shortName(setup.symbol)} quote ${(deviation * 100).toFixed(1)}% off entry — skipping`,
            data: { symbol: setup.symbol, entry: referencePx, badQuote: currentPrice },
          });
          console.log(` bad quote ${currentPrice} vs entry ${referencePx}, skipping`);
          continue;
        }
      }

      // Phase 3: For confirmed continuations, evaluate using CONT direction + levels
      const effectiveType = setup.ltfConfirmed && setup.suggestedDirection ? setup.suggestedDirection : setup.type;
      const isLong = effectiveType.includes('LONG');
      const isShort = effectiveType.includes('SHORT');
      const effectiveSL = setup.ltfConfirmed && setup.continuationLevels?.sl != null ? setup.continuationLevels.sl : setup.sl;
      const effectiveTP1 = setup.ltfConfirmed && setup.continuationLevels?.tp1 != null ? setup.continuationLevels.tp1 : setup.tp1;
      const effectiveTP2 = setup.ltfConfirmed && setup.continuationLevels?.tp2 != null ? setup.continuationLevels.tp2 : setup.tp2;
      const effectiveTP3 = setup.tp3;

      // Track max favorable/adverse excursion + the latest observed price.
      setup.lastPrice = currentPrice;
      if (isLong) {
        if (!setup.maxFavorable || currentPrice > setup.maxFavorable) setup.maxFavorable = currentPrice;
        if (!setup.maxAdverse || currentPrice < setup.maxAdverse) setup.maxAdverse = currentPrice;
      } else {
        if (!setup.maxFavorable || currentPrice < setup.maxFavorable) setup.maxFavorable = currentPrice;
        if (!setup.maxAdverse || currentPrice > setup.maxAdverse) setup.maxAdverse = currentPrice;
      }

      // Trigger detection: has price reached the entry zone (limit order fill)?
      // For shorts: triggered when price rises into the zone (high ≥ zone low / entry).
      // For longs: triggered when price falls into the zone (low ≤ zone high / entry).
      let justTriggered = false;
      if (!setup.triggered) {
        const zone = setup.entryZone;
        let triggerHit = false;
        let triggerLevel = null;
        if (zone) {
          if (isLong) {
            if (currentPrice <= zone.high) { triggerHit = true; triggerLevel = zone.high; }
          } else {
            if (currentPrice >= zone.low) { triggerHit = true; triggerLevel = zone.low; }
          }
        } else if (setup.entryPrice != null) {
          // Setup with single entry price (continuations) — triggered if price has moved through entry.
          const buffer = setup.entryPrice * 0.0003;
          if (isLong) {
            if (currentPrice <= setup.entryPrice + buffer) { triggerHit = true; triggerLevel = setup.entryPrice; }
          } else {
            if (currentPrice >= setup.entryPrice - buffer) { triggerHit = true; triggerLevel = setup.entryPrice; }
          }
        }
        if (triggerHit) {
          setup.triggered = true;
          setup.triggerPrice = currentPrice;
          setup.triggerLevel = triggerLevel;
          setup.triggerTime = new Date().toISOString();
          justTriggered = true;
        }
      }

      // Skip TP/SL evaluation when the setup *just* triggered this pass — the
      // trigger price IS the current price, so any "hit" would be a 0p phantom.
      // Wait for the next pass to evaluate real movement.
      if (justTriggered) {
        const priceDigits = setup.symbol.includes('JPY') ? 2 : 4;
        console.log(` triggered at ${currentPrice.toFixed(priceDigits)} (will evaluate next pass)`);
        notify({
          title: `🎯 ${shortName(setup.symbol)} ${shortType(effectiveType)} triggered`,
          message: `Filled at ${currentPrice.toFixed(priceDigits)} | watching for SL/TP`,
          priority: 1,
          sound: 'incoming',
        });
        continue;
      }

      // TP3-trail mode: setup hit TP3 on a prior pass and is now trailing.
      // SL trails to the TP3 price; we ping every 30 pips of further extension
      // and close when price retraces to the trail SL.
      if (setup.tp3Trailing) {
        const pipMul = setup.symbol.includes('JPY') ? 100 : 10000;
        const priceDigits = setup.symbol.includes('JPY') ? 2 : 4;
        const trailSL = setup.trailSL;
        const refPx = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
        const slRetraced = isLong ? currentPrice <= trailSL : currentPrice >= trailSL;
        if (slRetraced) {
          setup.status = 'tp3_extended';
          setup.outcome = 'win';
          setup.exitPrice = currentPrice;
          setup.exitTime = new Date().toISOString();
          log.health.wins++;
          log.health.pending--;
          const totalPips = refPx != null ? Math.round((isLong ? currentPrice - refPx : refPx - currentPrice) * pipMul) : 0;
          console.log(` TP3-TRAIL CLOSED at ${currentPrice.toFixed(priceDigits)} (+${totalPips}p total)`);
          notify({
            title: `🏁 ${shortName(setup.symbol)} ${shortType(effectiveType)} trail closed`,
            message: `Exit ${currentPrice.toFixed(priceDigits)} | +${totalPips}p total`,
            priority: 0,
            sound: 'cashregister',
          });
          continue;
        }
        // Still trailing — check extension milestone (every 30p past TP3)
        const extensionPips = Math.round((isLong ? currentPrice - trailSL : trailSL - currentPrice) * pipMul);
        const lastMilestone = setup.trailLastMilestone || 0;
        if (extensionPips >= lastMilestone + 30) {
          setup.trailLastMilestone = Math.floor(extensionPips / 30) * 30;
          const totalPips = refPx != null ? Math.round((isLong ? currentPrice - refPx : refPx - currentPrice) * pipMul) : 0;
          notify({
            title: `📈 ${shortName(setup.symbol)} ${shortType(effectiveType)} extending`,
            message: `Now ${currentPrice.toFixed(priceDigits)} | +${totalPips}p (${extensionPips}p past TP3)`,
            priority: -1,
          });
        }
        console.log(` trailing past TP3 (+${extensionPips}p extension)`);
        continue;
      }

      // Check if SL hit (uses effective levels — CONT-direction for confirmed continuations)
      if (effectiveSL != null) {
        const slHit = isLong ? currentPrice <= effectiveSL : currentPrice >= effectiveSL;
        if (slHit) {
          setup.status = 'stopped';
          setup.outcome = 'loss';
          setup.exitPrice = currentPrice;
          setup.exitTime = new Date().toISOString();
          log.health.losses++;
          log.health.pending--;
          console.log(` STOPPED at ${currentPrice.toFixed(4)} (loss)`);
          const pipMul = setup.symbol.includes('JPY') ? 100 : 10000;
          const refPx = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
          const lossPips = refPx != null ? Math.round((isLong ? currentPrice - refPx : refPx - currentPrice) * pipMul) : 0;
          notify({
            title: `❌ ${shortName(setup.symbol)} ${shortType(effectiveType)} stopped`,
            message: `Exit ${currentPrice.toFixed(setup.symbol.includes('JPY') ? 2 : 4)} | ${lossPips}p`,
            priority: 0,
          });
          continue;
        }
      }

      // Check TP hits (highest first)
      const notifyTP = (level) => {
        const pipMul = setup.symbol.includes('JPY') ? 100 : 10000;
        const refPx = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
        const gainPips = refPx != null ? Math.round((isLong ? currentPrice - refPx : refPx - currentPrice) * pipMul) : 0;
        notify({
          title: `✅ ${shortName(setup.symbol)} ${shortType(effectiveType)} ${level}`,
          message: `Exit ${currentPrice.toFixed(setup.symbol.includes('JPY') ? 2 : 4)} | +${gainPips}p`,
          priority: 0,
          sound: 'cashregister',
        });
      };
      if (effectiveTP3 != null) {
        // Direction guard: TP3 must be on the favorable side of entry. If the
        // setup direction was flipped (e.g., REV LONG re-suggested as CONT SHORT)
        // without ltfConfirmed, the stored TP3 may be from the original direction
        // and sit on the WRONG side of entry — which triggers phantom hits.
        // Symptom in production: EURNZD CONT LONG with tp3Trailing=true but MFE=0.
        const refPx = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
        const tp3OnCorrectSide = refPx == null || (isLong ? effectiveTP3 > refPx : effectiveTP3 < refPx);
        if (!tp3OnCorrectSide) {
          observeOnce(`TP3_WRONGSIDE:${setup.symbol}:${setup.id ?? setup.timestamp}`, {
            type: 'detection_anomaly',
            severity: 'warn',
            message: `${shortName(setup.symbol)} TP3 on wrong side of entry — skipping hit`,
            data: { symbol: setup.symbol, direction: effectiveType, entry: refPx, tp3: effectiveTP3 },
          });
        }
        const tp3Hit = tp3OnCorrectSide && (isLong ? currentPrice >= effectiveTP3 : currentPrice <= effectiveTP3);
        if (tp3Hit) {
          // Enter trail mode instead of closing — let runners run, ping on extensions.
          // Status stays 'pending' but the trail block (above) handles future passes.
          setup.tp3Trailing = true;
          setup.tp3HitTime = new Date().toISOString();
          setup.tp3HitPrice = currentPrice;
          setup.trailSL = effectiveTP3;
          setup.trailLastMilestone = 0;
          const priceDigits = setup.symbol.includes('JPY') ? 2 : 4;
          const pipMul = setup.symbol.includes('JPY') ? 100 : 10000;
          const refPx = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
          const gainPips = refPx != null ? Math.round((isLong ? currentPrice - refPx : refPx - currentPrice) * pipMul) : 0;
          console.log(` TP3 HIT at ${currentPrice.toFixed(priceDigits)} → entering trail mode (SL @ ${effectiveTP3.toFixed(priceDigits)})`);
          notify({
            title: `✅ ${shortName(setup.symbol)} ${shortType(effectiveType)} TP3 hit`,
            message: `Now ${currentPrice.toFixed(priceDigits)} | +${gainPips}p | Trail SL @ ${effectiveTP3.toFixed(priceDigits)} — extensions will ping`,
            priority: 1,
            sound: 'cashregister',
          });
          continue;
        }
      }
      if (effectiveTP2 != null) {
        const tp2Hit = isLong ? currentPrice >= effectiveTP2 : currentPrice <= effectiveTP2;
        if (tp2Hit) {
          setup.status = 'tp2_hit';
          setup.outcome = 'win';
          setup.exitPrice = currentPrice;
          setup.exitTime = new Date().toISOString();
          log.health.wins++;
          log.health.pending--;
          console.log(` TP2 HIT at ${currentPrice.toFixed(4)} (win)`);
          notifyTP('TP2 hit');
          continue;
        }
      }
      if (effectiveTP1 != null) {
        const tp1Hit = isLong ? currentPrice >= effectiveTP1 : currentPrice <= effectiveTP1;
        if (tp1Hit) {
          setup.status = 'tp1_hit';
          setup.outcome = 'win';
          setup.exitPrice = currentPrice;
          setup.exitTime = new Date().toISOString();
          log.health.wins++;
          log.health.pending--;
          console.log(` TP1 HIT at ${currentPrice.toFixed(4)} (win)`);
          notifyTP('TP1 hit');
          continue;
        }
      }

      // Momentum-confirmation alert — fires for triggered setups moving
      // favorably so the user can enter on confirmation. Once per setup
      // lifetime (24h cooldown via notifyOnce).
      //
      // v3 (2026-07-05) — retuned after week 2 showed 0% recall on real
      // top-5 winners (USDJPY REV SHORT +92p, CADJPY REV LONG +86p, etc.).
      // Both took ~38h from trigger→TP1 with most of the move driven by
      // NFP 30h after entry. The 8h window and 80% sustained rule both
      // ruled them out.
      //   * Window 8h → 24h (macro reversals mature over a full day)
      //   * Sustained 0.80 → 0.60 (chop-before-extension is normal;
      //     60% still guards against pinging on faded trades)
      //   * Move / room thresholds unchanged — those are fine
      if (setup.triggered && setup.triggerTime && effectiveTP1 != null) {
        const hoursSinceTrigger = (Date.now() - new Date(setup.triggerTime).getTime()) / 3600000;
        const refPx = setup.triggerPrice ?? setup.entryLevel ?? setup.entryPrice;
        if (refPx != null && hoursSinceTrigger > 0 && hoursSinceTrigger <= 24) {
          const pipMul = setup.symbol.includes('JPY') ? 100 : 10000;
          const priceDigits = setup.symbol.includes('JPY') ? 2 : 4;
          const plPips = Math.round((isLong ? currentPrice - refPx : refPx - currentPrice) * pipMul);
          // Risk proxy: SL distance when available, else half the TP1 distance.
          const tp1DistFromEntry = Math.abs(refPx - effectiveTP1) * pipMul;
          const slDistPips = effectiveSL != null
            ? Math.round(Math.abs(refPx - effectiveSL) * pipMul)
            : Math.round(tp1DistFromEntry / 2);
          const tp1DistFromNow = Math.round((isLong ? effectiveTP1 - currentPrice : currentPrice - effectiveTP1) * pipMul);
          const rAchieved = slDistPips > 0 ? plPips / slDistPips : 0;
          const rRemaining = slDistPips > 0 ? tp1DistFromNow / slDistPips : 0;
          const mfePipsFromRef = setup.maxFavorable != null
            ? Math.round((isLong ? setup.maxFavorable - refPx : refPx - setup.maxFavorable) * pipMul)
            : plPips;
          const sustained = mfePipsFromRef > 0 ? plPips / mfePipsFromRef >= 0.6 : false;
          // Fire if EITHER 0.3R gain OR 25 pips absolute — whichever hits first.
          const meetsRThreshold = rAchieved >= 0.3;
          const meetsPipThreshold = plPips >= 25;
          const meetsMoveThreshold = meetsRThreshold || meetsPipThreshold;
          // Room-to-run: 1R remaining, or if no SL then TP1 must be ≥30p away.
          const meetsRoomThreshold = rRemaining >= 1.0 || tp1DistFromNow >= 30;
          const fireMomentum = meetsMoveThreshold && meetsRoomThreshold && sustained && plPips > 0;
          if (fireMomentum) {
            const slLine = effectiveSL != null
              ? `MFE +${mfePipsFromRef}p (${Math.round(plPips / mfePipsFromRef * 100)}% of high)`
              : `MFE +${mfePipsFromRef}p — ⚠️ NO SL SET`;
            notifyOnce(`MOMENTUM:${setup.symbol}:${setup.triggerTime}`, {
              title: `🚀 ${shortName(setup.symbol)} ${shortType(effectiveType)} — momentum favorable`,
              message: `Triggered ${hoursSinceTrigger.toFixed(1)}h ago @ ${refPx.toFixed(priceDigits)}
Now ${currentPrice.toFixed(priceDigits)} (+${plPips}p, ${rAchieved.toFixed(1)}R)
${slLine}
TP1 ${effectiveTP1.toFixed(priceDigits)} = +${tp1DistFromNow}p (${rRemaining.toFixed(1)}R remaining)`,
              priority: 1,
              sound: 'incoming',
            }, 24 * 3600 * 1000);
            console.log(` 🚀 MOMENTUM ALERT (${plPips}p / ${rAchieved.toFixed(1)}R, ${hoursSinceTrigger.toFixed(1)}h old)`);
          }
        }
      }

      // Still pending
      const pnlPips = isLong ? currentPrice - setup.entryPrice : setup.entryPrice - currentPrice;
      const direction = pnlPips >= 0 ? 'favorable' : 'adverse';
      console.log(` still pending (${direction}, ${marketHours.toFixed(0)} market hrs)`);

    } catch (err) {
      console.log(` error: ${err.message}`);
    }
  }

  // Update totals
  log.health.total = log.setups.length;
  log.health.pending = log.setups.filter(s => s.status === 'pending').length;
  saveAuditLog(log);

  // Stat-pattern: pairs with 3+ stops in last 24h. Repeated stops on a single
  // pair usually mean the SL distance is miscalibrated OR the direction read
  // is wrong for the current regime — both are dev-actionable. We fire one
  // observation per qualifying pair per review; duplicates across passes are
  // intentional (they reinforce the pattern).
  const stopCutoff = Date.now() - 24 * 3600000;
  const recentStops = log.setups.filter(s =>
    s.status === 'stopped' && s.exitTime && new Date(s.exitTime).getTime() >= stopCutoff
  );
  const stopsByPair = {};
  for (const s of recentStops) {
    stopsByPair[s.symbol] = (stopsByPair[s.symbol] || 0) + 1;
  }
  for (const [symbol, count] of Object.entries(stopsByPair)) {
    if (count >= 3) {
      // 6h cooldown — one observation per pair per session, not per scan pass.
      // Yesterday's brief showed 18 duplicates in 15h from the un-dedup'd version.
      observeOnce(`STOPPED3X:${symbol}`, {
        type: 'stat_pattern',
        severity: 'warn',
        message: `${shortName(symbol)} stopped ${count}× in last 24h`,
        data: {
          symbol,
          stopCount: count,
          windowHours: 24,
        },
      });
    }
  }

  // ── NEWS AHEAD FOR OPEN TRADES (next 24h) ──
  // The scan-time news check only catches news at entry. This catches news
  // that landed in the calendar *after* the setup was logged, so an open
  // trade doesn't get blindsided by mid-position events.
  const stillPending = log.setups.filter(s => s.status === 'pending');
  if (stillPending.length > 0) {
    try {
      const newsEvents = await getHighImpactNews();
      const tradesWithNews = [];
      for (const setup of stillPending) {
        const warnings = getNewsWarnings(setup.symbol, newsEvents)
          .filter(w => parseFloat(w.hoursUntil) >= -1 && parseFloat(w.hoursUntil) < 24);
        if (warnings.length > 0) tradesWithNews.push({ setup, warnings });
      }

      if (tradesWithNews.length > 0) {
        const shortType = (t) =>
          t === 'REVERSAL LONG' ? 'REV LONG' :
          t === 'REVERSAL SHORT' ? 'REV SHORT' :
          t === 'CONTINUATION LONG' ? 'CONT LONG' :
          t === 'CONTINUATION SHORT' ? 'CONT SHORT' : t;
        console.log(`\n  ⚠️  NEWS AHEAD FOR OPEN TRADES (next 24h)`);
        console.log(`  ${'─'.repeat(95)}`);
        for (const { setup, warnings } of tradesWithNews) {
          const sym = shortName(setup.symbol);
          const dir = setup.ltfConfirmed && setup.suggestedDirection ? setup.suggestedDirection : setup.type;
          for (const w of warnings) {
            const hrs = parseFloat(w.hoursUntil);
            const icon = hrs < 4 ? '🔴' : hrs < 12 ? '🟠' : '🟡';
            const hrsStr = hrs < 0 ? `${Math.abs(hrs).toFixed(1)}h ago` : `in ${hrs.toFixed(1)}h`;
            console.log(`  ${sym.padEnd(8)} ${shortType(dir).padEnd(12)} → ${icon} ${w.currency} ${w.title}`);
            console.log(`  ${''.padEnd(22)}   ${hrsStr}  (F: ${w.forecast} / P: ${w.previous})`);
            // Push only for events within 4h of an open trade — 12-24h window is
            // informational and would spam. Dedupe per (setup, event) so the same
            // event doesn't fire on every 15-min scan.
            if (hrs >= -1 && hrs < 4) {
              const key = `NEWSOPEN:${setup.symbol}:${w.currency}:${w.title}:${w.date}`;
              notifyOnce(key, {
                title: `${icon} ${sym} news in ${hrs.toFixed(1)}h`,
                message: `${w.currency} ${w.title} (F:${w.forecast} P:${w.previous}) — open ${shortType(dir)} trade`,
                priority: 1,
                sound: 'siren',
              }, 12 * 3600 * 1000);
            }
          }
        }
        console.log(`  ${'─'.repeat(95)}\n`);
      }
    } catch (e) {
      // News check is informational only — never block the review pass
    }
  }

  // Print health report
  printHealthReport(log);
}

function printHealthReport(log) {
  // ──────────────────────────────────────────────────────────
  // Quality tiers:
  // TRADEABLE = HTF-aligned 4★+ OR Macro Reversal high/mod conf
  // LOW-TIER  = HTF-aligned <4★ OR Macro Reversal low conf
  // INFO      = Pullback alerts (never traded in original direction)
  // ──────────────────────────────────────────────────────────
  const isStrong = (s) => {
    if (s.pullbackAlert && s.ltfConfirmed) return true;  // Phase 3: confirmed continuations are tradeable
    if (s.pullbackAlert) return false;
    if (s.macroReversal) return s.macroConfidence === 'high' || s.macroConfidence === 'moderate';
    return s.strength >= 4;  // HTF-aligned
  };

  const tradeable = log.setups.filter(s => isStrong(s));
  const lowTier = log.setups.filter(s => !s.pullbackAlert && !isStrong(s));
  const pullback = log.setups.filter(s => s.pullbackAlert && !s.ltfConfirmed);

  const stats = (setups) => {
    const wins = setups.filter(s => s.outcome === 'win').length;
    const losses = setups.filter(s => s.outcome === 'loss').length;
    const pending = setups.filter(s => s.status === 'pending').length;
    const expired = setups.filter(s => s.outcome === 'expired').length;
    const decided = wins + losses;
    const winRate = decided > 0 ? (wins / decided * 100).toFixed(1) : '—';
    const grade = decided < 5 ? 'Too early'
      : wins / decided >= 0.70 ? 'A+ — Outstanding'
      : wins / decided >= 0.65 ? 'A — Excellent'
      : wins / decided >= 0.55 ? 'B — Good'
      : wins / decided >= 0.45 ? 'C — Fair'
      : wins / decided >= 0.35 ? 'D — Needs tuning'
      : 'F — Broken';
    return { wins, losses, pending, expired, decided, winRate, grade, total: setups.length };
  };

  const main = stats(tradeable);
  const low = stats(lowTier);
  const pull = stats(pullback);

  // Tradeable breakdown by source category
  const tradeableHTF = tradeable.filter(s => !s.macroReversal && !s.pullbackAlert);
  const tradeableMacro = tradeable.filter(s => s.macroReversal);
  const tradeableCont = tradeable.filter(s => s.pullbackAlert && s.ltfConfirmed);
  const htfStats = stats(tradeableHTF);
  const macroStats = stats(tradeableMacro);
  const contStats = stats(tradeableCont);

  // Low-tier breakdown by source
  const lowHTF = lowTier.filter(s => !s.macroReversal);
  const lowMacro = lowTier.filter(s => s.macroReversal);
  const lowHtfStats = stats(lowHTF);
  const lowMacroStats = stats(lowMacro);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  SCANNER HEALTH REPORT`);
  console.log(`${'═'.repeat(60)}`);

  // ── PRIMARY: TRADEABLE PERFORMANCE ──
  console.log(`\n  📊 TRADEABLE PERFORMANCE (what you'd actually trade)`);
  console.log(`  ${'─'.repeat(56)}`);
  console.log(`  Total: ${main.total}  |  W: ${main.wins}  L: ${main.losses}  P: ${main.pending}  E: ${main.expired}`);
  console.log(`  Win Rate: ${main.winRate}%  |  Grade: ${main.grade}`);
  console.log(`    HTF-Aligned 4★+:        ${htfStats.wins}W / ${htfStats.losses}L  (${htfStats.winRate}%)`);
  console.log(`    Macro Reversal strong:  ${macroStats.wins}W / ${macroStats.losses}L  (${macroStats.winRate}%)`);
  console.log(`    Confirmed Continuation: ${contStats.wins}W / ${contStats.losses}L  (${contStats.winRate}%)`);

  // ── FILTER VALIDATION: LOW-TIER + PULLBACKS ──
  console.log(`\n  🔍 FILTER VALIDATION (signals the scanner says to skip)`);
  console.log(`  ${'─'.repeat(56)}`);
  console.log(`    HTF-Aligned <4★:        ${lowHtfStats.wins}W / ${lowHtfStats.losses}L  (${lowHtfStats.winRate}%)`);
  console.log(`    Macro Reversal low:     ${lowMacroStats.wins}W / ${lowMacroStats.losses}L  (${lowMacroStats.winRate}%)`);
  console.log(`    Pullback Alerts:        ${pull.wins}W / ${pull.losses}L  (${pull.winRate}%)`);
  const lowAllDecided = low.decided + pull.decided;
  const lowAllWins = low.wins + pull.wins;
  if (lowAllDecided >= 10) {
    const lowAllRate = (lowAllWins / lowAllDecided * 100).toFixed(1);
    const filterWorking = lowAllWins / lowAllDecided < 0.55;
    console.log(`    Combined filtered:      ${lowAllWins}W / ${lowAllDecided - lowAllWins}L  (${lowAllRate}%) ${filterWorking ? '✓ filter working' : ''}`);
  }

  console.log(`${'─'.repeat(60)}\n`);
}

// ─── Entry point ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const once = args.includes('--once');
const reviewMode = args.includes('--review');
const pairArg = args.find((a, i) => args[i - 1] === '--pairs');
const pairs = pairArg
  ? pairArg.split(',').map(p => p.includes(':') ? p : `OANDA:${p}`)
  : ALL_PAIRS;

const SCAN_INTERVAL = 15 * 60 * 1000;  // 15 minutes between full scans

async function main() {
  console.log(`\nSetup Scanner v2.0`);

  if (reviewMode) {
    console.log(`Mode: review past setups`);
    console.log(`${'─'.repeat(60)}`);
    await reviewSetups();
    return;
  }

  console.log(`Pairs: ${pairs.length}`);
  console.log(`Mode: ${once ? 'single scan' : `continuous (every ${SCAN_INTERVAL / 60000} min)`}`);
  console.log(`${'─'.repeat(60)}`);

  do {
    // Forex weekend pause — skip everything Fri 22:00 UTC → Sun 22:00 UTC.
    // --once still runs so manual triggers work; only continuous mode pauses.
    const msUntilOpen = msUntilMarketOpen();
    if (!once && msUntilOpen > 0) {
      const hrsUntil = (msUntilOpen / 3600000).toFixed(1);
      const reopenAt = new Date(Date.now() + msUntilOpen).toISOString();
      console.log(`\n[${now()}] 💤 Market closed — sleeping ${hrsUntil}h until ${reopenAt}\n`);
      await sleep(msUntilOpen);
      continue;
    }

    // Review pending setups first
    const log = loadAuditLog();
    if (log.setups.filter(s => s.status === 'pending').length > 0) {
      await reviewSetups();
    }

    // Scan for new setups
    const alerts = await scanAll(pairs);
    await printReport(alerts);

    // Log new setups to audit
    if (alerts.length > 0) {
      const pendingCount = logSetups(alerts);
      console.log(`  [Audit] ${alerts.length} setup(s) logged. ${pendingCount} total pending.`);
    }

    // Scan-summary pings removed by request — too noisy. Audit log still
    // captures the count; phone only sees actionable transitions (🌟 ALL GREEN,
    // TP/SL hits, news <4h).

    // Refresh brief_data.json so scheduled brief agents (cloud-run /schedule
    // routines) see the latest aggregates without needing to parse the full
    // scanner_audit.json (which is gitignored).
    try {
      const auditForBrief = loadAuditLog();
      generateBriefData(auditForBrief);
    } catch (e) {
      console.log(`  [brief_data] regenerate failed: ${e.message}`);
    }

    // Auto-push (env-gated): commit observations.jsonl + brief_data.json so
    // the cloud-scheduled brief agent picks up production state. Default OFF
    // — set AUTO_PUSH_ENABLED=1 in .env on the production VM to enable.
    if (process.env.AUTO_PUSH_ENABLED === '1') {
      try {
        execSync('git add observations.jsonl brief_data.json 2>/dev/null', { stdio: 'pipe' });
        const status = execSync('git diff --cached --name-only', { stdio: 'pipe' }).toString().trim();
        if (status) {
          const msg = `chore(prod): scanner state @ ${new Date().toISOString()}`;
          execSync(`git commit -m "${msg}" --quiet`, { stdio: 'pipe' });
          execSync('git push origin main --quiet', { stdio: 'pipe' });
          console.log(`  [auto-push] state synced (${status.split('\n').length} file(s))`);
        }
      } catch (e) {
        // Never block the scanner — push failures are informational only.
        console.log(`  [auto-push] skipped: ${e.message.split('\n')[0]}`);
      }
    }

    if (!once) {
      console.log(`\n[${now()}] Next scan in ${SCAN_INTERVAL / 60000} minutes. Press Ctrl+C to stop.\n`);
      await sleep(SCAN_INTERVAL);
    }
  } while (!once);
}

main()
  .catch(err => {
    console.error('Scanner error:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect();
  });
