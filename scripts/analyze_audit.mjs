#!/usr/bin/env node
/**
 * Offline expectancy analysis over scanner_audit.json.
 *
 * Exists because the Mac and the VM keep separate, gitignored audit files that
 * silently diverged (Mac: 2026-04-29 → 2026-07-10; VM: 2026-07-10 onward), and
 * the file is too large to move around by hand. Run this where the audit lives
 * and share the output instead of the data.
 *
 * Reads only. Never writes. Safe to run while the scanner is going.
 *
 * Usage:
 *   node scripts/analyze_audit.mjs                      # default audit
 *   node scripts/analyze_audit.mjs path/to/audit.json   # explicit file
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || join(__dirname, '..', 'scanner_audit.json');

if (!existsSync(FILE)) {
  console.error(`No audit at ${FILE}`);
  process.exit(1);
}
const audit = JSON.parse(readFileSync(FILE, 'utf8'));
const setups = audit.setups || [];

// ── Effective trade parameters ───────────────────────────────────────────
// Must mirror reviewSetups(): an LTF-confirmed pullback trades in
// suggestedDirection (the OPPOSITE of the stored type) against
// continuationLevels. Reading type/sl directly inverts the sign of R on every
// confirmed continuation.
const effType = s => (s.ltfConfirmed && s.suggestedDirection ? s.suggestedDirection : s.type);
const effSL = s => (s.ltfConfirmed && s.continuationLevels?.sl != null
  ? s.continuationLevels.sl
  : s.sl);

// Entry is ambiguous across schema versions. The VM's records carry a
// triggerPrice (where the setup actually armed) distinct from entryPrice (the
// level that was signalled); the Mac's older records have neither. Prefer the
// most specific available, and report below how much the choice moves the
// result — if it matters, the measurement is fragile.
const effEntry = (s, mode = 'best') => {
  if (mode === 'signal') return s.entryPrice;
  if (s.ltfConfirmed && s.continuationLevels?.entry != null) return s.continuationLevels.entry;
  return s.triggerPrice ?? s.entryPrice;
};

function rMultiple(s, mode = 'best') {
  if (s.outcome !== 'win' && s.outcome !== 'loss') return null;   // skips 'corrupt'
  const entry = effEntry(s, mode);
  const sl = effSL(s);
  if (entry == null || sl == null || s.exitPrice == null) return null;
  const risk = Math.abs(entry - sl);
  if (!risk) return null;
  const move = /SHORT/.test(effType(s)) ? entry - s.exitPrice : s.exitPrice - entry;
  const r = move / risk;
  if (!isFinite(r) || Math.abs(r) > 20) return null;              // wrong-symbol exit
  return r;
}

const fmtR = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`);

function stat(rows, label, mode = 'best') {
  const rs = rows.map(s => rMultiple(s, mode)).filter(r => r !== null);
  const q = rows.filter(s => s.quarantined).length;
  if (rs.length < 5) {
    console.log(`  ${label.padEnd(26)} n=${String(rs.length).padStart(4)}   (too few)`);
    return null;
  }
  const n = rs.length;
  const sum = rs.reduce((a, b) => a + b, 0);
  const w = rs.filter(r => r > 0);
  const l = rs.filter(r => r <= 0);
  const avgW = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
  const avgL = l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
  const flag = q / (q + n) >= 0.10 ? `  ⚠ ${q} quarantined` : '';
  console.log(`  ${label.padEnd(26)} n=${String(n).padStart(4)}` +
    `  win%=${(w.length / n * 100).toFixed(1).padStart(5)}` +
    `  avgW=${avgW.toFixed(2).padStart(5)}  avgL=${avgL.toFixed(2).padStart(6)}` +
    `  EXP=${fmtR(sum / n).padStart(8)}  totR=${(sum >= 0 ? '+' : '') + sum.toFixed(1)}${flag}`);
  return sum / n;
}

const closed = setups.filter(s => s.outcome === 'win' || s.outcome === 'loss');
const ts = setups.map(s => s.timestamp).filter(Boolean).sort();

console.log(`\n${'='.repeat(78)}`);
console.log(`AUDIT ANALYSIS — ${FILE.split(/[/\\]/).pop()}`);
console.log('='.repeat(78));
console.log(`setups: ${setups.length}   closed(win/loss): ${closed.length}` +
  `   quarantined: ${setups.filter(s => s.quarantined).length}`);
if (ts.length) console.log(`span: ${ts[0].slice(0, 10)} → ${ts[ts.length - 1].slice(0, 10)}`);

const byMonth = {};
for (const s of setups) if (s.timestamp) byMonth[s.timestamp.slice(0, 7)] = (byMonth[s.timestamp.slice(0, 7)] || 0) + 1;
console.log(`by month: ${JSON.stringify(byMonth)}`);
console.log(`schema: triggerPrice=${setups.filter(s => s.triggerPrice != null).length}` +
  `  continuationLevels=${setups.filter(s => s.continuationLevels).length}` +
  `  ltfConfirmed=${setups.filter(s => s.ltfConfirmed !== undefined).length}`);

// Does the entry-price choice change the answer? If these differ materially,
// the measurement depends on a modelling decision and can't be trusted alone.
console.log(`\n── ENTRY-PRICE SENSITIVITY ──`);
stat(closed, 'using triggerPrice', 'best');
stat(closed, 'using entryPrice', 'signal');

console.log(`\n── OVERALL ──`);
stat(closed, 'ALL CLOSED');

// isStrong() as shipped 2026-08-14.
const isStrong = s => (s.macroReversal ? true : s.ltfConfirmed === true);
console.log(`\n── SCANNER VERDICT (current isStrong) ──`);
stat(closed.filter(isStrong), 'TRADEABLE');
stat(closed.filter(s => !isStrong(s)), 'FILTERED OUT');

console.log(`\n── BY SOURCE ──`);
stat(closed.filter(s => s.macroReversal), 'Macro Reversal');
stat(closed.filter(s => s.pullbackAlert && s.ltfConfirmed), 'Confirmed Continuation');
stat(closed.filter(s => s.pullbackAlert && !s.ltfConfirmed), 'Pullback unconfirmed');
stat(closed.filter(s => !s.macroReversal && !s.pullbackAlert), 'HTF-Aligned');

console.log(`\n── ltfConfirmed (the gate) ──`);
stat(closed.filter(s => s.ltfConfirmed === true), 'ltfConfirmed = true');
stat(closed.filter(s => s.ltfConfirmed === false), 'ltfConfirmed = false');

console.log(`\n── macroConfidence (does it rank?) ──`);
for (const c of ['high', 'moderate', 'low']) {
  stat(closed.filter(s => s.macroReversal && s.macroConfidence === c), `macroConf = ${c}`);
}

console.log(`\n── BY STRENGTH ──`);
for (let i = 1; i <= 5; i++) stat(closed.filter(s => s.strength === i), `strength ${i}*`);

console.log(`\n── BY MONTH (regime check) ──`);
for (const m of Object.keys(byMonth).sort()) {
  stat(closed.filter(s => s.timestamp?.startsWith(m)), m);
}

// Setups that never reached a verdict. A review pass that cannot settle the
// chart skips the setup entirely (scanner.mjs ~2998), so it sits pending until
// the 72-market-hour expiry and lands here. A rising expiry share therefore
// measures how blind the review has gone — and those setups are missing from
// every expectancy number above, not counted as losses.
// The LuxAlgo studies are the only reason the system needs TradingView at all:
// they cannot be computed from candles, so they force the whole CDP scrape.
// ltfEvent (BOS / CHoCH+) comes from Price Action Concepts; csVerdict comes
// from the currency-strength read. If these do not rank outcomes, the
// architecture they require is not being paid for.
console.log(`\n── LUXALGO-DERIVED SIGNALS (do they justify the TV dependency?) ──`);
const evs = [...new Set(setups.map(s => s.ltfEvent).filter(Boolean))];
if (evs.length) {
  for (const e of evs) stat(closed.filter(s => s.ltfEvent === e), `ltfEvent = ${e}`);
  stat(closed.filter(s => !s.ltfEvent), 'ltfEvent = none');
} else {
  console.log('  (no ltfEvent field in this audit)');
}
const verds = [...new Set(setups.map(s => s.csVerdict).filter(Boolean))];
if (verds.length) {
  for (const v of verds) stat(closed.filter(s => s.csVerdict === v), `csVerdict = ${v}`);
} else {
  console.log('  (no csVerdict field in this audit)');
}
// csScore is ordinal (-1 .. +1); if currency strength carries information,
// expectancy should climb with it. Bucket rather than assume linearity.
const scored = closed.filter(s => typeof s.csScore === 'number');
if (scored.length >= 15) {
  stat(scored.filter(s => s.csScore <= -0.5), 'csScore <= -0.5');
  stat(scored.filter(s => s.csScore > -0.5 && s.csScore < 0.5), 'csScore ~ 0');
  stat(scored.filter(s => s.csScore >= 0.5), 'csScore >= +0.5');
}

console.log(`\n── EXPIRY RATE (review blindness) ──`);
const months = Object.keys(byMonth).sort();
for (const m of months) {
  const inM = setups.filter(s => s.timestamp?.startsWith(m));
  const exp = inM.filter(s => s.outcome === 'expired').length;
  const cl = inM.filter(s => s.outcome === 'win' || s.outcome === 'loss').length;
  const pend = inM.filter(s => s.status === 'pending').length;
  const decided = exp + cl;
  const pct = decided ? (exp / decided * 100).toFixed(0) : '—';
  console.log(`  ${m}   setups=${String(inM.length).padStart(4)}` +
    `  closed=${String(cl).padStart(4)}  expired=${String(exp).padStart(4)}` +
    `  pending=${String(pend).padStart(3)}   expired-share=${String(pct).padStart(4)}%`);
}
console.log(`  (chart-switch settle failures began 2026-07-30 and have run near 100% since;`);
console.log(`   a jump in expired-share at or after that date is the review going blind.)`);

console.log(`\n── BY TYPE ──`);
for (const t of ['REVERSAL LONG', 'REVERSAL SHORT', 'CONTINUATION LONG', 'CONTINUATION SHORT']) {
  stat(closed.filter(s => effType(s) === t), t);
}

console.log(`\n${'='.repeat(78)}\n`);
