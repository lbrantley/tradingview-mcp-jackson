/**
 * Currency index reader + cache.
 *
 * Reads the 8 TVC currency indices from TradingView and computes structural
 * context (recent range position, % change, HTF trend direction). Cached to
 * disk with 4h TTL so scanner passes don't pay the ~60s CDP cost every time.
 *
 * User tracks these in TV manually (see user_currency_indices_tracking memory).
 * Scanner now uses them as HTF structural filter for pair-level setups.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setSymbol, setTimeframe } from './core/chart.js';
import { getOhlcv } from './core/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', 'currency_index_cache.json');
const SETTLE_MS = 2500;
const DEFAULT_TTL_MS = 4 * 3600 * 1000; // 4h

// The 8 major currency indices, TVC provider. Order matters for display.
export const INDICES = [
  { symbol: 'TVC:DXY', currency: 'USD', label: 'DXY' },
  { symbol: 'TVC:EXY', currency: 'EUR', label: 'EXY' },
  { symbol: 'TVC:BXY', currency: 'GBP', label: 'BXY' },
  { symbol: 'TVC:JXY', currency: 'JPY', label: 'JXY' },
  { symbol: 'TVC:AXY', currency: 'AUD', label: 'AXY' },
  { symbol: 'TVC:CXY', currency: 'CAD', label: 'CXY' },
  { symbol: 'TVC:SXY', currency: 'CHF', label: 'SXY' },
  { symbol: 'TVC:ZXY', currency: 'NZD', label: 'ZXY' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function computeSummary(bars) {
  if (!bars || bars.length < 20) return null;
  const recent = bars.slice(-60); // last ~60 days
  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeSize = rangeHigh - rangeLow;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  const positionPct = rangeSize > 0 ? (last.close - rangeLow) / rangeSize : 0.5;
  const zone = positionPct > 0.70 ? 'premium'
             : positionPct < 0.30 ? 'discount'
             : 'mid';
  const dayChangePct = prev ? ((last.close - prev.close) / prev.close * 100) : 0;

  // HTF trend: is close above/below the 20 & 50 day moving average?
  const ma20 = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const ma50 = bars.length >= 50 ? bars.slice(-50).reduce((s, b) => s + b.close, 0) / 50 : null;
  const trend = ma50 != null
    ? (last.close > ma20 && ma20 > ma50 ? 'up'
       : last.close < ma20 && ma20 < ma50 ? 'down'
       : 'mixed')
    : (last.close > ma20 ? 'up' : 'down');

  return {
    lastClose: last.close,
    dayChangePct: +dayChangePct.toFixed(2),
    zone,
    positionPct: +positionPct.toFixed(2),
    rangeHigh: +rangeHigh.toFixed(4),
    rangeLow: +rangeLow.toFixed(4),
    trend,
    ma20: +ma20.toFixed(4),
    ma50: ma50 != null ? +ma50.toFixed(4) : null,
    lastBar: last.dateISO || last.time,
  };
}

export async function readCurrencyIndices(log = console.log) {
  const out = { generatedAt: new Date().toISOString(), indices: {} };
  await setTimeframe({ timeframe: 'D' });
  await sleep(SETTLE_MS);

  for (const idx of INDICES) {
    try {
      log(`  Loading ${idx.label} (${idx.symbol})...`);
      await setSymbol({ symbol: idx.symbol });
      await sleep(SETTLE_MS + 1500);
      const ohlcv = await getOhlcv({ count: 100, summary: false });
      const bars = (ohlcv?.bars || []).map(b => ({
        ...b,
        dateISO: new Date(b.time * 1000).toISOString().slice(0, 10),
      }));
      const summary = computeSummary(bars);
      if (summary) {
        out.indices[idx.currency] = { ...idx, ...summary };
      } else {
        log(`    (insufficient bars for ${idx.label})`);
      }
    } catch (e) {
      log(`    ${idx.label} error: ${e.message}`);
    }
  }

  try {
    writeFileSync(CACHE, JSON.stringify(out, null, 2));
    log(`  Cached to ${CACHE}`);
  } catch (e) {
    log(`  cache write failed: ${e.message}`);
  }
  return out;
}

/**
 * Load cached indices. Returns null if cache doesn't exist or is stale.
 */
export function loadCurrencyIndices(maxAgeMs = DEFAULT_TTL_MS) {
  if (!existsSync(CACHE)) return null;
  try {
    const data = JSON.parse(readFileSync(CACHE, 'utf8'));
    const ageMs = Date.now() - new Date(data.generatedAt).getTime();
    if (ageMs > maxAgeMs) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Look up a currency's index summary, or null if not cached.
 */
export function getIndex(cache, currency) {
  return cache?.indices?.[currency] || null;
}

/**
 * Given a forex pair symbol like 'OANDA:USDCAD' or 'USDCAD', return the
 * two currencies (base, quote).
 */
export function pairCurrencies(symbol) {
  const clean = symbol.replace(/^OANDA:/, '');
  return { base: clean.slice(0, 3), quote: clean.slice(3, 6) };
}

/**
 * Given a pair setup and cached indices, evaluate whether the currency
 * indices support the trade direction. Returns a short string suitable
 * for appending to a notification message.
 *
 * For a LONG on BASE/QUOTE:
 *   ✓ if BASE index is up and QUOTE index is down (both agree)
 *   ~ if one agrees and one disagrees (mixed)
 *   ✗ if both indices contradict the direction
 */
export function evaluatePairVsIndices(symbol, direction, cache) {
  if (!cache) return null;
  const { base, quote } = pairCurrencies(symbol);
  const baseIdx = getIndex(cache, base);
  const quoteIdx = getIndex(cache, quote);
  if (!baseIdx || !quoteIdx) return null;

  const isLong = direction.includes('LONG');
  // For LONG: want base strength (index up) + quote weakness (index down)
  const baseAligned = isLong ? baseIdx.trend === 'up' : baseIdx.trend === 'down';
  const quoteAligned = isLong ? quoteIdx.trend === 'down' : quoteIdx.trend === 'up';

  const glyph = (baseAligned && quoteAligned) ? '✓'
              : (baseAligned || quoteAligned) ? '~'
              : '✗';
  const label = (baseAligned && quoteAligned) ? 'both agree'
              : (baseAligned && !quoteAligned) ? `${base}✓ ${quote}✗`
              : (!baseAligned && quoteAligned) ? `${base}✗ ${quote}✓`
              : 'both contradict';

  const dayNote = `${base} ${baseIdx.dayChangePct >= 0 ? '+' : ''}${baseIdx.dayChangePct}% · ${quote} ${quoteIdx.dayChangePct >= 0 ? '+' : ''}${quoteIdx.dayChangePct}%`;

  return { glyph, label, dayNote, baseAligned, quoteAligned };
}
