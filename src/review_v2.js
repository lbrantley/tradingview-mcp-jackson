/**
 * The daily review, rebuilt 2026-08-31.
 *
 * The old one shelled out to `scanner.mjs --review`, which drives TradingView
 * over CDP on port 9222. On the VM that browser is not running, so every review
 * for weeks has opened with 28 lines of "CDP connection failed" while checking
 * setups from the retired level-rejection scanner — a strategy measured to have
 * no edge. Broken tooling reporting on a deleted system.
 *
 * This resolves outcomes from OANDA candles instead. No browser, no CDP.
 * It answers three questions a daily review should:
 *   what did the scanner call, and how did those calls turn out
 *   what am I actually holding, and how close is anything to its stop
 *   what is coming that could move it
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCandles, getPricing, getSummary, getOpenTrades, LIVE_ACCOUNT_ID, ACCOUNT_ID } from './oanda.js';
import { getCalendar, eventsFor } from './news.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALERTS = join(REPO, 'alerts_v2.jsonl');
const dp = s => /JPY$/.test(s) ? 3 : 5;
const pipOf = s => /JPY$/.test(s) ? 0.01 : 0.0001;

function loadAlerts(sinceDays) {
  if (!existsSync(ALERTS)) return [];
  const cut = Date.now() - sinceDays * 86400e3;
  const rows = readFileSync(ALERTS, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(a => a && Date.parse(a.time) >= cut);
  // The log can carry repeats — a re-run with a cleared state file re-logs
  // everything. Collapse on read so the review counts each call once.
  const seen = new Set();
  return rows.filter(a => {
    // Keyed on the TRADE, not the level: two nearby zones can produce the same
    // entry and target with slightly different stops. That is one call.
    const k = `${a.sym}${a.kind}${a.dir}${a.time}${a.target.toFixed(5)}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

/** Walk H4 bars forward from the alert and see what happened. */
async function resolve(a) {
  const b = await getCandles(a.sym, { granularity: 'H4', count: 200 });
  const i = b.findIndex(x => x.time >= a.time);
  if (i < 0) return { ...a, outcome: 'no data' };
  const L = a.dir > 0;
  for (let j = i + 1; j < b.length; j++) {
    if (L ? b[j].low <= a.stop : b[j].high >= a.stop)
      return { ...a, outcome: 'stopped', r: -1, at: b[j].time };
    if (L ? b[j].high >= a.target : b[j].low <= a.target)
      return { ...a, outcome: 'target', r: a.rr, at: b[j].time };
  }
  const last = b[b.length - 1].close;
  const risk = Math.abs(a.px - a.stop);
  return { ...a, outcome: 'open', r: (L ? last - a.px : a.px - last) / risk, now: last };
}

export async function buildReview({ days = 1 } = {}) {
  const out = [];
  const alerts = loadAlerts(days);
  const older = loadAlerts(30).filter(a => Date.parse(a.time) < Date.now() - days * 86400e3);

  // ---- the account, first: it is the thing that is actually at risk ----
  const acct = await getSummary(LIVE_ACCOUNT_ID || ACCOUNT_ID).catch(() => null);
  const trades = await getOpenTrades(LIVE_ACCOUNT_ID || ACCOUNT_ID).catch(() => []);
  const syms = [...new Set(trades.map(t => t.instrument.replace('_', '')))];
  const px = syms.length ? await getPricing(syms).catch(() => ({})) : {};
  const cal = await getCalendar({ snapshot: false }).catch(() => []);

  out.push('## Account\n');
  if (cal.stale) out.push('_Calendar from the last snapshot — the live feed was rate limited._\n');
  if (acct) out.push(`NAV **$${(+acct.NAV).toFixed(2)}**   unrealised $${(+acct.unrealizedPL).toFixed(2)}   ` +
    `margin available $${(+acct.marginAvailable).toFixed(2)}   ${trades.length} open\n`);
  if (trades.length) {
    out.push('| pair | units | entry | now | P/L | stop | distance | news 48h |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const t of trades) {
      const s = t.instrument.replace('_', ''), d = dp(s), pip = pipOf(s);
      const now = px[s]?.mid, sl = t.stopLossOrder ? +t.stopLossOrder.price : null;
      const ev = eventsFor(cal, s, new Date(), { hoursAhead: 96 });   // trades hold ~7 days
      out.push(`| ${s} | ${t.currentUnits} | ${(+t.price).toFixed(d)} | ${now ? now.toFixed(d) : '—'} | ` +
        `$${(+t.unrealizedPL).toFixed(2)} | ${sl ? sl.toFixed(d) : '**none**'} | ` +
        `${sl && now ? Math.abs((now - sl) / pip).toFixed(0) + 'p' : '—'} | ` +
        `${ev.length ? ev.map(e => e.title).join(', ') : '—'} |`);
    }
    out.push('');
  } else out.push('_No open positions._\n');

  // ---- what the scanner called, and how it went ----
  out.push(`## Scanner calls, last ${days} day${days > 1 ? 's' : ''}\n`);
  if (!alerts.length) out.push('_None._\n');
  else {
    const res = [];
    for (const a of alerts) res.push(await resolve(a));
    // Two levels on one pair can point opposite ways on the same bar. That is a
    // real state of the world, not a bug, and it means no directional read —
    // so say so rather than printing both as if each were a signal.
    const byBar = {};
    for (const r of res) (byBar[`${r.sym}@${r.time}`] ||= new Set()).add(r.dir);
    const conflicted = new Set(Object.entries(byBar).filter(([, v]) => v.size > 1).map(([k]) => k));
    if (conflicted.size) out.push(`⚠️ **${conflicted.size} conflicted**: ` +
      [...conflicted].map(k => k.split('@')[0]).join(', ') + ' — levels either side firing opposite ways, no read.\n');
    out.push('| when | pair | dir | branch | entry | stop | target | outcome |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const r of res) {
      if (conflicted.has(`${r.sym}@${r.time}`)) continue;
      const d = dp(r.sym);
      out.push(`| ${r.time.slice(5, 16)} | ${r.sym} | ${r.dir > 0 ? 'LONG' : 'SHORT'} | ${r.kind} | ` +
        `${r.px.toFixed(d)} | ${r.stop.toFixed(d)} | ${r.target.toFixed(d)} | ` +
        `${r.outcome}${r.r != null ? ` ${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R` : ''} |`);
    }
    out.push('');
  }

  // ---- the running tally, which is the only thing that compounds ----
  if (older.length) {
    const res = [];
    for (const a of older.slice(-60)) res.push(await resolve(a));
    const done = res.filter(r => r.outcome === 'stopped' || r.outcome === 'target');
    if (done.length) {
      const wins = done.filter(r => r.outcome === 'target').length;
      const sum = done.reduce((s, r) => s + r.r, 0);
      out.push('## Running tally, last 30 days\n');
      out.push(`${done.length} resolved · ${wins} target / ${done.length - wins} stopped · ` +
        `**${sum >= 0 ? '+' : ''}${sum.toFixed(1)}R** · ${(sum / done.length >= 0 ? '+' : '')}${(sum / done.length).toFixed(3)}R per call · ` +
        `${res.filter(r => r.outcome === 'open').length} still open\n`);
    }
  }
  return out.join('\n');
}
