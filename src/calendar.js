/**
 * ECONOMIC CALENDAR WITH ACTUALS — the piece that was missing.
 *
 * Faireconomy (src/news.js) serves this week and next, with forecast and
 * previous but NO actual. That is enough to warn about an event and useless for
 * testing one, because the surprise — actual minus forecast — is what moves
 * price. Without it, news has never been measurable.
 *
 * Everything else was a dead end: OANDA's labs calendar is edge-blocked (403
 * HTML, not an API error), Trading Economics discontinued its guest account,
 * FXStreet needs credentials, and Forex Factory sits behind Cloudflare.
 *
 * TradingView's calendar endpoint is open, needs no key, carries `actual`, and
 * returns data back to at least 2018 — covering every backtest window.
 *
 * It is UNDOCUMENTED and internal, so it can change without notice. Everything
 * fetched is therefore written to disk: the archive is the asset, the endpoint
 * is just how we fill it.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(REPO, 'calendar_history');
const HOST = 'https://economic-calendar.tradingview.com/events';
const CCY = ['US', 'CA', 'GB', 'EU', 'JP', 'AU', 'NZ', 'CH'];

/** TradingView country codes → the currency they move. */
const TO_CCY = { US: 'USD', CA: 'CAD', GB: 'GBP', EU: 'EUR', JP: 'JPY', AU: 'AUD', NZ: 'NZD', CH: 'CHF' };
/** importance: 1 high, 0 medium, -1 low. */
const TO_IMPACT = { 1: 'High', 0: 'Medium', '-1': 'Low' };

const num = v => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** One raw fetch. Keep windows small — the endpoint returns everything at once. */
export async function fetchRange(fromISO, toISO, { minImportance = 0 } = {}) {
  const url = `${HOST}?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}` +
    `&countries=${CCY.join(',')}&minImportance=${minImportance}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.tradingview.com' },
  });
  if (!res.ok) throw new Error(`calendar ${res.status} for ${fromISO.slice(0, 10)}`);
  const body = await res.json();
  if (body.status !== 'ok') throw new Error(`calendar status ${body.status}`);
  return (body.result || []).map(e => ({
    date: e.date,
    country: TO_CCY[e.country] ?? e.country,
    title: e.title,
    indicator: e.indicator,
    impact: TO_IMPACT[String(e.importance)] ?? 'Low',
    actual: num(e.actualRaw ?? e.actual),
    forecast: num(e.forecastRaw ?? e.forecast),
    previous: num(e.previousRaw ?? e.previous),
    unit: e.currency ?? null,
    source: e.source ?? null,
  })).filter(e => e.date && e.country);
}

/**
 * Surprise, normalised so it is comparable across indicators.
 *
 * Raw actual-minus-forecast is meaningless across a payrolls print measured in
 * thousands and a rate decision measured in basis points. Scaling by |forecast|
 * gives a proportion; where the forecast is near zero that blows up, so fall
 * back to the gap between forecast and previous as the yardstick for what a
 * normal move in this indicator looks like.
 *
 * Sign convention matches src/review_v2.js: positive means CURRENCY STRENGTH.
 */
export function surprise(e) {
  if (e.actual == null || e.forecast == null) return null;
  const t = (e.title || '').toLowerCase();
  const inverted = t.includes('unemployment') || t.includes('jobless') || t.includes('claimant');
  const diff = e.actual - e.forecast;
  const scale = Math.abs(e.forecast) > 1e-9 ? Math.abs(e.forecast)
    : (e.previous != null ? Math.abs(e.forecast - e.previous) : null);
  if (!scale) return null;
  const z = diff / scale;
  return inverted ? -z : z;
}

/** Fetch a span in chunks and archive each one. Returns everything fetched. */
export async function backfill(fromISO, toISO, { chunkDays = 30, minImportance = 0, pauseMs = 400 } = {}) {
  if (!existsSync(ARCHIVE)) mkdirSync(ARCHIVE, { recursive: true });
  const out = [];
  let cur = new Date(fromISO);
  const end = new Date(toISO);
  while (cur < end) {
    const next = new Date(Math.min(cur.getTime() + chunkDays * 86400e3, end.getTime()));
    const file = join(ARCHIVE, `tv_${cur.toISOString().slice(0, 10)}.json`);
    let batch;
    if (existsSync(file)) {
      batch = JSON.parse(readFileSync(file, 'utf8'));            // already have it
    } else {
      batch = await fetchRange(cur.toISOString(), next.toISOString(), { minImportance });
      writeFileSync(file, JSON.stringify(batch));
      await new Promise(r => setTimeout(r, pauseMs));            // be polite
    }
    out.push(...batch);
    cur = next;
  }
  return out;
}

/** Everything archived so far, in time order. */
export function loadArchive() {
  if (!existsSync(ARCHIVE)) return [];
  const all = [];
  for (const f of readdirSync(ARCHIVE).filter(x => x.endsWith('.json')).sort()) {
    try { all.push(...JSON.parse(readFileSync(join(ARCHIVE, f), 'utf8'))); } catch { /* skip */ }
  }
  const seen = new Set();
  return all.filter(e => {
    const k = `${e.date}|${e.country}|${e.title}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
}
