#!/usr/bin/env node
/**
 * Pull economic calendar history into calendar_history/ so news becomes
 * testable. Chunks are cached on disk, so re-running only fetches what is
 * missing and the job is safe to interrupt.
 *
 * Usage: node scripts/backfill_calendar.mjs [yearsBack]
 */
import { backfill, loadArchive, surprise } from '../src/calendar.js';

const years = parseFloat(process.argv[2] || '9');
const to = new Date();
const from = new Date(to.getTime() - years * 365 * 24 * 3600e3);

console.log(`Backfilling ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
const t0 = Date.now();
await backfill(from.toISOString(), to.toISOString(), { minImportance: 0 });
const all = loadArchive();
const hi = all.filter(e => e.impact === 'High');
const withActual = all.filter(e => e.actual != null);
const withSurprise = all.filter(e => surprise(e) != null);

console.log(`\n  ${all.length} events archived in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  ${hi.length} high impact   ${withActual.length} with an actual   ${withSurprise.length} scoreable`);
console.log(`  range ${all[0]?.date.slice(0, 10)} → ${all[all.length - 1]?.date.slice(0, 10)}`);
const byCcy = {};
for (const e of hi) byCcy[e.country] = (byCcy[e.country] || 0) + 1;
console.log(`  high impact by currency: ${Object.entries(byCcy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ')}`);
