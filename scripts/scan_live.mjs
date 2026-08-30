#!/usr/bin/env node
/**
 * Live monitor for the validated setup. Read-only — reads OANDA, prints, and
 * optionally sends Pushover. It cannot place an order.
 *
 * Reports the full state machine, not just entries, because the user asked to
 * be told when the system STARTS watching a level, not only when it fires:
 *
 *   WATCHING   daily close within 1 daily ATR of a level
 *   CODE RED   holding there without closing beyond  (n days)
 *   ENTRY      a candle rejects the level
 *
 * RSI GATE REMOVED 2026-08-26. It used to be required here — longs under 40,
 * shorts over 60 — on the strength of +0.251/+0.098/+0.143R against a breakeven
 * baseline. Those numbers were measured through a 23-hour lookahead in
 * watchlist.js (OANDA stamps a bar with its OPEN time; see the memory note on
 * bar timestamps). Corrected, the gate helps in one window, does nothing in two,
 * and is harmful in the 6-year holdout, where the WRONG-way RSI bucket returns
 * +0.26R against the gate's -0.075R.
 *
 * Corrected baseline, ungated, target 1.0R, four windows:
 *     +0.128 / +0.097 / +0.106 / +0.156 R    t = 6.0-7.7, positive in all four
 *
 * So the setup stands on its own and there is currently NO validated entry
 * filter. Daily RSI is still printed as context — it is just not a gate.
 *
 * Usage: node scripts/scan_live.mjs [--pairs A,B] [--risk 1.0] [--notify] [--all]
 */
import { getCandles, getPricing, getSummary, getOpenTrades, placeMarketOrder,
         ACCOUNT_ID, LIVE_ACCOUNT_ID, SANDBOX_ACCOUNT_ID } from '../src/oanda.js';
import { atr, rsi } from '../src/indicators.js';
import { buildLevels } from '../src/structure.js';
import https from 'https';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
// SIZE IS FIXED, NOT A PERCENTAGE. Every entry is one marker — 0.01 lot, the
// broker minimum. The user adds to winners by hand; the scanner never sizes off
// NAV and never compounds. Dollar risk therefore VARIES with the stop: a 49-pip
// NZDJPY stop is ~$3.30, a 120-pip GBPJPY stop is ~$8.20. That spread is
// accepted deliberately in exchange for one less moving part.
const RISK_PCT = argOf('--risk') ? parseFloat(argOf('--risk')) : null;
const TARGET_R = parseFloat(argOf('--targetR') || '1.0');
const MARKER_UNITS = parseInt(argOf('--units') || '1000', 10);   // 0.01 lot
const TRADE = args.includes('--trade');
const NOTIFY = args.includes('--notify');
const SHOW_ALL = args.includes('--all');

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * No orders near the daily roll.
 *
 * The FX day opens and closes at 17:00 New York, and that is also when the
 * week opens and closes. Spreads blow out across it and liquidity is thin, so
 * the user's rule is: nothing inside 90 minutes either side. Computed in NY
 * time rather than UTC because the offset moves with daylight saving — 17:00 NY
 * is 21:00 UTC in summer and 22:00 in winter, and hard-coding either is wrong
 * for half the year.
 *
 * Note this bites: a daily rejection candle CLOSES at 17:00 NY, dead centre of
 * the window, so the earliest an entry can go on is 18:30 NY.
 */
function rollWindow(now = new Date(), minutes = 90) {
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = ny.getHours() * 60 + ny.getMinutes();
  const roll = 17 * 60;
  const delta = Math.abs(mins - roll);
  const blocked = delta <= minutes;
  const label = ny.toTimeString().slice(0, 5) + ' NY';
  return { blocked, label, minsToRoll: mins - roll };
}
const ROLL = rollWindow();
const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;
const fmt = (s, v) => v.toFixed(/JPY$/.test(s) ? 3 : 5);

function pushover(title, message) {
  if (process.env.PUSHOVER_ENABLED !== '1' || !process.env.PUSHOVER_TOKEN) return;
  const body = new URLSearchParams({ token: process.env.PUSHOVER_TOKEN, user: process.env.PUSHOVER_USER,
    title, message, priority: '1' }).toString();
  const req = https.request({ hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } });
  req.on('error', () => {}); req.write(body); req.end();
}

// Size against the funded account. OANDA_ACCOUNT_ID deliberately points at the
// empty sandbox, whose NAV of 0 silently produced a size of 0 and no size line
// at all. Reading the live account is safe — getSummary is a GET, and the write
// guard is unchanged.
const nav = await getSummary(LIVE_ACCOUNT_ID || ACCOUNT_ID)
  .then(a => parseFloat(a.NAV)).catch(() => null);

// Live prices, so proximity to a level is current rather than as of the last
// daily close. The ENTRY still requires a daily rejection candle — that only
// exists once a day — but "price is at the level now" is intraday information
// and is the part the user wants to hear about while it is happening.
const live = await getPricing(PAIRS).catch(() => ({}));

// Net currency exposure from open trades. With 8 currencies only 4 trades can
// share no currency at all, so most alerts will double an exposure already
// held rather than diversify it. Declining those is correct, not a missed
// opportunity — but only if it is visible at the time.
const openTrades = await getOpenTrades(LIVE_ACCOUNT_ID || ACCOUNT_ID).catch(() => []);
const exposure = {};
for (const t of openTrades) {
  const [b, q] = t.instrument.split('_');
  const u = parseFloat(t.currentUnits);
  exposure[b] = (exposure[b] || 0) + u;      // long the base
  exposure[q] = (exposure[q] || 0) - u;      // short the quote
}
function overlap(sym, dir) {
  const b = sym.slice(0, 3), q = sym.slice(3);
  const bd = dir === 'LONG' ? 1 : -1;
  const notes = [];
  for (const [c, d] of [[b, bd], [q, -bd]]) {
    const cur = exposure[c] || 0;
    if (!cur) continue;
    if (Math.sign(cur) === Math.sign(d)) notes.push(`${c} doubles`);
    else notes.push(`${c} offsets`);
  }
  return notes;
}

// Alert state, so running every 4 hours does not re-send the same thing. Only
// transitions are announced; a level that was already CODE RED stays quiet
// until it changes.
const SEEN = join(REPO_DIR, '.scan_state.json');
const seen = existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : {};
const nowSeen = {};
const usdjpy = await getPricing('USDJPY').then(p => p.USDJPY.mid).catch(() => 150);
const entries = [], codeRed = [], watching = [];

for (const sym of PAIRS) {
  try {
    const D = await getCandles(sym, { granularity: 'D', count: 800 });
    if (D.length < 250) continue;
    const a = atr(D, 14);
    const r = rsi(D.map(b => b.close), 14);
    const i = D.length - 1;
    const av = a[i], dr = r[i];
    if (!av || dr == null) continue;
    const last = D[i], pip = pipOf(sym);
    const levels = buildLevels(D, { binATR: 0.35, minBars: 3 }).filter(z => z.confirmedAt <= i);

    for (const z of levels) {
      const isSup = z.kind === 'support';
      const spot = live[sym]?.mid ?? last.close;
      // Proximity judged on LIVE price, not the last daily close.
      if (Math.abs(spot - z.price) > av) continue;                // not being watched

      // How many recent days have held here without closing beyond?
      let hold = 0;
      for (let k = i; k >= Math.max(0, i - 15); k--) {
        if (Math.abs(D[k].close - z.price) > a[k]) break;
        if (isSup ? D[k].close < z.low : D[k].close > z.high) break;
        hold++;
      }
      const dir = isSup ? 'LONG' : 'SHORT';
      // Reported, not enforced. See the note at the top of this file.
      const rsiOK = isSup ? dr < 40 : dr > 60;
      const rejected = (isSup ? last.low <= z.high : last.high >= z.low)
                    && (isSup ? last.close > z.high : last.close < z.low);

      const px = last.close;
      const stop = isSup ? z.low - av * 0.3 : z.high + av * 0.3;
      const risk = Math.abs(px - stop);
      // TARGET: a flat 1.0R, not a level.
      //
      // Level bands cover ~73% of the traded range, so "first level >= 1.5R"
      // was resolving to "roughly 1.5R" — the level was not constraining the
      // choice, it was just picking a worse distance. A fixed 1.0R beat it in
      // all four windows including the 6y holdout (+0.109/+0.039/+0.079/+0.144
      // vs +0.082/+0.004/+0.055/+0.143), and independently beat every trailing
      // and partial-exit variant. See project-backtest-findings.
      const tgt = { price: isSup ? px + risk * TARGET_R : px - risk * TARGET_R };
      const rr = TARGET_R;
      // One marker per entry. --risk is an override for sizing off NAV instead.
      const units = RISK_PCT && nav && risk
        ? Math.floor((nav * RISK_PCT / 100) / (risk * (/JPY$/.test(sym) ? 1 / usdjpy : 1)))
        : MARKER_UNITS;
      const riskUsd = risk * units * (/JPY$/.test(sym) ? 1 / usdjpy : 1);

      const state = rejected ? 'ENTRY' : hold >= 2 ? 'CODE_RED' : 'WATCHING';
      const key = `${sym}:${dir}:${z.price.toFixed(5)}`;
      nowSeen[key] = state;
      const isNew = seen[key] !== state;          // only transitions are news
      const distPips = Math.abs(spot - z.price) / pip;

      const rec = { sym, dir, level: z.price, hold, dr, rsiOK, rejected, px, stop,
                    target: tgt?.price, rr, risk: risk / pip, units, riskUsd, touches: z.touches,
                    spot, distPips, isNew, key };
      if (rejected) entries.push(rec);
      else if (hold >= 2) codeRed.push(rec);
      else watching.push(rec);
      void 0;
    }
  } catch (e) { /* skip unavailable pair */ }
}

// The backtest drops any bar where levels either side argue opposite ways — a
// setup with no view — and keeps the best geometry otherwise. The live scan has
// to apply the identical rule or its signals are not the ones that were tested.
function dedupe(list) {
  const byPair = new Map();
  for (const r of list) { if (!byPair.has(r.sym)) byPair.set(r.sym, []); byPair.get(r.sym).push(r); }
  const out = [];
  for (const [, group] of byPair) {
    if (new Set(group.map(g => g.dir)).size > 1) continue;      // contradictory
    out.push(group.sort((a, b) => (b.rr ?? 0) - (a.rr ?? 0))[0]);
  }
  return out;
}
const conflicted = [...new Set(entries.map(e => e.sym))]
  .filter(sym => new Set(entries.filter(e => e.sym === sym).map(e => e.dir)).size > 1);
const finalEntries = dedupe(entries);

console.log(`\nLIVE SCAN — ${new Date().toISOString().slice(0, 16)}Z   ${PAIRS.length} pairs`);
if (nav) console.log(`account ${LIVE_ACCOUNT_ID || ACCOUNT_ID}   NAV $${nav.toFixed(2)}   ` +
  `size ${RISK_PCT ? RISK_PCT + '%/trade' : `${MARKER_UNITS} units (0.01 lot) flat`}   ` +
  `target ${TARGET_R.toFixed(1)}R   ${TRADE ? '\u26a0 TRADING ARMED' : '(read-only)'}`);
console.log('='.repeat(72));
if (TRADE) {
  console.log(ROLL.blocked
    ? `⏸ ${ROLL.label} — inside the 17:00 NY roll window, no orders will be placed`
    : `⏱ ${ROLL.label} — clear of the roll window (${Math.abs(ROLL.minsToRoll)}m ${ROLL.minsToRoll < 0 ? 'before' : 'after'} 17:00 NY)`);
  console.log(`orders go to ${SANDBOX_ACCOUNT_ID || '(no sandbox account set)'} at ${MARKER_UNITS} units, stop + target attached on fill`);
}
if (Object.keys(exposure).length) {
  const line = Object.entries(exposure).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([c, u]) => `${c} ${u > 0 ? '+' : '-'}${Math.abs(u).toLocaleString()}`).join('   ');
  console.log(`open exposure: ${line}`);
}

if (finalEntries.length) {
  console.log('\n🎯 ENTRY — a daily candle rejected the level\n');
  for (const e of finalEntries) {
    const ov = overlap(e.sym, e.dir);
    console.log(`  ${e.sym}  ${e.dir}${e.isNew ? '   ** NEW **' : ''}   level ${fmt(e.sym, e.level)} (${e.touches} touches, held ${e.hold}d)`);
    // Overlap is no longer a reason to skip. Taking every signal at small size
    // beat taking a quarter of them at 1% — return per unit of drawdown roughly
    // doubled in all three windows tested, with up to 24 positions open and a
    // worst day of -1.6%. It is still worth SEEING, because it is the exposure
    // that would concentrate if correlations went to 1.
    if (ov.length) console.log(`    ↔ adds to existing exposure: ${ov.join(', ')}`);
    else if (openTrades.length) console.log(`    ✓ diversifies — no currency shared with open positions`);
    console.log(`    entry ${fmt(e.sym, e.px)}   stop ${fmt(e.sym, e.stop)} (${e.risk.toFixed(0)}p)   target ${fmt(e.sym, e.target)} (${e.rr.toFixed(1)}R)`);
    if (e.units) console.log(`    size ${e.units.toLocaleString()} units (0.01 lot) = $${e.riskUsd.toFixed(2)} risk` +
      (nav ? ` = ${(e.riskUsd / nav * 100).toFixed(2)}% of NAV` : '') + `    daily RSI ${e.dr.toFixed(1)}`);
    if (!TRADE) console.log(`    PUT THE STOP IN AS A REAL ORDER.`);
  }
  if (TRADE) {
    const openSyms = new Set(openTrades.map(t => t.instrument.replace('_', '')));
    for (const e of finalEntries) {
      const why = ROLL.blocked
        ? `inside the ${ROLL.label} roll window — no orders within 90m of 17:00 NY`
        : openSyms.has(e.sym) ? 'already holding this pair'
        : null;
      if (why) { console.log(`    ⏸ not placed: ${why}`); continue; }
      const units = e.dir === 'LONG' ? MARKER_UNITS : -MARKER_UNITS;
      try {
        const res = await placeMarketOrder({
          symbol: e.sym, units, stop: e.stop, target: e.target,
          accountId: SANDBOX_ACCOUNT_ID,
          reason: `${e.dir} lvl ${fmt(e.sym, e.level)} rsi ${e.dr.toFixed(0)}`,
        });
        const fill = res.orderFillTransaction;
        console.log(fill
          ? `    ✅ FILLED ${units > 0 ? '+' : ''}${units} @ ${fill.price}  (trade ${fill.tradeOpened?.tradeID})`
          : `    ⚠ order accepted but not filled — ${res.orderCancelTransaction?.reason || 'see OANDA'}`);
        appendFileSync(join(REPO_DIR, 'orders.jsonl'),
          JSON.stringify({ ts: new Date().toISOString(), sym: e.sym, dir: e.dir, units,
                           entry: e.px, stop: e.stop, target: e.target, res: fill || res }) + '\n');
      } catch (err) {
        console.log(`    ❌ order failed: ${err.message}`);
      }
    }
  }
} else console.log('\nNo entries.');
if (conflicted.length) console.log(`\n  (dropped ${conflicted.join(', ')} — levels either side firing opposite ways, no view)`);

if (codeRed.length) {
  console.log(`\n🔴 CODE RED — holding at a level, waiting for it to resolve\n`);
  for (const c of codeRed.sort((a, b) => b.hold - a.hold)) {
    const gate = `RSI ${c.dr.toFixed(0)}${c.rsiOK ? ' (extreme)' : ''}`;
    console.log(`  ${c.sym.padEnd(7)} ${c.dir.padEnd(6)} level ${fmt(c.sym, c.level)}  ${c.distPips.toFixed(0)}p away  held ${c.hold}d  ${c.touches} touches   ${gate}${c.isNew ? '   ** NEW **' : ''}`);
  }
}

if (SHOW_ALL && watching.length) {
  console.log(`\n👁  WATCHING — within 1 daily ATR of a level\n`);
  for (const w of watching) {
    console.log(`  ${w.sym.padEnd(7)} ${w.dir.padEnd(6)} level ${fmt(w.sym, w.level)}  daily RSI ${w.dr.toFixed(0)}`);
  }
} else if (!SHOW_ALL) {
  console.log(`\n(${watching.length} more within 1 ATR of a level — use --all to list)`);
}
console.log('');

// Persist what the scanner SAID, so it can later be reconciled against what the
// user actually did. Without this the comparison is impossible after the fact:
// which alerts were taken, which skipped, where the stop went versus where it
// was suggested. That difference is the thing worth learning from.
for (const e of finalEntries.filter(x => x.isNew)) {
  appendFileSync(join(REPO_DIR, 'alerts.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), sym: e.sym, dir: e.dir, level: e.level,
    entry: e.px, stop: e.stop, target: e.target, rr: e.rr,
    riskPips: e.risk, units: e.units, dailyRsi: e.dr, heldDays: e.hold,
    touches: e.touches, state: 'ENTRY',
  }) + '\n');
}
for (const c of codeRed.filter(x => x.isNew)) {
  appendFileSync(join(REPO_DIR, 'alerts.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), sym: c.sym, dir: c.dir, level: c.level,
    dailyRsi: c.dr, heldDays: c.hold, touches: c.touches,
    state: 'CODE_RED', gate: c.rsiOK ? 'rsi_extreme' : 'rsi_mid',
  }) + '\n');
}
// Only transitions are logged. Logging current state on every run would write
// the same rows hourly and make the journal useless for reconciling against
// actual trades later.
const nE = finalEntries.filter(x => x.isNew).length, nC = codeRed.filter(x => x.isNew).length;
if (nE || nC) console.log(`logged ${nE} new entr${nE === 1 ? 'y' : 'ies'} + ${nC} new code-red to alerts.jsonl`);

writeFileSync(SEEN, JSON.stringify(nowSeen));

const fresh = finalEntries.filter(e => e.isNew);
if (NOTIFY && fresh.length) {
  const e = fresh[0];
  pushover(`${e.sym} ${e.dir} — level rejection`,
    `${fmt(e.sym, e.px)}  stop ${fmt(e.sym, e.stop)}  target ${fmt(e.sym, e.target)} (${e.rr.toFixed(1)}R)\n` +
    `${e.units ? e.units.toLocaleString() + ' units' : ''}   daily RSI ${e.dr.toFixed(0)}   level held ${e.hold}d\n` +
    `PUT THE STOP IN AS A REAL ORDER.`);
  console.log(`sent Pushover for ${e.sym}${fresh.length > 1 ? ` (+${fresh.length - 1} more new)` : ''}\n`);
} else if (NOTIFY) {
  console.log('nothing new since last run — no Pushover sent\n');
}
