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
import { pendingBlocks, reachLadder, fillOdds, OB_TF } from '../src/orderblocks.js';
import { cachedSnapshot, positioningNote } from '../src/cot.js';
import { quoteRates, usdPerPrice, moveWeights, weightLine, weightTag } from '../src/weight.js';
import { getCalendar, eventsFor } from '../src/news.js';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import https from 'https';
import { execSync } from 'child_process';
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
// Whether a push can actually LEAVE this machine. The state file records what
// the user has been TOLD, so it must only advance when telling them is possible.
// Before this, an inspection run marked setups as seen and they could never
// alert again -- which is exactly how seven order blocks were silently burned
// on 2026-09-05.
// Forex closes Friday 17:00 New York and reopens Sunday 17:00 New York. The
// scanner ran hourly straight through, so the weekend of 2026-09-12/13 pushed
// the same position warnings every hour while price could not move. New York
// time handles DST on its own.
function marketOpen(now = new Date()) {
  const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
  const day = ny.find(x => x.type === 'weekday').value;
  const hour = parseInt(ny.find(x => x.type === 'hour').value, 10) % 24;
  if (day === 'Sat') return false;
  if (day === 'Fri' && hour >= 17) return false;
  if (day === 'Sun' && hour < 17) return false;
  return true;
}
const MARKET_OPEN = marketOpen();

// Closed market counts as NOT delivering, so the state file does not advance
// either. Otherwise anything that turned up over the weekend would be marked
// as sent without ever being sent, and Sunday's first scan would stay silent.
const WILL_DELIVER = NOTIFY && MARKET_OPEN &&
  process.env.PUSHOVER_ENABLED === '1' && !!process.env.PUSHOVER_TOKEN;

/**
 * One batched push per scan, not one per setup. With 28 pairs this can produce
 * a handful of new setups at once and the old scanner's per-alert pings were
 * unreadable on a phone. Only NEW setups go out — the state file makes every
 * run idempotent, so a repeated setup is silent.
 */
/**
 * Pushover truncates at 1024 characters and says nothing about it — a 33-setup
 * alert on 2026-09-05 was 4,691 chars, so three quarters of it silently never
 * arrived. Pack the best items until the budget is spent and say what was left
 * behind, rather than letting the tail vanish.
 */
function packed(items, budget = 950) {
  const out = [];
  let used = 0;
  for (const it of items) {
    if (used + it.length + 2 > budget) break;
    out.push(it); used += it.length + 2;
  }
  const rest = items.length - out.length;
  if (rest) out.push(`+${rest} more — see the log`);
  return out.join('\n\n');
}

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
      sent: WILL_DELIVER,
    }) + '\n');
  } catch (e) { console.log(`  push log failed: ${e.message}`); }

  if (!WILL_DELIVER) return;
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
let hits = [];
const watch = [];
const lapsed = [];
const blocks = [];        // daily
const blocks4 = [];       // H4 -- same definition, its own measured numbers
const atrByPair = new Map();

// Quote currency -> USD, once. This used to be a flat `usdjpy = 147` that only
// handled JPY-quoted pairs and treated every other quote currency as if it were
// already dollars — so the risk on a CAD-quoted pair read ~38% high.
const rates = await quoteRates(getCandles);

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
    const toUsd = usdPerPrice(sym, rates, UNITS);   // price move -> dollars on the marker
    atrByPair.set(sym, aH4[last]);                  // for the MOVE tiers, computed once all pairs are in

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
      if (ob.invalidated || ob.filled || ob.expired || ob.outOfReach) continue;
      blocks.push({ sym, ...ob, tf: 'D',
        riskPips: ob.risk / pip,
        riskUsd: ob.risk * toUsd });
    }

    // H4 BLOCKS. Same definition, six times the frequency, and its own curves.
    // Kept SEPARATE from daily rather than merged: the two have different stop
    // sizes, different odds, and a very different sensitivity to spread, so
    // pooling them would average away the thing that distinguishes them.
    // `spreadShare` is printed because H4's edge is mostly rent paid to the
    // spread -- gross +0.452R, net of one spread +0.231R -- and that is the
    // user's call to make per block, not something to silently filter.
    const sp = px[sym] ? px[sym].ask - px[sym].bid : null;
    for (const ob of pendingBlocks(b, live, { barsPerDay: OB_TF.H4.barsPerDay })) {
      if (ob.invalidated || ob.filled || ob.expired || ob.outOfReach) continue;
      blocks4.push({ sym, ...ob, tf: 'H4',
        riskPips: ob.risk / pip,
        riskUsd: ob.risk * toUsd,
        spreadShare: sp == null ? null : sp / ob.risk });
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
    // LATEST FIRING FIRST. A level that keeps qualifying fires on several
    // consecutive bars, and the catch-up window collapses those to one — so
    // which one it keeps decides what gets sent. Measured over 2,666 setups,
    // the firing NUMBER is the single biggest quality signal in the system:
    //
    //     1st firing  67% reach 1R  +0.332R      <- what was being sent
    //     2nd         74%           +0.472R
    //     3rd         79%           +0.585R
    //     all repeats 79%           +0.590R
    //
    // A level that keeps firing is a level price keeps respecting; the first
    // touch is the unproven one. This used to keep the EARLIEST, on the logic
    // that it was "when it actually triggered" — which picked both the least
    // proven firing and the stalest entry price. Reversed, so the dedupe below
    // keeps the most recent.
    for (const s of findSetups(b, d).filter(x => x.i > last - CATCHUP).reverse()) {
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
      // Inside the catch-up window repeated firings of one level are ONE signal
      // seen several times, not several trades. Iterating newest-first above
      // means the first one reached is the most recent, so this keeps that.
      const dupKey = `${sym}:${s.kind}:${s.dir}:${s.level.toFixed(5)}`;
      if (hits.some(h => h.key === dupKey)) continue;
      const riskUsd = s.risk * toUsd;
      const key = `${sym}:${s.kind}:${s.dir}:${s.level.toFixed(5)}`;
      nowSeen[key] = s.time;
      hits.push({
        sym, kind: s.kind, dir: s.dir, key, isNew: seen[key] !== s.time,
        barsAgo: last - s.i,
        level: s.level, band: s.band, touches: s.touches,
        confirmedTime: s.confirmedTime, formedTime: s.formedTime, ageBars: s.ageBars,
        testNo: s.testNo, speed: s.speed, fireNo: s.fireNo,
        room: s.room, backup: s.backup, px: s.px, stop: s.stop, target: s.target,
        riskPips: s.risk / pip, riskUsd, rr: s.rr,
        legPips: s.leg.size / pip, legFrom: s.leg.fromAt, legTo: s.leg.toAt,
        aheadLevels: s.aheadForTrade, behindLevels: s.behindForTrade,
        vs50: (s.px - s50[last]) / s.atr,
        atr: s.atr,
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

// Which code is actually running. The VM had no git pull for days, so alerts
// that existed in the repo never reached the phone and nothing said so.
let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf8' }).trim();
  const age = execSync('git log -1 --format=%cr', { cwd: REPO, encoding: 'utf8' }).trim();
  rev = `${rev}, ${age}`;
} catch (e) { /* not a checkout, or git missing */ }
console.log(`\nSCAN v2 — ${cst(new Date().toISOString())} CST   ${PAIRS.length} pairs   code ${rev}`);
if (nav) console.log(`account NAV $${nav.toFixed(2)}   size ${UNITS} units (0.01 lot) flat   READ-ONLY`);
console.log('='.repeat(78));

// ---- ORDER BLOCKS ----------------------------------------------------------
// A block has two lifecycle moments and they are different notifications: the
// CHoCH, when the block becomes known and a limit can go in, and the fill days
// or weeks later. Only the first is reported here — the fill shows up as a
// position, which the daily review already covers.
/**
 * One renderer for both timeframes. Daily and H4 print as SEPARATE sections
 * with separate state keys, so each dedupes on its own and neither drowns the
 * other -- H4 produces roughly six blocks for every daily one.
 */
function reportBlocks(list, tf, prefix, title) {
  if (!list.length) return;
  const fresh = list.filter(b => seen[`${prefix}:${b.sym}:${b.blockTime}`] === undefined);
  console.log(`\n${title}   (${list.length} live, ${fresh.length} new)\n`);
  // Nearest first, because distance decides whether a block ever fills and a
  // phone only shows the top of a list. Age is the second signal -- it makes a
  // block better when it finally fills -- so it prints on every line instead.
  for (const b of list.sort((x, y) => Math.abs(x.distanceR) - Math.abs(y.distanceR))) {
    const D = dp(b.sym), isNew = seen[`${prefix}:${b.sym}:${b.blockTime}`] === undefined;
    const age = Math.round(b.ageDays ?? b.barsSinceChoch);
    console.log(`  ${b.sym}  ${b.dir > 0 ? 'LONG' : 'SHORT'}${isNew ? '   ** NEW **' : ''}` +
      `   ${b.closedThrough ? 'closed through' : 'wicked through'}`);
    console.log(`     block ${b.blockTime.slice(0, 10)}   zone ${b.zoneLow.toFixed(D)}-${b.zoneHigh.toFixed(D)}` +
      `   CHoCH ${b.chochTime.slice(0, 10)} took out ${b.swing.toFixed(D)}`);
    console.log(`     LIMIT ${b.entry.toFixed(D)}   stop ${b.stop.toFixed(D)}` +
      `   (${b.riskPips.toFixed(0)}p = 1R, $${b.riskUsd.toFixed(2)} at 0.01 lot)` +
      `${b.spreadShare != null ? `   spread ${(100 * b.spreadShare).toFixed(0)}% of 1R` : ''}`);
    console.log(`     ${Math.abs(b.distanceR).toFixed(2)}R from the limit — ${(100 * fillOdds(b.distanceR, tf)).toFixed(0)}% of blocks this close fill` +
      `   ·  waited ${age}d${age >= (tf === 'H4' ? 2 : 15) ? ', and patient blocks run further' : ''}`);
    console.log(`     reaches   ` + reachLadder(b, age, tf)
      .map(x => `${x.r}R ${x.price.toFixed(D)} (${(100 * x.hit).toFixed(0)}%)`).join('   '));
    const pos = positioningNote(cot, b.sym, b.dir);
    if (pos) console.log(`     ⚖ positioning: ${pos}`);
    const news = eventsFor(cal, b.sym, new Date(), { hoursAhead: 72 })
      .map(e => `${e.date.slice(5, 16)} ${e.country} ${e.title}`);
    if (news.length) console.log(`     ⚠ news 72h: ${news.join(' | ')}`);
    console.log('');
  }
  for (const b of list) nowSeen[`${prefix}:${b.sym}:${b.blockTime}`] = b.chochTime;
  if (fresh.length) {
    const lines = fresh.map(b => {
      const D = dp(b.sym);
      return `${b.sym} ${b.dir > 0 ? 'LONG' : 'SHORT'} · ${tf} block\n` +
        `  limit ${b.entry.toFixed(D)}  stop ${b.stop.toFixed(D)}\n` +
        `  ${b.riskPips.toFixed(0)}p = 1R ($${b.riskUsd.toFixed(2)})  ·  ${Math.abs(b.distanceR).toFixed(1)}R away` +
        `${b.spreadShare != null ? `  ·  spread ${(100 * b.spreadShare).toFixed(0)}% of 1R` : ''}`;
    });
    pushover(`${fresh.length} ${tf} order block${fresh.length > 1 ? 's' : ''}`, packed(lines));
  }

  // APPROACH, not discovery. A block is announced once, on the day the CHoCH
  // reveals it, and then stays live for months -- so the single alert lands when
  // price is often several R away and there is silence on the day it arrives.
  // Keyed on STATE so each block alerts once per transition, and re-arms if
  // price walks back off.
  const approaching = [];
  for (const b of list) {
    const state = b.distanceR <= 0.25 ? 'AT ZONE' : b.distanceR <= 1 ? 'NEARING' : null;
    const k = `${prefix}A:${b.sym}:${b.blockTime}`;
    if (!state) { delete nowSeen[k]; continue; }
    nowSeen[k] = state;
    if (seen[k] !== state) approaching.push({ ...b, state });
  }
  if (approaching.length) {
    console.log(`\n\u{1F3AF} ${tf} BLOCKS IN REACH   (${approaching.length})\n`);
    for (const b of approaching) {
      const D = dp(b.sym);
      console.log(`  ${b.sym}  ${b.dir > 0 ? 'LONG' : 'SHORT'}   ${b.state}   ${b.distanceR.toFixed(2)}R from the limit`);
      console.log(`     limit ${b.entry.toFixed(D)}   stop ${b.stop.toFixed(D)}   (${b.riskPips.toFixed(0)}p = 1R, $${b.riskUsd.toFixed(2)})\n`);
    }
    const lines = approaching.map(b => {
      const D = dp(b.sym);
      return `${b.sym} ${b.dir > 0 ? 'LONG' : 'SHORT'} · ${tf} block ${b.state}\n` +
        `  limit ${b.entry.toFixed(D)}  stop ${b.stop.toFixed(D)}  (${b.distanceR.toFixed(2)}R away)\n` +
        `  ${b.riskPips.toFixed(0)}p = 1R ($${b.riskUsd.toFixed(2)})`;
    });
    pushover(`${approaching.length} ${tf} block${approaching.length > 1 ? 's' : ''} in reach`,
      packed(lines), approaching.some(b => b.state === 'AT ZONE') ? '1' : '0');
  }
}

reportBlocks(blocks, 'D', 'OB', 'ORDER BLOCKS — DAILY');
reportBlocks(blocks4, 'H4', 'OB4', 'ORDER BLOCKS — 4 HOUR');
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
    // Stable identities for each danger, so the push fires when something NEW
    // turns against the position rather than every hour. Distances and P/L
    // change every scan and are deliberately left out of the key.
    const dangers = [];
    for (const a of against) dangers.push(`against:${a.kind}:${a.dir}:${a.level.toFixed(D)}`);
    for (const w of near.slice(0, 2))
      if (w.state === 'CODE RED' && w.ifReject && w.ifReject.dir !== pd) dangers.push(`codered:${w.level.toFixed(D)}`);
    for (const n of news) dangers.push(`news:${n}`);
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
    // What was already sent for this position, in this direction. Flipping
    // from short to long is a new position and starts clean.
    const pkey = `P:${sym}:${pd}`;
    const before = new Set((seen[pkey] || '').split('|').filter(Boolean));
    const fresh = dangers.filter(d => !before.has(d));
    nowSeen[pkey] = dangers.join('|');
    if (lines.length) notes.push({ sym, h, pd, lines, fresh, urgent: fresh.length > 0 });
  }
  if (notes.length) {
    console.log(`\nON YOUR POSITIONS   (${held.size} pair${held.size > 1 ? 's' : ''} held)\n`);
    for (const n of notes) {
      console.log(`  ${n.sym}  ${n.pd > 0 ? 'LONG' : 'SHORT'} ${n.h.units}  ` +
        `P/L $${n.h.pl.toFixed(2)}${n.h.n > 1 ? `  (${n.h.n} tickets)` : ''}`);
      for (const l of n.lines) console.log(`     ${l}`);
      console.log('');
    }
    // ONLY when something new has turned against a position. On 2026-09-11 the
    // AUDJPY short received the same 'AGAINST YOU · REV LONG at 110.280' push
    // every hour — 21 near-identical alerts across five days. The warning was
    // correct (price bounced exactly there and the user flipped long on it);
    // the repetition trained the user to stop reading it. A danger that was
    // already sent stays on the console and in the review, not on the phone.
    const urgent = notes.filter(n => n.urgent);
    if (urgent.length) {
      const msg = urgent.map(n =>
        `${n.sym} ${n.pd > 0 ? 'LONG' : 'SHORT'}  $${n.h.pl.toFixed(2)}\n  ` +
        n.lines.join('\n  ') +
        `\n  NEW: ${n.fresh.map(f => {
          const [kind, ...rest] = f.split(':');
          if (kind === 'news') return rest.join(':');
          if (kind === 'codered') return `code red at ${rest[0]}`;
          return `${rest[0]} ${rest[1] === '1' ? 'LONG' : 'SHORT'} at ${rest[2]}`;
        }).join(' · ')}`).join('\n\n');
      pushover(`${urgent.length} position${urgent.length > 1 ? 's' : ''} need a look`, msg, '1');
    }
  }
}

const order = ['WALL', 'FIELD', 'REV'];
// ---- THIN THE BOARD ---------------------------------------------------------
// A scan on 2026-09-05 emitted 31 reversals, in which USDCAD SHORT appeared
// three times at levels 14 and 15 pips apart, NZDCHF appeared three times
// INCLUDING both directions, and GBPJPY carried a 0.1R target. That is one
// trade printed three ways plus noise, and it is unreadable on a phone. Three
// rules, cheapest first.
// The firing number, said in words. Measured: 1st 67% reach 1R, 2nd 74%,
// 3rd 79%. A level on its third firing has proved something a fresh one has not.
function fireLabel(n) {
  if (n <= 1) return 'first firing at this level — least proven (67% reach 1R)';
  const ord = n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  return `${ord} firing at this level — price keeps respecting it (${n >= 3 ? 79 : 74}% reach 1R)`;
}

const MIN_RR = 1.0;
const thinned = [], dropped = { thin: 0, dupe: 0, clash: 0 };

// 1. a target closer than the stop is not a trade
for (const h of hits) { if (h.rr >= MIN_RR) thinned.push(h); else dropped.thin++; }

// 2. same pair, same direction, levels within an ATR -> ONE trade. Keep the
//    best-evidenced level, since touches are what the zone engine is built on.
const merged = [];
for (const h of thinned.sort((a, b) => b.touches - a.touches)) {
  const dup = merged.find(m => m.sym === h.sym && m.dir === h.dir &&
    Math.abs(m.level - h.level) <= (h.atr || Infinity));
  if (dup) { (dup.alsoAt = dup.alsoAt || []).push(h.level); dropped.dupe++; continue; }
  merged.push(h);
}

// 3. a pair firing BOTH ways says nothing. Flag it, keep it off the push.
const bothWays = new Set(merged.filter(h =>
  merged.some(o => o.sym === h.sym && o.dir !== h.dir)).map(h => h.sym));
for (const sym of bothWays) dropped.clash += merged.filter(h => h.sym === sym).length;
hits = merged;

if (dropped.thin || dropped.dupe || dropped.clash)
  console.log(`\nthinned: ${dropped.thin} under ${MIN_RR}R · ${dropped.dupe} duplicate levels · ` +
    `${dropped.clash} on ${bothWays.size} contradicting pair${bothWays.size === 1 ? '' : 's'} ` +
    `(${[...bothWays].join(', ') || '—'}) — shown below, kept off the push`);

// Quartiles across the pairs actually scanned, so the tiers track the current
// regime rather than a frozen table. Relative by construction: a quarter of the
// board is tier A even in a dead market.
const weights = moveWeights(atrByPair, rates, UNITS);

const fresh = hits.filter(h => h.isNew && !bothWays.has(h.sym));
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
    const wl = weightLine(weights.get(h.sym));
    if (wl) console.log(`     ${wl}`);
    if (h.fireNo) console.log(`     ${fireLabel(h.fireNo)}`);
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
  // best first, so if the budget runs out it is the weakest that gets cut
  const lines = [...fresh].sort((a, b) => (b.rr - a.rr) || (b.touches - a.touches)).map(h => {
    const D = dp(h.sym);
    return `${h.sym} ${h.dir > 0 ? 'LONG' : 'SHORT'} · ${ctxLabel(h)}` +
      `${h.barsAgo ? ` (${h.barsAgo * 4}h ago)` : ''}  ${weightTag(weights.get(h.sym))}` +
      `${h.fireNo > 1 ? `  ${h.fireNo}${h.fireNo === 2 ? 'nd' : h.fireNo === 3 ? 'rd' : 'th'} firing` : ''}\n` +
      `  in ${h.px.toFixed(D)}  sl ${h.stop.toFixed(D)}  tp ${h.target.toFixed(D)}  ${h.rr.toFixed(1)}R\n` +
      `  ${h.riskPips.toFixed(0)}p = $${h.riskUsd.toFixed(2)}` +
      (h.news.length ? `  ⚠ ${h.news[0].slice(0, 40)}` : '');
  });
  pushover(`${fresh.length} setup${fresh.length > 1 ? 's' : ''} · scan v2`, packed(lines));
}
if (crNew.length) {
  const lines = crNew.map(w => {
    const D = dp(w.sym), pip = pipOf(w.sym);
    return `${w.sym} @ ${w.level.toFixed(D)}${w.twoSided ? '  ↔ two-sided' : ''}\n` +
      `  ${w.touches} swings, ${w.ageBars ? (w.ageBars * 4 / 24).toFixed(0) + 'd' : '?'}, room ${w.room.toFixed(1)} ATR\n` +
      (w.ifBreak ? `  through → ${w.ifBreak.kind} ${w.ifBreak.dir > 0 ? 'LONG' : 'SHORT'}\n` : '') +
      (w.ifReject ? `  rejects → ${w.ifReject.context || w.ifReject.kind}${w.ifReject.grade ? ' ' + w.ifReject.grade : ''} ${w.ifReject.dir > 0 ? 'LONG' : 'SHORT'}` : '');
  });
  pushover(`${crNew.length} level${crNew.length > 1 ? 's' : ''} at code red`, packed(lines));
}
// A code-red level carries a plan. When it resolves and no branch qualifies,
// that plan is withdrawn — and being told is the whole point, because the last
// thing sent about that level was an instruction to act on it.
if (lapsed.length) {
  const lines = lapsed.map(l =>
    `${l.sym} closed ${l.dir > 0 ? 'above' : 'below'} ${l.level.toFixed(dp(l.sym))}\n` +
    `  ${l.movedPips.toFixed(0)}p past it — no branch qualified\n` +
    `  the earlier watch plan on this level is void`);
  pushover(`${lapsed.length} watch${lapsed.length > 1 ? 'es' : ''} lapsed`, packed(lines));
}

// Written LAST, so it captures both setup and watch keys. Writing it earlier
// meant every code-red level looked new on every scan.
if (WILL_DELIVER) {
  writeFileSync(STATE, JSON.stringify(nowSeen, null, 1));
} else {
  console.log(MARKET_OPEN
    ? '\n(inspection run — state NOT advanced, nothing was marked as seen)'
    : '\n(market closed — no pushes, state NOT advanced; the first scan after the open will send anything new)');
}

console.log(`\n${hits.length} setups (${fresh.length} new)   |   ${cr.length} code red (${crNew.length} new)   |   ${wa.length} watching`);
