#!/usr/bin/env node
/**
 * Replay real historical setups against real OANDA candles to test EXIT rules.
 *
 * The question this answers: are the take-profit levels too close? The audit
 * says TP2 pays +1.82R and TP3 +4.24R, but only 19 of 147 winners ever reach
 * them — everything closes at TP1 for +1.26R. If targets are simply too tight,
 * that is worth more than any new entry signal.
 *
 * Why replay rather than trust the audit: the audit's outcomes were inferred
 * by a scanner polling every ~15 minutes, which since 2026-07-30 was failing
 * to read the chart on nearly every pass. Here the entry, stop and targets are
 * taken from the setup as recorded, but WHAT HAPPENED NEXT comes from actual
 * M15 candles.
 *
 * Honest about its two main sources of error:
 *   - Spread is charged at entry, from real bid/ask candles at that moment.
 *   - Intrabar ordering is unknowable even at M15: if one bar's range covers
 *     both the stop and a target, we cannot tell which came first, so we
 *     assume the STOP. That is pessimistic by design — it is the assumption
 *     that cannot flatter a result.
 *
 * Usage:
 *   node scripts/replay_exits.mjs [--limit N] [--audit path]
 */
import { getCandles, getPricing, toInstrument } from '../src/oanda.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const LIMIT = parseInt(argOf('--limit') || '0', 10) || Infinity;
const AUDIT = argOf('--audit') || join(__dirname, '..', 'scanner_audit.json');
const HOLD_HOURS = 72 * 3;   // generous: 72 market hours, padded for weekends

if (!existsSync(AUDIT)) { console.error(`No audit at ${AUDIT}`); process.exit(1); }
const setups = JSON.parse(readFileSync(AUDIT, 'utf8')).setups || [];

// Mirror reviewSetups(): an LTF-confirmed pullback trades in suggestedDirection
// (opposite the stored type) against continuationLevels.
function plan(s) {
  const type = s.ltfConfirmed && s.suggestedDirection ? s.suggestedDirection : s.type;
  const cl = s.ltfConfirmed ? s.continuationLevels : null;
  const entry = cl?.entry ?? s.triggerPrice ?? s.entryPrice;
  const sl = cl?.sl ?? s.sl;
  const tp1 = cl?.tp1 ?? s.tp1;
  const tp2 = cl?.tp2 ?? s.tp2;
  // continuationLevels has no tp3; the stored one belongs to the ORIGINAL
  // direction and sits on the wrong side once flipped. Drop it rather than
  // repeat the bug that fabricated 110 wins.
  const tp3 = cl ? null : s.tp3;
  const short = /SHORT/.test(type);
  if (entry == null || sl == null) return null;
  const risk = Math.abs(entry - sl);
  if (!risk) return null;
  // Reject malformed geometry before it can dominate an average. Six setups
  // in the Mac audit have a stop of 3-30 pips against a target 200-1,700 pips
  // out, scoring 16R to 56R; two of those landing would swamp 480 honest
  // trades. Median R-to-TP1 is 1.43 and p95 is 4.68, so >10R is not a good
  // setup, it is a bad record. A sub-5-pip stop is not a stop either.
  const pip = /JPY$/.test(s.symbol.replace('OANDA:', '')) ? 0.01 : 0.0001;
  if (risk / pip < 5) return null;
  const rTo = tp => tp == null ? null : (short ? entry - tp : tp - entry) / risk;
  if (tp1 != null && rTo(tp1) > 10) return null;

  const ok = tp => tp != null && (short ? tp < entry : tp > entry);
  return {
    symbol: s.symbol.replace('OANDA:', ''), type, short, entry, sl, risk,
    tp1: ok(tp1) ? tp1 : null, tp2: ok(tp2) ? tp2 : null, tp3: ok(tp3) ? tp3 : null,
    time: s.timestamp,
  };
}

/** First level touched, walking bars in order. Stop wins any ambiguous bar. */
function walk(p, bars) {
  const hit = (bar, lvl, isTarget) => {
    if (lvl == null) return false;
    return p.short
      ? (isTarget ? bar.low <= lvl : bar.high >= lvl)
      : (isTarget ? bar.high >= lvl : bar.low <= lvl);
  };
  let best = null;   // furthest target reached so far
  for (const b of bars) {
    if (hit(b, p.sl, false)) return { exit: 'stop', reached: best };
    if (hit(b, p.tp3, true)) return { exit: 'tp3', reached: 'tp3' };
    if (hit(b, p.tp2, true)) best = 'tp2';
    else if (hit(b, p.tp1, true) && !best) best = 'tp1';
    if (best === 'tp2' && !p.tp3) return { exit: 'tp2', reached: 'tp2' };
  }
  return { exit: 'open', reached: best };
}

// Returns null for a missing level. Without this guard `null` coerces to 0 and
// the result is entry/risk — around 58R on a EURNZD setup whose wrong-side TP1
// had been nulled out. Eight such rows turned a true +0.04R into +1.30R.
const R = (p, px) => (px == null ? null : (p.short ? p.entry - px : px - p.entry) / p.risk);

async function main() {
  const rows = setups
    .filter(s => !s.quarantined && s.timestamp)
    .map(s => ({ s, p: plan(s) }))
    .filter(x => x.p)
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`Replaying ${rows.length} setups against real M15 candles...\n`);

  const spreadCache = {};
  const out = [];
  let done = 0;

  for (const { p } of rows) {
    try {
      const from = new Date(p.time).toISOString();
      const to = new Date(new Date(p.time).getTime() + HOLD_HOURS * 3600e3).toISOString();
      const bars = await getCandles(p.symbol, { granularity: 'M15', from, to });
      if (!bars.length) continue;

      if (spreadCache[p.symbol] === undefined) {
        const px = await getPricing(p.symbol);
        spreadCache[p.symbol] = px[p.symbol]?.spread ?? 0;
      }
      // Charged once, at entry, in R terms.
      const costR = spreadCache[p.symbol] / p.risk;

      const res = walk(p, bars);
      out.push({ p, res, costR });
    } catch (e) {
      // A pair that no longer exists or a window outside history — skip loudly
      // enough to be counted, quietly enough not to drown the run.
      if (!/OANDA 4\d\d/.test(e.message)) console.error(`  ${p.symbol}: ${e.message.slice(0, 70)}`);
    }
    if (++done % 25 === 0) process.stdout.write(`  ${done}/${rows.length}\r`);
  }
  console.log(`  replayed ${out.length}          \n`);

  // Each rule maps an outcome to R, net of spread.
  const rules = {
    'TP1 only (current)': ({ p, res, costR }) => {
      if (!p.tp1) return null;
      if (res.reached) return R(p, p.tp1) - costR;
      if (res.exit === 'stop') return -1 - costR;
      return null;
    },
    'TP2 only': ({ p, res, costR }) => {
      if (!p.tp2) return null;
      if (res.reached === 'tp2' || res.reached === 'tp3') return R(p, p.tp2) - costR;
      if (res.exit === 'stop') return -1 - costR;
      return null;
    },
    'half TP1, half TP2': ({ p, res, costR }) => {
      if (!p.tp1 || !p.tp2) return null;
      const r1 = R(p, p.tp1);
      if (res.reached === 'tp2' || res.reached === 'tp3') return (r1 + R(p, p.tp2)) / 2 - costR;
      if (res.reached === 'tp1' && res.exit === 'stop') return (r1 + 0) / 2 - costR;  // 2nd half to breakeven
      if (res.exit === 'stop') return -1 - costR;
      return null;
    },
    'half TP1, half runs to TP3': ({ p, res, costR }) => {
      if (!p.tp1) return null;
      const r1 = R(p, p.tp1);
      if (res.reached === 'tp3') return (r1 + R(p, p.tp3)) / 2 - costR;
      if (res.reached === 'tp2') return (r1 + R(p, p.tp2)) / 2 - costR;
      if (res.reached === 'tp1') return (r1 + 0) / 2 - costR;
      if (res.exit === 'stop') return -1 - costR;
      return null;
    },
  };

  console.log('EXIT RULE COMPARISON — net of spread, stop assumed on ambiguous bars\n');
  console.log('  rule                          n     win%    EXP        totalR');
  for (const [name, fn] of Object.entries(rules)) {
    const raw = out.map(fn).filter(r => r !== null && isFinite(r));
    const wild = raw.filter(r => Math.abs(r) > 12);
    if (wild.length) console.log(`  !! ${name}: ${wild.length} value(s) beyond 12R — inspect before trusting`);
    const rs = raw.filter(r => Math.abs(r) <= 12);
    if (rs.length < 10) { console.log(`  ${name.padEnd(28)} n=${rs.length} (too few)`); continue; }
    const sum = rs.reduce((a, b) => a + b, 0);
    const w = rs.filter(r => r > 0).length;
    console.log(`  ${name.padEnd(28)} ${String(rs.length).padStart(4)}` +
      `  ${(w / rs.length * 100).toFixed(1).padStart(5)}%` +
      `  ${(sum / rs.length >= 0 ? '+' : '') + (sum / rs.length).toFixed(3)}R` +
      `  ${(sum >= 0 ? '+' : '') + sum.toFixed(1)}`);
  }

  if (process.env.DEBUG_R === '1') {
    const fn = rules['TP1 only (current)'];
    const vals = out.map(x => ({ r: fn(x), sym: x.p.symbol, res: x.res, p: x.p }))
      .filter(x => x.r !== null && isFinite(x.r)).sort((a, b) => b.r - a.r);
    console.log('\n  top 8 returned R values:');
    vals.slice(0, 8).forEach(v => console.log(`    ${v.sym.padEnd(7)} R=${v.r.toFixed(2).padStart(7)}` +
      `  exit=${v.res.exit} reached=${v.res.reached}  entry=${v.p.entry} sl=${v.p.sl} tp1=${v.p.tp1} risk=${v.p.risk.toExponential(2)}`));
    const pos = vals.filter(v => v.r > 0);
    console.log(`    wins n=${pos.length} meanR=${(pos.reduce((a, b) => a + b.r, 0) / pos.length).toFixed(2)}`);
  }

  const reach = {};
  out.forEach(({ res }) => { const k = res.reached || 'none'; reach[k] = (reach[k] || 0) + 1; });
  console.log(`\n  furthest level reached: ${JSON.stringify(reach)}`);
  console.log(`  exit breakdown        : ${JSON.stringify(out.reduce((m, { res }) => (m[res.exit] = (m[res.exit] || 0) + 1, m), {}))}`);
}

main().catch(e => { console.error(e); process.exit(1); });
