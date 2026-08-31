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
import { sma, rsi } from '../src/indicators.js';
import { findSetups, findWatching, DEFAULTS } from '../src/setups.js';
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

/**
 * Per-branch geometry.
 *
 * The stops are still fitted (swept per branch — tighter is monotonically
 * better on wall breaks, 1.5 suits open field, reversals have no clean answer
 * so 2.0 is kept for being the most consistent across windows).
 *
 * The TARGET is now structural. A 2.618 extension of the last confirmed swing
 * leg, projected from the level, beat the fitted ATR multiples on reversals
 * (+0.473R vs +0.162R average) and open field (+0.372R vs +0.204R), all four
 * windows, and tied on wall breaks. It is reached 28-40% of the time, so it is
 * a target rather than a hold period — unlike the 20 ATR figure it replaces.
 * It scales with the move that actually formed the setup instead of with a
 * multiplier someone swept for.
 */
/**
 * The leg comes from the DAILY chart, not H4 — measured, and it roughly doubles
 * expectancy over the H4 leg on the identical construction (+1.054/+0.834 vs
 * +0.565/+0.439). It is also where the user draws it by hand.
 *
 * The leg is a real directional move: a confirmed swing low followed by a LATER
 * confirmed swing high for a long, mirrored for a short. The first version took
 * the most recent high and low independently and could measure between points
 * fifteen days apart in the wrong order — a distance, not a leg.
 *
 * Target is the leg projected beyond the swing extreme. 1.0 is the classic
 * measured move: reached 24-27% of the time for +0.77R average. Larger
 * extensions earn more per trade but fill 9-18% of the time, which is the same
 * fictional-target problem that killed the 20 ATR figure.
 */
const FIB_EXT = DEFAULTS.fibExt;
const SPEC = {
  WALL:  { stopATR: 0.5, label: 'WALL BREAK'      },
  FIELD: { stopATR: 1.5, label: 'OPEN FIELD BREAK'},
  REV:   { stopATR: 2.0, label: 'REVERSAL'        },
};

const cst = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago',
  weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const dp = s => /JPY$/.test(s) ? 3 : 5;
const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;

const nav = await getSummary(LIVE_ACCOUNT_ID || ACCOUNT_ID).then(a => parseFloat(a.NAV)).catch(() => null);
const cal = await getCalendar().catch(() => []);
const px = await getPricing(PAIRS).catch(() => ({}));
const seen = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const nowSeen = {};
const hits = [];
const watch = [];

for (const sym of PAIRS) {
  try {
    // HISTORY LENGTH IS PART OF THE SPEC. Zones are built from whatever bars
    // are loaded, and "room to the next level ahead" is measured against that
    // zone set — so a shorter history means a sparser map and a different
    // classification for the same bar. The backtest uses two years of H4, so
    // the scanner must too, or the two can never agree.
    const b = await getCandles(sym, { granularity: 'H4', count: 3000 });
    const d = await getCandles(sym, { granularity: 'D', count: 600 });
    if (b.length < 1000 || d.length < 200) continue;
    const last = b.length - 1;
    const dRsi = rsi(d.map(x => x.close), 14);
    const dS50 = sma(d.map(x => x.close), 50);
    const s50 = sma(b.map(x => x.close), 50);
    const pip = pipOf(sym);
    const usdjpy = 147;                         // rough, for the JPY-quote conversion

    // Levels price is standing at RIGHT NOW, on live price rather than closed
    // bars — so an hourly scan has something to say between H4 closes.
    const live = px[sym]?.mid ?? b[last].close;
    for (const w of findWatching(b, d, live)) watch.push({ sym, ...w });

    // ONE definition of a setup, shared with the backtest. A live scan is
    // simply the setups sitting on the most recent closed bar.
    for (const s of findSetups(b, d).filter(x => x.i === last)) {
      const riskUsd = s.risk * UNITS * (/JPY$/.test(sym) ? 1 / usdjpy : 1);
      const key = `${sym}:${s.kind}:${s.dir}:${s.level.toFixed(5)}`;
      nowSeen[key] = s.time;
      hits.push({
        sym, kind: s.kind, dir: s.dir, key, isNew: seen[key] !== s.time,
        level: s.level, band: s.band, touches: s.touches,
        confirmedTime: s.confirmedTime, formedTime: s.formedTime, ageBars: s.ageBars,
        testNo: s.testNo, speed: s.speed,
        room: s.room, backup: s.backup, px: s.px, stop: s.stop, target: s.target,
        riskPips: s.risk / pip, riskUsd, rr: s.rr,
        legPips: s.leg.size / pip, legFrom: s.leg.fromAt, legTo: s.leg.toAt,
        aheadLevels: s.aheadForTrade, behindLevels: s.behindForTrade,
        vs50: (s.px - s50[last]) / s.atr,
        dailyRsi: dRsi[d.length - 1],
        dailyTrend: d[d.length - 1].close > dS50[d.length - 1] ? 'up' : 'down',
        news: eventsFor(cal, sym, new Date(), { hoursAhead: 48 })
          .map(e => `${e.date.slice(5, 16)} ${e.country} ${e.title}`),
        time: s.time,
      });
    }
  } catch (e) { if (SHOW_ALL) console.log(`  ${sym}: ${e.message}`); }
}

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
      `${h.touches} swings   formed ${h.formedTime ? h.formedTime.slice(0, 10) : '?'}` +
      `${h.ageBars ? ` (${(h.ageBars * 4 / 24).toFixed(0)}d old)` : ''}` +
      `   last confirmed ${h.confirmedTime.slice(0, 10)}`);
    console.log(`     room ahead ${h.room.toFixed(1)} ATR   ${h.backup} levels stacked ahead`);
    console.log(`     entry ${h.px.toFixed(D)}   stop ${h.stop.toFixed(D)} (${h.riskPips.toFixed(0)}p, $${h.riskUsd.toFixed(2)})   target ${h.target.toFixed(D)} (${h.rr.toFixed(1)}R)`);
    console.log(`     leg ${h.legPips.toFixed(0)}p daily, ${h.legFrom.slice(0, 10)} → ${h.legTo.slice(0, 10)}, projected ${FIB_EXT}× beyond`);
    console.log(`     next ahead: ${h.aheadLevels.map(v => v.toFixed(D)).join('  ') || '—'}`);
    console.log(`     behind:     ${h.behindLevels.map(v => v.toFixed(D)).join('  ') || '—'}`);
    console.log(`     daily ${h.dailyTrend} trend, RSI ${h.dailyRsi?.toFixed(0)}   price ${h.vs50 >= 0 ? '+' : ''}${h.vs50.toFixed(1)} ATR vs H4 50SMA`);
    if (h.news.length) console.log(`     ⚠ news 48h: ${h.news.join(' | ')}`);
    console.log('');
  }
}
// Same dedupe as the setups: zones a few pips apart are one wall. Keep the
// best-evidenced. Without this NZDUSD shows two levels 5.6p apart pointing in
// OPPOSITE directions, which is noise dressed as a contradiction.
const mergedW = [];
for (const w of watch.sort((x, y) => y.touches - x.touches)) {
  const dup = mergedW.find(m => m.sym === w.sym &&
    Math.abs(m.level - w.level) <= Math.abs(w.band[1] - w.band[0]) * 2);
  if (dup) { dup.alsoAt = (dup.alsoAt || []).concat(w.level); continue; }
  mergedW.push(w);
}
// Only a level's FIRST bar at code red is news; after that it is the same story.
for (const w of mergedW) {
  const k = `W:${w.sym}:${w.level.toFixed(5)}`;
  nowSeen[k] = w.state;
  w.isNew = seen[k] !== w.state;
}
const cr = mergedW.filter(w => w.state === 'CODE RED');
const wa = mergedW.filter(w => w.state === 'WATCHING');
const crNew = cr.filter(w => w.isNew);
for (const [title, list] of [['\n\u{1F534} CODE RED — at the level, resolution close', SHOW_ALL ? cr : crNew],
                             ['\n\u{1F440} WATCHING — price within 1 ATR of a level', wa]]) {
  if (!list.length || (!SHOW_ALL && title.includes('WATCHING'))) continue;
  console.log(`${title}   (${list.length})\n`);
  for (const w of list) {
    const D = dp(w.sym), pip = pipOf(w.sym);
    console.log(`  ${w.sym}  level ${w.level.toFixed(D)}   ${(w.distPrice / pip).toFixed(0)}p away` +
      `   ${w.touches} swings, ${w.ageBars ? (w.ageBars * 4 / 24).toFixed(0) + 'd old' : '?'}` +
      `   held ${w.hold} bars   room ${w.room.toFixed(1)} ATR${w.twoSided ? '   \u2194 TWO-SIDED' : ''}`);
    if (w.ifBreak) console.log(`     if it CLOSES THROUGH  → ${w.ifBreak.kind} ${w.ifBreak.dir > 0 ? 'LONG' : 'SHORT'}` +
      `   stop ${w.ifBreak.stop.toFixed(D)}   target ${w.ifBreak.target.toFixed(D)}`);
    if (w.ifReject) console.log(`     if it REJECTS         → ${w.ifReject.kind} ${w.ifReject.dir > 0 ? 'LONG' : 'SHORT'}` +
      `   stop ${w.ifReject.stop.toFixed(D)}   target ${w.ifReject.target.toFixed(D)}`);
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
if (crNew.length) {
  const lines = crNew.map(w => {
    const D = dp(w.sym), pip = pipOf(w.sym);
    return `${w.sym} @ ${w.level.toFixed(D)}${w.twoSided ? '  ↔ two-sided' : ''}\n` +
      `  ${w.touches} swings, ${w.ageBars ? (w.ageBars * 4 / 24).toFixed(0) + 'd' : '?'}, room ${w.room.toFixed(1)} ATR\n` +
      (w.ifBreak ? `  through → ${w.ifBreak.kind} ${w.ifBreak.dir > 0 ? 'LONG' : 'SHORT'}\n` : '') +
      (w.ifReject ? `  rejects → ${w.ifReject.kind} ${w.ifReject.dir > 0 ? 'LONG' : 'SHORT'}` : '');
  });
  pushover(`${crNew.length} level${crNew.length > 1 ? 's' : ''} at code red`, lines.join('\n\n'));
}
// Written LAST, so it captures both setup and watch keys. Writing it earlier
// meant every code-red level looked new on every scan.
writeFileSync(STATE, JSON.stringify(nowSeen, null, 1));

console.log(`\n${hits.length} setups (${fresh.length} new)   |   ${cr.length} code red (${crNew.length} new)   |   ${wa.length} watching`);
