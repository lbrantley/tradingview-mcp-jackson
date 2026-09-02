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
import { findSetups } from './setups.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALERTS = join(REPO, 'alerts_v2.jsonl');
const dp = s => /JPY$/.test(s) ? 3 : 5;

/**
 * TAILWIND / HEADWIND — ported from the retired scanner (scanner.mjs:2047),
 * because it was the part of the old brief the user found genuinely useful:
 * not "there is an event" but "this event is working for or against you."
 *
 * Direction comes from forecast vs previous. Higher normally means a stronger
 * currency — except for unemployment-style prints, where higher is weakness.
 * Alignment then depends on which side of the pair the currency sits on: for a
 * LONG, base strength helps and quote strength hurts; a SHORT is the mirror.
 *
 * Note this reads the FORECAST, so it says which way the consensus leans, not
 * what will actually print. A tailwind here is an expectation, not a promise.
 */
function parseNewsValue(v) {
  if (v == null) return null;
  const m = String(v).replace(/[,%$]/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/K/i.test(v)) n *= 1e3;
  if (/M/i.test(v)) n *= 1e6;
  if (/B/i.test(v)) n *= 1e9;
  return n;
}

function newsDirection(e) {
  const f = parseNewsValue(e.forecast), p = parseNewsValue(e.previous);
  if (f === null || p === null) return null;
  const t = (e.title || '').toLowerCase();
  const inverted = t.includes('unemployment') || t.includes('jobless') || t.includes('claimant');
  const diff = f - p;
  if (diff === 0) return 'neutral';
  return (inverted ? diff < 0 : diff > 0) ? 'strength' : 'weakness';
}

function alignment(isLong, isBase, dir) {
  if (!dir || dir === 'neutral') return 'neutral';
  if (isLong) return isBase ? (dir === 'strength' ? 'tailwind' : 'headwind')
                            : (dir === 'weakness' ? 'tailwind' : 'headwind');
  return isBase ? (dir === 'weakness' ? 'tailwind' : 'headwind')
                : (dir === 'strength' ? 'tailwind' : 'headwind');
}

/** Every upcoming event on a pair, tagged for how it leans against a position. */
function windsFor(cal, sym, isLong, hours = 96) {
  const base = sym.slice(0, 3), quote = sym.slice(3);
  return eventsFor(cal, sym, new Date(), { hoursAhead: hours })
    .map(e => ({ e, side: e.country === base ? 'base' : 'quote' }))
    .map(({ e, side }) => ({ ...e, side, lean: alignment(isLong, side === 'base', newsDirection(e)) }));
}
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

  const positionWinds = [];
  out.push('## Account\n');
  if (cal.stale) out.push('_Calendar from the last snapshot — the live feed was rate limited._\n');
  if (acct) out.push(`NAV **$${(+acct.NAV).toFixed(2)}**   unrealised $${(+acct.unrealizedPL).toFixed(2)}   ` +
    `margin available $${(+acct.marginAvailable).toFixed(2)}   ${trades.length} open\n`);
  const posRead = [];
  if (trades.length) {
    out.push('| pair | units | now | P/L | stop | distance | news lean |');
    out.push('|---|---|---|---|---|---|---|');
    for (const t of trades) {
      const s = t.instrument.replace('_', ''), d = dp(s), pip = pipOf(s);
      const now = px[s]?.mid, sl = t.stopLossOrder ? +t.stopLossOrder.price : null;
      const isLong = +t.currentUnits > 0;
      const w = windsFor(cal, s, isLong);
      const tw = w.filter(x => x.lean === 'tailwind'), hw = w.filter(x => x.lean === 'headwind');
      const lean = !w.length ? '—'
        : `${tw.length ? `🟢 ${tw.length} tailwind` : ''}${tw.length && hw.length ? ' · ' : ''}` +
          `${hw.length ? `🔴 ${hw.length} headwind` : ''}${!tw.length && !hw.length ? `${w.length} neutral` : ''}`;
      out.push(`| ${s} | ${t.currentUnits} | ${now ? now.toFixed(d) : '—'} | ` +
        `$${(+t.unrealizedPL).toFixed(2)} | ${sl ? sl.toFixed(d) : '**none**'} | ` +
        `${sl && now ? Math.abs((now - sl) / pip).toFixed(0) + 'p' : '—'} | ${lean} |`);
      positionWinds.push({ sym: s, isLong, w });
      // one read per pair+direction, however many tickets are open on it
      if (!posRead.some(r => r.sym === s && r.isLong === isLong))
        posRead.push({ sym: s, isLong, now });
    }
    out.push('');

    // ---- what the system says about each position -------------------------
    // The table above reports the trade. It never said what the trade was FOR:
    // which level, where the measured move projects, what the system's own stop
    // was. On 2026-09-02 the user was holding CHFJPY with an eyeballed target
    // because the setup that generated it had been lost (see the catch-up fix
    // in scan_v2). Even when nothing was logged, the level engine can still say
    // where the structure sits right now.
    out.push('**What the system reads on each position**\n');
    for (const p of posRead) {
      try {
        const b = await getCandles(p.sym, { granularity: 'H4', count: 3000 });
        const dd = await getCandles(p.sym, { granularity: 'D', count: 600 });
        if (b.length < 1000) { out.push(`- **${p.sym}** — not enough history.`); continue; }
        const dir = p.isLong ? 1 : -1;
        const d2 = dp(p.sym), pip2 = pipOf(p.sym);
        // most recent setup in the direction the position is actually held
        const mine = findSetups(b, dd).filter(x => x.dir === dir).slice(-1)[0];
        const bits = [];
        if (mine) {
          const age = Math.round((Date.now() - Date.parse(mine.time)) / 36e5);
          bits.push(`last ${mine.context || mine.kind} ${p.isLong ? 'LONG' : 'SHORT'} ` +
            `${age}h ago at ${mine.level.toFixed(d2)} — system stop ${mine.stop.toFixed(d2)}, ` +
            `target **${mine.target.toFixed(d2)}**` +
            (mine.grade ? ` (Grade ${mine.grade})` : ''));
          if (p.now != null) {
            const togo = Math.abs(mine.target - p.now) / pip2;
            bits.push(`${togo.toFixed(0)}p to that target from here`);
          }
        } else bits.push('no setup on record in this direction');
        out.push(`- **${p.sym}** ${p.isLong ? 'LONG' : 'SHORT'} — ${bits.join('; ')}`);
      } catch (e) { out.push(`- **${p.sym}** — level read failed: ${e.message}`); }
    }
    out.push('');
  } else out.push('_No open positions._\n');

  // ---- the winds, per position, in time order ----
  // Two positions on one pair share one calendar — list it once.
  const byPair = [];
  for (const p of positionWinds.filter(x => x.w.length))
    if (!byPair.some(x => x.sym === p.sym && x.isLong === p.isLong)) byPair.push(p);
  const anyWind = byPair;
  if (anyWind.length) {
    out.push('## What is coming, and which way it leans\n');
    for (const p of anyWind) {
      out.push(`**${p.sym} ${p.isLong ? 'LONG' : 'SHORT'}**`);
      for (const e of p.w.sort((a, b) => a.date.localeCompare(b.date))) {
        const mark = e.lean === 'tailwind' ? '🟢' : e.lean === 'headwind' ? '🔴' : '⚪';
        out.push(`- ${mark} ${e.date.slice(5, 16)} ${e.country} — ${e.title}` +
          (e.forecast ? `  (fc ${e.forecast}${e.previous ? ` vs prev ${e.previous}` : ''})` : ''));
      }
      out.push('');
    }
    out.push('_Lean is read from forecast vs previous — which way consensus leans, not what will print._\n');
  }

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
