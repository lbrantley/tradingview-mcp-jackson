#!/usr/bin/env node
/**
 * Which subset of the level-rejection signals carries the edge?
 *
 * The entry fires ~3,500 times per two-year window across 28 pairs and lands on
 * breakeven — it beats a random walk on win rate by roughly the spread. That is
 * the profile of a real signal diluted by taking every instance of it.
 *
 * Reports every feature across ALL THREE windows side by side. A filter is only
 * interesting if it helps in all three; anything that works in one is the noise
 * that killed four earlier findings here.
 *
 * Usage: node scripts/find_filters.mjs <trades_0.json> <trades_2.json> <trades_4.json>
 */
import { readFileSync } from 'fs';

const files = process.argv.slice(2);
if (files.length < 2) { console.error('need at least two window files'); process.exit(1); }
const W = files.map(f => JSON.parse(readFileSync(f, 'utf8')));
const labels = ['recent', 'mid', 'old'].slice(0, W.length);

const exp = rs => rs.length ? rs.reduce((a, b) => a + b.r, 0) / rs.length : null;
const base = W.map(w => exp(w));

console.log(`\nFILTER SCAN — ${W.map((w, i) => `${labels[i]} n=${w.length}`).join(', ')}`);
console.log(`baseline expectancy: ${base.map(b => (b >= 0 ? '+' : '') + b.toFixed(3) + 'R').join('   ')}\n`);
console.log('  ' + 'filter'.padEnd(30) + labels.map(l => (l + ' (n)').padStart(18)).join(''));
console.log('  ' + '-'.repeat(30 + 18 * W.length));

function row(label, pred) {
  const cells = W.map((w, i) => {
    const sub = w.filter(pred);
    if (sub.length < 100) return '(too few)'.padStart(18);
    const e = exp(sub);
    const lift = e - base[i];
    return `${(e >= 0 ? '+' : '') + e.toFixed(3)}R ${(lift >= 0 ? '+' : '') + lift.toFixed(3)} (${sub.length})`.padStart(18);
  });
  // Flag only what helps in EVERY window — the standard four earlier findings failed.
  const allUp = W.every((w, i) => {
    const sub = w.filter(pred);
    return sub.length >= 100 && exp(sub) > base[i] + 0.02;
  });
  console.log('  ' + label.padEnd(30) + cells.join('') + (allUp ? '  <<<' : ''));
}

const has = (x, k) => x[k] !== null && x[k] !== undefined;

console.log('DIRECTION');
row('long', x => x.dir === 'long');
row('short', x => x.dir === 'short');

console.log('\nSETUP QUALITY');
for (const d of [2, 3, 5]) row(`held >= ${d} days`, x => x.holdDays >= d);
for (const t of [3, 4, 5]) row(`level touched >= ${t}x`, x => x.touches >= t);
for (const r of [2, 2.5, 3]) row(`rr >= ${r}`, x => x.rr >= r);

console.log('\nDAILY CONTEXT');
row('with daily trend (sma50)', x => has(x, 'dTrend') && ((x.dir === 'long') === (x.dTrend === 1)));
row('against daily trend', x => has(x, 'dTrend') && ((x.dir === 'long') !== (x.dTrend === 1)));
row('daily RSI < 40 (longs)', x => x.dir === 'long' && has(x, 'dRsi') && x.dRsi < 40);
row('daily RSI > 60 (shorts)', x => x.dir === 'short' && has(x, 'dRsi') && x.dRsi > 60);

console.log('\nYOUR INDICATORS AT ENTRY');
row('MACD hist agrees', x => has(x, 'macdHist') && ((x.dir === 'long') === (x.macdHist > 0)));
row('MACD hist disagrees', x => has(x, 'macdHist') && ((x.dir === 'long') !== (x.macdHist > 0)));
row('RVI agrees', x => has(x, 'rviAbove') && ((x.dir === 'long') === (x.rviAbove === 1)));
row('Stoch < 30 (longs)', x => x.dir === 'long' && has(x, 'stoch') && x.stoch < 30);
row('Stoch > 70 (shorts)', x => x.dir === 'short' && has(x, 'stoch') && x.stoch > 70);
row('Stoch extreme, matched', x => has(x, 'stoch') && (x.dir === 'long' ? x.stoch < 30 : x.stoch > 70));
row('RSI < 35 (longs)', x => x.dir === 'long' && has(x, 'rsi') && x.rsi < 35);
row('RSI > 65 (shorts)', x => x.dir === 'short' && has(x, 'rsi') && x.rsi > 65);
row('BB outside band, matched', x => has(x, 'bbPct') && (x.dir === 'long' ? x.bbPct < 0.1 : x.bbPct > 0.9));
row('above/below 50 SMA w/ dir', x => has(x, 'vsSma50') && ((x.dir === 'long') === (x.vsSma50 > 0)));
row('200 SMA agrees', x => has(x, 'vsSma200') && ((x.dir === 'long') === (x.vsSma200 > 0)));

console.log('\nSESSION');
row('London 06-12 UTC', x => x.hour >= 6 && x.hour < 12);
row('NY 12-21 UTC', x => x.hour >= 12 && x.hour < 21);
row('Asia 21-06 UTC', x => x.hour >= 21 || x.hour < 6);

console.log('\n  <<< = beats baseline by >0.02R in EVERY window\n');
