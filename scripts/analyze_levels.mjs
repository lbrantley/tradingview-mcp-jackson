#!/usr/bin/env node
/**
 * Do levels get weaker with age, and does touch count predict anything?
 *
 * Both are assumptions the strategy currently bakes in — it prefers zones with
 * more touches and treats a two-year-old level the same as a two-week-old one.
 * Neither has been checked.
 *
 * Method: build zones, then every time price later re-enters one, classify
 * what happened next.
 *   HELD  — price moved `holdATR` away in the direction the zone implies,
 *           before closing `breakATR` through it
 *   BROKE — the reverse
 * Anything unresolved inside the window is discarded rather than guessed.
 *
 * Usage: node scripts/analyze_levels.mjs [--pairs A,B] [--tf H4] [--years 2]
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
import { buildZones } from '../src/structure.js';
import { atr } from '../src/indicators.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF NZDUSD EURGBP EURJPY GBPJPY EURAUD AUDJPY EURCAD CADJPY AUDNZD'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'H4';
const YEARS = parseFloat(argOf('--years') || '2');
const HOLD_ATR = 1.0, BREAK_ATR = 0.5, WINDOW = 40;

const rows = [];

for (const sym of PAIRS) {
  try {
    const to = new Date(), from = new Date(Date.now() - YEARS * 365 * 24 * 3600e3);
    const bars = TF === 'H1'
      ? await getCandlesRange(sym, { granularity: TF, from: from.toISOString(), to: to.toISOString() })
      : await getCandles(sym, { granularity: TF, count: 5000 });
    if (bars.length < 300) continue;
    const a = atr(bars, 14);
    const zones = buildZones(bars, { lookback: 5, tolATR: 0.5, minTouches: 2 });

    for (const z of zones) {
      const isSup = z.kind === 'support';
      let lastTouch = z.confirmedAt;
      for (let i = z.confirmedAt + 1; i < bars.length - WINDOW; i++) {
        const b = bars[i];
        const inZone = b.low <= z.high && b.high >= z.low;
        if (!inZone) continue;
        if (i - lastTouch < 5) continue;              // one event per approach
        const av = a[i]; if (!av) continue;
        const holdPx = isSup ? z.high + HOLD_ATR * av : z.low - HOLD_ATR * av;
        const breakPx = isSup ? z.low - BREAK_ATR * av : z.high + BREAK_ATR * av;

        let verdict = null;
        for (let j = i; j < Math.min(bars.length, i + WINDOW); j++) {
          const c = bars[j];
          if (isSup ? c.close < breakPx : c.close > breakPx) { verdict = 'broke'; break; }
          if (isSup ? c.high >= holdPx : c.low <= holdPx) { verdict = 'held'; break; }
        }
        if (verdict) {
          rows.push({
            sym, verdict,
            ageBars: i - z.firstAt,          // how old the level is at this touch
            sinceLast: i - lastTouch,        // how long since it was last tested
            touches: z.touches,
          });
        }
        lastTouch = i;
      }
    }
  } catch (e) { console.error(`  ${sym}: ${e.message.slice(0, 50)}`); }
}

const pct = rs => (rs.filter(r => r.verdict === 'held').length / rs.length * 100);
function bucket(label, rs) {
  if (rs.length < 25) { console.log(`  ${label.padEnd(22)} n=${rs.length} (too few)`); return; }
  console.log(`  ${label.padEnd(22)} n=${String(rs.length).padStart(5)}   held ${pct(rs).toFixed(1)}%`);
}

console.log(`\nLEVEL STRENGTH — ${TF}, ${PAIRS.length} pairs, ${YEARS}y, n=${rows.length} touch events`);
console.log(`held = price moved ${HOLD_ATR} ATR away before closing ${BREAK_ATR} ATR through\n`);
console.log(`  OVERALL              n=${String(rows.length).padStart(5)}   held ${pct(rows).toFixed(1)}%\n`);

console.log('BY AGE OF LEVEL (bars since it first formed)');
const ages = [[0, 50], [50, 150], [150, 400], [400, 1000], [1000, 1e9]];
for (const [lo, hi] of ages) bucket(`${lo}-${hi === 1e9 ? '∞' : hi} bars`, rows.filter(r => r.ageBars >= lo && r.ageBars < hi));

console.log('\nBY TIME SINCE LAST TESTED');
const rec = [[0, 20], [20, 60], [60, 150], [150, 1e9]];
for (const [lo, hi] of rec) bucket(`${lo}-${hi === 1e9 ? '∞' : hi} bars`, rows.filter(r => r.sinceLast >= lo && r.sinceLast < hi));

console.log('\nBY TOUCH COUNT (does "multi-touch" mean stronger?)');
for (const t of [2, 3, 4, 5]) bucket(`${t}${t === 5 ? '+' : ''} touches`, rows.filter(r => t === 5 ? r.touches >= 5 : r.touches === t));
