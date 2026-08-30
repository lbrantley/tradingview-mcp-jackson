/**
 * Economic calendar, lifted out of the retired scanner so anything can use it.
 *
 * Faireconomy serves THIS WEEK and NEXT WEEK only — no archive, and it is rate
 * limited to two pulls per five minutes. So every pull is also written to
 * news_history/ as a dated snapshot. That costs nothing and, run weekly, builds
 * the history nobody will sell us cheaply. A pull today covers the whole week,
 * so a missed day is not a missed week.
 *
 * Fields the feed carries: title, country, date, impact, forecast, previous.
 * No `actual` — the forward feed cannot know it. That is fine for an AVOIDANCE
 * filter, which only needs to know an event was SCHEDULED. Testing news as an
 * amplifier would need actual-vs-forecast, and that needs a paid source.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIST = join(REPO, 'news_history');
const OVERRIDES = join(REPO, 'news_overrides.json');

const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

/** Which pairs a currency's news can move. */
export const CURRENCY_PAIRS = {
  USD: ['GBPUSD','EURUSD','USDJPY','USDCAD','USDCHF','AUDUSD','NZDUSD'],
  GBP: ['GBPUSD','GBPJPY','GBPCHF','GBPNZD','GBPCAD','GBPAUD','EURGBP'],
  EUR: ['EURUSD','EURJPY','EURCHF','EURNZD','EURCAD','EURAUD','EURGBP'],
  JPY: ['USDJPY','GBPJPY','EURJPY','AUDJPY','NZDJPY','CADJPY','CHFJPY'],
  CAD: ['USDCAD','GBPCAD','EURCAD','AUDCAD','NZDCAD','CADCHF','CADJPY'],
  AUD: ['AUDUSD','AUDJPY','AUDNZD','AUDCAD','AUDCHF','EURAUD','GBPAUD'],
  NZD: ['NZDUSD','NZDJPY','NZDCAD','NZDCHF','AUDNZD','EURNZD','GBPNZD'],
  CHF: ['USDCHF','GBPCHF','EURCHF','AUDCHF','NZDCHF','CADCHF','CHFJPY'],
};

async function pull(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`calendar ${res.status} ${url}`);
  return res.json();
}

/** Manual additions. The feed drops CAD events and others often enough to matter. */
function overrides() {
  if (!existsSync(OVERRIDES)) return [];
  try {
    const o = JSON.parse(readFileSync(OVERRIDES, 'utf8'));
    return Array.isArray(o) ? o : (o.events || []);
  } catch { return []; }
}

/** Dedupe by currency + title within two hours — screenshot times drift an hour. */
function merge(feed, extra) {
  const all = [...feed];
  for (const e of extra) {
    const t = Date.parse(e.date);
    const i = all.findIndex(x => x.country === e.country && x.title === e.title &&
      Math.abs(Date.parse(x.date) - t) <= 7200000);
    if (i >= 0) all[i] = e; else all.push(e);
  }
  return all;
}

/** Fetch, merge, and snapshot to news_history/. */
export async function getCalendar({ snapshot = true } = {}) {
  const parts = await Promise.all(FEEDS.map(u => pull(u).catch(() => [])));
  const feed = parts.flat();
  if (!feed.length) throw new Error('calendar feed returned nothing');
  const events = merge(feed, overrides())
    .filter(e => e.date && e.country)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (snapshot) {
    if (!existsSync(HIST)) mkdirSync(HIST, { recursive: true });
    const stamp = events[0].date.slice(0, 10);
    writeFileSync(join(HIST, `ff_${stamp}.json`), JSON.stringify(events, null, 1));
  }
  return events;
}

/** High-impact events touching `sym`, inside a window around `at`. */
export function eventsFor(events, sym, at = new Date(), { hoursAhead = 24, hoursBack = 2, impact = 'High' } = {}) {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  const ccy = [sym.slice(0, 3), sym.slice(3)];
  return events.filter(e => {
    if (impact && e.impact !== impact) return false;
    if (!ccy.includes(e.country)) return false;
    const d = Date.parse(e.date) - t;
    return d >= -hoursBack * 3600e3 && d <= hoursAhead * 3600e3;
  });
}

/** What has been captured so far. */
export function historyRange() {
  if (!existsSync(HIST)) return { files: 0, from: null, to: null };
  const f = readdirSync(HIST).filter(x => x.endsWith('.json')).sort();
  return { files: f.length, from: f[0]?.slice(3, 13) ?? null, to: f[f.length - 1]?.slice(3, 13) ?? null };
}
