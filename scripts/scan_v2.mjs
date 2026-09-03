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
import { getCandles, getPricing, getSummary, getOpenTrades, LIVE_ACCOUNT_ID, ACCOUNT_ID } from '../src/oanda.js';
import { sma, rsi, atr } from '../src/indicators.js';
import { findSetups, findWatching, DEFAULTS } from '../src/setups.js';
import { pendingBlocks } from '../src/orderblocks.js';
import { cachedSnapshot, positioningNote } from '../src/cot.js';
import { getCalendar, eventsFor } from '../src/news.js';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import https from 'https';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(REPO, '.scan_v2_state.json');
// How many H4 bars back to still report a setup that was never sent.
//
// The scanner runs hourly, so each H4 bar gets four chances to be seen; losing
// a bar takes four consecutive failures. Three bars covers twelve straight
// missed runs, which is a generous outage, while capping how stale an alert
// can be at twelve hours — past that the entry the setup was built on is too
// far from current price to act on.
//
// In steady state this changes nothing: the state file dedupes on key+time, so
// a setup already sent is never re-sent, and the window only ever surfaces
// something genuinely missed. Setups that already hit stop or target are
// dropped regardless of age.
const CATCHUP = parseInt(process.env.CATCHUP || '3', 10);
const LOG = join(REPO, 'alerts_v2.jsonl');
// Verbatim record of every notification, so what the phone showed is always
// recoverable. Setups go to alerts_v2.jsonl; this catches watch and code-red
// messages too, which nothing else records.
const PUSHLOG = join(REPO, 'pushes.jsonl');

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
function pushover(title, message, priority = '0') {
  // EVERY push is written to disk before it is sent, whether or not sending is
  // even enabled. Pushover keeps no history the user can pull, and until now
  // the watch and code-red messages -- the ones that actually drive trades --
  // were logged nowhere at all. On 2026-09-02 reconstructing a single alert
  // from 8/31 took twenty minutes of archaeology through git history, because
  // the only copy of it was on the user's phone screen.
  try {
    appendFileSync(PUSHLOG, JSON.stringify({
      at: new Date().toISOString(), title, message, priority,
      sent: !!(NOTIFY && process.env.PUSHOVER_ENABLED === '1' && process.env.PUSHOVER_TOKEN),
    }) + '\n');
  } catch (e) { console.log(`  push log failed: ${e.message}`); }

  if (!NOTIFY || process.env.PUSHOVER_ENABLED !== '1' || !process.env.PUSHOVER_TOKEN) return;
  const body = new URLSearchParams({
    token: process.env.PUSHOVER_TOKEN, user: process.env.PUSHOVER_USER,
    title, message: message.slice(0, 1024), priority,
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

// A REV fires on the same mechanic — price touched the level and closed back
// out — whether the level is holding as originally formed or holding after
// being broken. Those are opposite stories, so say which one it is.
//   CONTINUATION  price already broke through; the break is resuming.
//             Wins more often (54-64% vs 43-56%) and digs a shallower hole
//             (median 0.55-0.73R against vs 0.65-1.00R) — but pays less,
//             because part of the run to target is already spent.
//   REVERSAL      price has been respecting this level and turned away.
const ctxLabel = h => h.kind !== 'REV' ? SPEC[h.kind].label
  : h.context === 'CONTINUATION'
    ? `CONTINUATION  (retest of a broken level)${h.grade ? `   Grade ${h.grade}` : ''}`
    : 'REVERSAL  (turn at the level)';

const cst = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago',
  weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const dp = s => /JPY$/.test(s) ? 3 : 5;
const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;

const nav = await getSummary(LIVE_ACCOUNT_ID || ACCOUNT_ID).then(a => parseFloat(a.NAV)).catch(() => null);

// WHAT THE USER IS ACTUALLY HOLDING.
// Without this the scanner treats all 28 pairs identically — a reversal firing
// against an open position reads exactly like one on a pair never traded, and
// gets buried in a batch of 48. On 2026-09-03 a REVERSAL LONG fired at 192.501
// against a live CHFJPY short and nothing said so. Dodging levels and news on
// pairs already held is the user's stated edge; it was the one thing not wired.
const held = new Map();
try {
  for (const t of await getOpenTrades(LIVE_ACCOUNT_ID || ACCOUNT_ID)) {
    const sym = t.instrument.replace('_', '');
    const units = parseFloat(t.currentUnits);
    const cur = held.get(sym) || { units: 0, pl: 0, n: 0 };
    held.set(sym, { units: cur.units + units, pl: cur.pl + parseFloat(t.unrealizedPL), n: cur.n + 1 });
  }
} catch (e) { console.log(`  could not read positions: ${e.message}`); }
const dirOf = sym => { const h = held.get(sym); return h ? Math.sign(h.units) : 0; };

// CFTC positioning. Weekly data, so cached for 12h -- an hourly scan has no
// business refetching it. Silent unless a leg sits at an extreme, because
// positioning genuinely has no opinion in the middle of its range and printing
// that on every alert would be noise.
const cot = await cachedSnapshot({ maxAgeHours: 12 });
const cal = await getCalendar().catch(() => []);
const px = await getPricing(PAIRS).catch(() => ({}));
const seen = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const nowSeen = {};
const hits = [];
const watch = [];
const lapsed = [];
const blocks = [];

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
    const aH4 = atr(b, 14);
    const dS50 = sma(d.map(x => x.close), 50);
    const s50 = sma(b.map(x => x.close), 50);
    const pip = pipOf(sym);
    const usdjpy = 147;                         // rough, for the JPY-quote conversion

    // Levels price is standing at RIGHT NOW, on live price rather than closed
    // bars — so an hourly scan has something to say between H4 closes.
    const live = px[sym]?.mid ?? b[last].close;
    for (const w of findWatching(b, d, live)) watch.push({ sym, ...w });

    // ORDER BLOCKS — the second model. Daily, and entirely separate from the
    // level engine above: blocks find the entry, levels inform management.
    // Only live ones matter: not yet filled, and price has not run past the
    // stop. OANDA reserves no margin on unfilled orders, so a resting limit
    // costs nothing but attention — worth carrying even when the median wait
    // is 5 days and the tail runs to months.
    for (const ob of pendingBlocks(d, live)) {
      if (ob.invalidated || ob.filled || ob.expired) continue;
      blocks.push({ sym, ...ob,
        riskPips: ob.risk / pip,
        riskUsd: ob.risk * UNITS * (/JPY$/.test(sym) ? 1 / usdjpy : 1) });
    }

    // ONE definition of a setup, shared with the backtest.
    //
    // CATCH-UP WINDOW. This used to be `x.i === last`, which made a setup
    // visible for exactly one H4 bar. Any run the scanner missed — VM reboot,
    // network blip, a task that did not fire — dropped that bar's signals for
    // good, with no trace. CHFJPY 2026-08-30 21:00 (REVERSAL SHORT, 198.503)
    // was lost exactly this way: the watch tier flagged the level, then the
    // setup never arrived, and the user was left eyeballing a target.
    //
    // So look back CATCHUP bars. The state file already dedupes on key+time,
    // so nothing already sent is re-sent.
    for (const s of findSetups(b, d).filter(x => x.i > last - CATCHUP)) {
      // ...but do not raise a setup that has already played out. Walk the bars
      // since it fired: if price reached the stop or the target, it is history,
      // not a trade to take.
      let done = null;
      for (let j = s.i + 1; j <= last; j++) {
        const hitStop = s.dir > 0 ? b[j].low <= s.stop : b[j].high >= s.stop;
        const hitTgt = s.dir > 0 ? b[j].high >= s.target : b[j].low <= s.target;
        if (hitStop) { done = 'stopped'; break; }
        if (hitTgt) { done = 'target'; break; }
      }
      if (done) continue;
      // A level that keeps qualifying fires on several consecutive bars. Inside
      // the catch-up window that is ONE signal seen repeatedly, not several —
      // so keep the earliest, which is when it actually triggered.
      const dupKey = `${sym}:${s.kind}:${s.dir}:${s.level.toFixed(5)}`;
      if (hits.some(h => h.key === dupKey)) continue;
      const riskUsd = s.risk * UNITS * (/JPY$/.test(sym) ? 1 / usdjpy : 1);
      const key = `${sym}:${s.kind}:${s.dir}:${s.level.toFixed(5)}`;
      nowSeen[key] = s.time;
      hits.push({
        sym, kind: s.kind, dir: s.dir, key, isNew: seen[key] !== s.time,
        barsAgo: last - s.i,
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
    // A level that was CODE RED carried a plan: "through -> WALL short",
    // "rejects -> REV long". When price resolves it and NO branch qualifies,
    // that plan silently stops being true and nothing is said.
    //
    // CHFJPY 197.444 did exactly this. It was code red on 08-31 promising a
    // WALL short. wallRoom was retuned from 2 to 1.5 that afternoon, so when
    // the break came on 09-02 at 196.879 the room measured 1.57 -- above 1.5,
    // below fieldRoom 8 -- and fell into the dead space between branches. The
    // user took the trade on the original promise and was never told it had
    // been withdrawn.
    for (const [k, prev] of Object.entries(seen)) {
      if (!k.startsWith(`W:${sym}:`) || nowSeen[k] !== undefined) continue;
      if (prev !== 'CODE RED') continue;              // only levels that were live
      const lvl = parseFloat(k.split(':')[2]);
      if (!Number.isFinite(lvl)) continue;
      if (hits.some(h => h.sym === sym && Math.abs(h.level - lvl) < 1e-5)) continue;
      const was = b[last - 3]?.close, now = b[last].close;
      if (was == null) continue;
      const through = (was > lvl && now < lvl) || (was < lvl && now > lvl);
      // Half an ATR clear of the level. Price sitting a pip the other side has
      // not resolved anything -- it is still the same fight.
      if (!through || Math.abs(now - lvl) < aH4[last] * 0.5) continue;
      lapsed.push({ sym, level: lvl, dir: now < lvl ? -1 : 1,
        movedPips: Math.abs(now - lvl) / pip });
    }
  } catch (e) { if (SHOW_ALL) console.log(`  ${sym}: ${e.message}`); }
}

console.log(`\nSCAN v2 — ${cst(new Date().toISOString())} CST   ${PAIRS.length} pairs`);
if (nav) console.log(`account NAV $${nav.toFixed(2)}   size ${UNITS} units (0.01 lot) flat   READ-ONLY`);
console.log('='.repeat(78));

// ---- ORDER BLOCKS ----------------------------------------------------------
// A block has two lifecycle moments and they are different notifications: the
// CHoCH, when the block becomes known and a limit can go in, and the fill days
// or weeks later. Only the first is reported here — the fill shows up as a
// position, which the daily review already covers.
if (blocks.length) {
  const fresh = blocks.filter(b => seen[`OB:${b.sym}:${b.blockTime}`] === undefined);
  console.log(`\nORDER BLOCKS   (${blocks.length} live, ${fresh.length} new)\n`);
  for (const b of blocks.sort((x, y) => Math.abs(x.distanceR) - Math.abs(y.distanceR))) {
    const D = dp(b.sym), isNew = seen[`OB:${b.sym}:${b.blockTime}`] === undefined;
    console.log(`  ${b.sym}  ${b.dir > 0 ? 'LONG' : 'SHORT'}${isNew ? '   ** NEW **' : ''}` +
      `   ${b.closedThrough ? 'closed through' : 'wicked through'}`);
    console.log(`     block ${b.blockTime.slice(0, 10)}   zone ${b.zoneLow.toFixed(D)}-${b.zoneHigh.toFixed(D)}` +
      `   CHoCH ${b.chochTime.slice(0, 10)} took out ${b.swing.toFixed(D)}`);
    console.log(`     LIMIT ${b.entry.toFixed(D)}   stop ${b.stop.toFixed(D)}` +
      `   (${b.riskPips.toFixed(0)}p = 1R, $${b.riskUsd.toFixed(2)} at 0.01 lot)`);
    console.log(`     price is ${Math.abs(b.distanceR).toFixed(2)}R ${b.distance > 0 ? 'above' : 'below'} the limit` +
      `   ·  ${b.barsSinceChoch}d since the CHoCH`);
    const pos = positioningNote(cot, b.sym, b.dir);
    if (pos) console.log(`     ⚖ positioning: ${pos}`);
    const news = eventsFor(cal, b.sym, new Date(), { hoursAhead: 72 })
      .map(e => `${e.date.slice(5, 16)} ${e.country} ${e.title}`);
    if (news.length) console.log(`     ⚠ news 72h: ${news.join(' | ')}`);
    console.log('');
  }
  for (const b of blocks) nowSeen[`OB:${b.sym}:${b.blockTime}`] = b.chochTime;
  if (fresh.length) {
    const lines = fresh.map(b => {
      const D = dp(b.sym);
      return `${b.sym} ${b.dir > 0 ? 'LONG' : 'SHORT'} · order block\n` +
        `  limit ${b.entry.toFixed(D)}  stop ${b.stop.toFixed(D)}\n` +
        `  ${b.riskPips.toFixed(0)}p = 1R ($${b.riskUsd.toFixed(2)})  ·  ${b.closedThrough ? 'closed' : 'wicked'} through`;
    });
    pushover(`${fresh.length} order block${fresh.length > 1 ? 's' : ''}`, lines.join('\n\n'));
  }
}

// Levels that were code red, then resolved without qualifying for anything.
if (lapsed.length) {
  console.log(`\nBROKE, NO TRADE   (${lapsed.length})\n`);
  for (const l of lapsed)
    console.log(`  ${l.sym}  closed ${l.dir > 0 ? 'above' : 'below'} ${l.level.toFixed(dp(l.sym))}` +
      `  (${l.movedPips.toFixed(0)}p past it) — no branch qualified, the watch plan is void`);
  console.log('');
}

// ---- ON YOUR POSITIONS -----------------------------------------------------
// First, loudest, and pushed on its own. Everything below is opportunity; this
// is exposure. A signal pointing AGAINST an open position is the one thing that
// must never be one line in a batch of forty-eight.
if (held.size) {
  const notes = [];
  for (const [sym, h] of held) {
    const pd = Math.sign(h.units), D = dp(sym);
    const against = hits.filter(x => x.sym === sym && x.dir !== pd);
    const withYou = hits.filter(x => x.sym === sym && x.dir === pd);
    const near = watch.filter(w => w.sym === sym).sort((a, b) => a.distATR - b.distATR);
    const news = eventsFor(cal, sym, new Date(), { hoursAhead: 48 })
      .map(e => `${e.date.slice(5, 16)} ${e.country} ${e.title}`);
    const lines = [];
    for (const a of against)
      lines.push(`AGAINST YOU · ${a.kind}${a.context ? ' ' + a.context : ''} ` +
        `${a.dir > 0 ? 'LONG' : 'SHORT'} at ${a.level.toFixed(D)}`);
    for (const w of near.slice(0, 2))
      lines.push(`level ${w.level.toFixed(D)} ${w.distATR.toFixed(2)} ATR away` +
        `${w.state === 'CODE RED' ? ' — CODE RED' : ''}` +
        `${w.ifReject && w.ifReject.dir !== pd ? `, rejects → ${w.ifReject.context || w.ifReject.kind} against you` : ''}`);
    for (const wn of withYou) lines.push(`with you · ${wn.kind} at ${wn.level.toFixed(D)}`);
    const pnote = positioningNote(cot, sym, pd);
    if (pnote) lines.push(`⚖ positioning: ${pnote}`);
    for (const n of news) lines.push(`⚠ ${n}`);
    if (lines.length) notes.push({ sym, h, pd, lines, urgent: against.length > 0 || news.length > 0 });
  }
  if (notes.length) {
    console.log(`\nON YOUR POSITIONS   (${held.size} pair${held.size > 1 ? 's' : ''} held)\n`);
    for (const n of notes) {
      console.log(`  ${n.sym}  ${n.pd > 0 ? 'LONG' : 'SHORT'} ${n.h.units}  ` +
        `P/L $${n.h.pl.toFixed(2)}${n.h.n > 1 ? `  (${n.h.n} tickets)` : ''}`);
      for (const l of n.lines) console.log(`     ${l}`);
      console.log('');
    }
    const urgent = notes.filter(n => n.urgent);
    if (urgent.length) {
      const msg = urgent.map(n =>
        `${n.sym} ${n.pd > 0 ? 'LONG' : 'SHORT'}  $${n.h.pl.toFixed(2)}\n  ` +
        n.lines.join('\n  ')).join('\n\n');
      pushover(`${urgent.length} position${urgent.length > 1 ? 's' : ''} need a look`, msg, '1');
    }
  }
}

const order = ['WALL', 'FIELD', 'REV'];
const fresh = hits.filter(h => h.isNew);
if (!hits.length) console.log('\nNo setups.');
for (const k of order) {
  const g = hits.filter(h => h.kind === k && (SHOW_ALL || h.isNew));
  if (!g.length) continue;
  console.log(`\n${SPEC[k].label}   (${g.length})\n`);
  for (const h of g) {
    const D = dp(h.sym);
    console.log(`  ${h.sym}  ${h.dir > 0 ? 'LONG' : 'SHORT'}` +
      `${h.kind === 'REV' ? `   ${ctxLabel(h)}` : ''}${h.isNew ? '   ** NEW **' : ''}` +
      `${h.barsAgo ? `   ⏳ fired ${h.barsAgo} bar${h.barsAgo > 1 ? 's' : ''} ago (${h.barsAgo * 4}h) — still live` : ''}`);
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
    if (w.ifReject) console.log(`     if it REJECTS         → ${w.ifReject.context || w.ifReject.kind}${w.ifReject.grade ? ' (Grade ' + w.ifReject.grade + ')' : ''} ${w.ifReject.dir > 0 ? 'LONG' : 'SHORT'}` +
      `   stop ${w.ifReject.stop.toFixed(D)}   target ${w.ifReject.target.toFixed(D)}`);
    console.log('');
  }
}

if (fresh.length) {
  for (const h of fresh) appendFileSync(LOG, JSON.stringify(h) + '\n');
  console.log(`${fresh.length} new setup(s) logged to alerts_v2.jsonl`);
  const lines = fresh.map(h => {
    const D = dp(h.sym);
    return `${h.sym} ${h.dir > 0 ? 'LONG' : 'SHORT'} · ${ctxLabel(h)}` +
      `${h.barsAgo ? ` (fired ${h.barsAgo * 4}h ago, still live)` : ''}\n` +
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
      (w.ifReject ? `  rejects → ${w.ifReject.context || w.ifReject.kind}${w.ifReject.grade ? ' ' + w.ifReject.grade : ''} ${w.ifReject.dir > 0 ? 'LONG' : 'SHORT'}` : '');
  });
  pushover(`${crNew.length} level${crNew.length > 1 ? 's' : ''} at code red`, lines.join('\n\n'));
}
// A code-red level carries a plan. When it resolves and no branch qualifies,
// that plan is withdrawn — and being told is the whole point, because the last
// thing sent about that level was an instruction to act on it.
if (lapsed.length) {
  const lines = lapsed.map(l =>
    `${l.sym} closed ${l.dir > 0 ? 'above' : 'below'} ${l.level.toFixed(dp(l.sym))}\n` +
    `  ${l.movedPips.toFixed(0)}p past it — no branch qualified\n` +
    `  the earlier watch plan on this level is void`);
  pushover(`${lapsed.length} watch${lapsed.length > 1 ? 'es' : ''} lapsed`, lines.join('\n\n'));
}

// Written LAST, so it captures both setup and watch keys. Writing it earlier
// meant every code-red level looked new on every scan.
writeFileSync(STATE, JSON.stringify(nowSeen, null, 1));

console.log(`\n${hits.length} setups (${fresh.length} new)   |   ${cr.length} code red (${crNew.length} new)   |   ${wa.length} watching`);
