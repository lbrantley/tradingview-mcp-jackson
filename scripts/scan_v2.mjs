#!/usr/bin/env node
/**
 * SCANNER v2 — one level engine, three branches, decided by ROOM.
 *
 * Replaces scan_live.mjs, whose level_rejection setup was measured to have no
 * edge once two lookaheads were removed (see project-level-rejection-is-dead).
 *
 * The whole system reduces to one measurement taken before price arrives:
 * how much clear space is there between this level and the next one ahead?
 *
 *     room < 2 ATR   + closed through  ->  WALL BREAK
 *     room < 2 ATR   + rejected        ->  REVERSAL
 *     room > 8 ATR   + closed through  ->  OPEN FIELD BREAK
 *     3 - 8 ATR                        ->  nothing. measured dead zone.
 *
 * WHAT IS STRUCTURAL vs WHAT IS FITTED — worth keeping honest:
 *   structural   the level (2+ confirmed swings), room ahead, the close
 *                through, and the stop being anchored BEYOND the level
 *   fitted       the 0.5/1.5/2 ATR stop buffers, the ATR targets, the 2-6
 *                backup band, the 2 and 8 ATR room thresholds
 * Exits are the weak half and are parameters here for exactly that reason.
 *
 * Read-only. Prints alerts; places nothing.
 */
import { getCandles, getPricing, getSummary, LIVE_ACCOUNT_ID, ACCOUNT_ID } from '../src/oanda.js';
import { atr, sma, rsi, swings } from '../src/indicators.js';
import { buildZones } from '../src/structure.js';
import { getCalendar, eventsFor } from '../src/news.js';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import https from 'https';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(REPO, '.scan_v2_state.json');
const LOG = join(REPO, 'alerts_v2.jsonl');

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const UNITS = parseInt(argOf('--units') || '1000', 10);      // 0.01 lot
const SHOW_ALL = args.includes('--all');
const NOTIFY = args.includes('--notify');

/**
 * One batched push per scan, not one per setup. With 28 pairs this can produce
 * a handful of new setups at once and the old scanner's per-alert pings were
 * unreadable on a phone. Only NEW setups go out — the state file makes every
 * run idempotent, so a repeated setup is silent.
 */
function pushover(title, message) {
  if (!NOTIFY || process.env.PUSHOVER_ENABLED !== '1' || !process.env.PUSHOVER_TOKEN) return;
  const body = new URLSearchParams({
    token: process.env.PUSHOVER_TOKEN, user: process.env.PUSHOVER_USER,
    title, message: message.slice(0, 1024), priority: '0',
  }).toString();
  const req = https.request({
    hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', e => console.log(`  pushover failed: ${e.message}`));
  req.write(body); req.end();
}

/** Per-branch geometry. Fitted, not structural — swap freely as tests land. */
const SPEC = {
  WALL:  { stopATR: 0.5, targetATR: 8,  label: 'WALL BREAK'      },
  FIELD: { stopATR: 1.5, targetATR: 4,  label: 'OPEN FIELD BREAK'},
  REV:   { stopATR: 2.0, targetATR: 4,  label: 'REVERSAL'        },
};

const cst = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago',
  weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const dp = s => /JPY$/.test(s) ? 3 : 5;
const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;

const nav = await getSummary(LIVE_ACCOUNT_ID || ACCOUNT_ID).then(a => parseFloat(a.NAV)).catch(() => null);
const cal = await getCalendar().catch(() => []);
const seen = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const nowSeen = {};
const hits = [];

for (const sym of PAIRS) {
  try {
    const b = await getCandles(sym, { granularity: 'H4', count: 400 });
    const d = await getCandles(sym, { granularity: 'D', count: 200 });
    if (b.length < 300) continue;
    const i = b.length - 1;                       // last CLOSED H4 bar
    const a = atr(b, 14), cl = b.map(x => x.close);
    if (!a[i]) continue;
    const s50 = sma(cl, 50);
    const dRsi = rsi(d.map(x => x.close), 14);
    const dS50 = sma(d.map(x => x.close), 50);
    const zones = buildZones(b, { lookback: 5, tolATR: 0.5, minTouches: 2 })
      .filter(z => z.confirmedTime <= b[i].time);
    const sw = swings(b, 5);

    for (const z of zones) {
      if (!(b[i].low <= z.high && b[i].high >= z.low)) continue;   // not touching now
      const fromAbove = cl[i - 5] > z.price;
      const ahead = zones.filter(w => Math.abs(w.price - z.price) > a[i] * 0.5)
        .filter(w => fromAbove ? w.price < z.price : w.price > z.price)
        .sort((x, y) => Math.abs(x.price - z.price) - Math.abs(y.price - z.price));
      const behind = zones.filter(w => Math.abs(w.price - z.price) > a[i] * 0.5)
        .filter(w => fromAbove ? w.price > z.price : w.price < z.price)
        .sort((x, y) => Math.abs(x.price - z.price) - Math.abs(y.price - z.price));
      const room = ahead[0] ? Math.abs(ahead[0].price - z.price) / a[i] : 99;
      const backup = ahead.filter(w => Math.abs(w.price - z.price) <= a[i] * 8).length;

      const through = fromAbove ? b[i].close < z.low : b[i].close > z.high;
      const rejected = fromAbove ? b[i].close > z.high : b[i].close < z.low;
      let kind = null;
      if (through && room < 2 && backup >= 2 && backup <= 6) kind = 'WALL';
      else if (through && room > 8) kind = 'FIELD';
      else if (rejected && room < 2) kind = 'REV';
      if (!kind) continue;

      const sp = SPEC[kind];
      const dir = kind === 'REV' ? (fromAbove ? 1 : -1) : (fromAbove ? -1 : 1);
      const px = b[i].close;
      const stop = dir > 0 ? z.low - a[i] * sp.stopATR : z.high + a[i] * sp.stopATR;
      if (dir > 0 ? px <= stop : px >= stop) continue;
      const target = dir > 0 ? px + a[i] * sp.targetATR : px - a[i] * sp.targetATR;
      const risk = Math.abs(px - stop);
      const pip = pipOf(sym);
      const usdjpy = 147;                                   // rough, for the JPY quote conversion
      const riskUsd = risk * UNITS * (/JPY$/.test(sym) ? 1 / usdjpy : 1);

      // WHY THIS LEVEL — the provenance the user asked for, so it can be drawn
      const formedBy = [...sw.highs, ...sw.lows]
        .filter(k => Math.abs((z.kind === 'resistance' ? b[k].high : b[k].low) - z.price) <= (z.high - z.low) / 2)
        .sort((x, y) => x - y);

      const key = `${sym}:${kind}:${dir}:${z.price.toFixed(5)}`;
      nowSeen[key] = b[i].time;
      hits.push({
        sym, kind, dir, key, isNew: seen[key] !== b[i].time,
        level: z.price, band: [z.low, z.high], touches: z.touches,
        confirmedTime: z.confirmedTime, formedBy: formedBy.map(k => b[k].time),
        room, backup, px, stop, target, riskPips: risk / pip, riskUsd,
        // `ahead` and `behind` are measured in the BREAK direction, which is
        // right for classifying the setup but backwards for a reversal — that
        // trades the other way. Swap them so both branches report the levels in
        // the direction the TRADE is going.
        aheadLevels: (kind === 'REV' ? behind : ahead).slice(0, 3).map(w => w.price),
        behindLevels: (kind === 'REV' ? ahead : behind).slice(0, 2).map(w => w.price),
        vs50: (px - s50[i]) / a[i],
        dailyRsi: dRsi[d.length - 1], dailyTrend: d[d.length - 1].close > dS50[d.length - 1] ? 'up' : 'down',
        news: eventsFor(cal, sym, new Date(), { hoursAhead: 48 }).map(e => `${e.date.slice(5, 16)} ${e.country} ${e.title}`),
        time: b[i].time,
      });
    }
  } catch (e) { if (SHOW_ALL) console.log(`  ${sym}: ${e.message}`); }
}

// DEDUPE. Two zones a few pips apart are one wall, not two trades — the week-44
// review flagged this repeatedly (GBPCAD, AUDCAD, EURAUD all doubled). Keep the
// one with the most swings behind it; that is the better-evidenced level.
const merged = [];
for (const h of hits.sort((x, y) => y.touches - x.touches)) {
  const dup = merged.find(m => m.sym === h.sym && m.kind === h.kind && m.dir === h.dir &&
    Math.abs(m.level - h.level) <= Math.abs(h.band[1] - h.band[0]) * 2);
  if (dup) { dup.alsoAt = (dup.alsoAt || []).concat(h.level); continue; }
  merged.push(h);
}
hits.length = 0; hits.push(...merged);

writeFileSync(STATE, JSON.stringify(nowSeen, null, 1));

console.log(`\nSCAN v2 — ${cst(new Date().toISOString())} CST   ${PAIRS.length} pairs`);
if (nav) console.log(`account NAV $${nav.toFixed(2)}   size ${UNITS} units (0.01 lot) flat   READ-ONLY`);
console.log('='.repeat(78));

const order = ['WALL', 'FIELD', 'REV'];
const fresh = hits.filter(h => h.isNew);
if (!hits.length) console.log('\nNo setups.');
for (const k of order) {
  const g = hits.filter(h => h.kind === k && (SHOW_ALL || h.isNew));
  if (!g.length) continue;
  console.log(`\n${SPEC[k].label}   (${g.length})\n`);
  for (const h of g) {
    const D = dp(h.sym);
    console.log(`  ${h.sym}  ${h.dir > 0 ? 'LONG' : 'SHORT'}${h.isNew ? '   ** NEW **' : ''}`);
    console.log(`     level ${h.level.toFixed(D)}  band ${h.band[0].toFixed(D)}-${h.band[1].toFixed(D)}  ` +
      `${h.touches} swings  since ${h.confirmedTime.slice(0, 10)}`);
    console.log(`     room ahead ${h.room.toFixed(1)} ATR   ${h.backup} levels stacked ahead`);
    console.log(`     entry ${h.px.toFixed(D)}   stop ${h.stop.toFixed(D)} (${h.riskPips.toFixed(0)}p, $${h.riskUsd.toFixed(2)})   target ${h.target.toFixed(D)}`);
    console.log(`     next ahead: ${h.aheadLevels.map(v => v.toFixed(D)).join('  ') || '—'}`);
    console.log(`     behind:     ${h.behindLevels.map(v => v.toFixed(D)).join('  ') || '—'}`);
    console.log(`     daily ${h.dailyTrend} trend, RSI ${h.dailyRsi?.toFixed(0)}   price ${h.vs50 >= 0 ? '+' : ''}${h.vs50.toFixed(1)} ATR vs H4 50SMA`);
    if (h.news.length) console.log(`     ⚠ news 48h: ${h.news.join(' | ')}`);
    console.log('');
  }
}
if (fresh.length) {
  for (const h of fresh) appendFileSync(LOG, JSON.stringify(h) + '\n');
  console.log(`${fresh.length} new setup(s) logged to alerts_v2.jsonl`);
  const lines = fresh.map(h => {
    const D = dp(h.sym);
    return `${h.sym} ${h.dir > 0 ? 'LONG' : 'SHORT'} · ${SPEC[h.kind].label}\n` +
      `  in ${h.px.toFixed(D)}  sl ${h.stop.toFixed(D)}  tp ${h.target.toFixed(D)}\n` +
      `  ${h.riskPips.toFixed(0)}p = $${h.riskUsd.toFixed(2)} at 0.01 lot · room ${h.room.toFixed(1)} ATR` +
      (h.news.length ? `\n  ⚠ news: ${h.news[0]}` : '');
  });
  pushover(`${fresh.length} setup${fresh.length > 1 ? 's' : ''} · scan v2`, lines.join('\n\n'));
}
console.log(`\n${hits.length} total live setups, ${fresh.length} new since last scan.`);
