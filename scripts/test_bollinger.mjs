#!/usr/bin/env node
/**
 * Three separate Bollinger claims, tested separately because they are
 * different mechanisms and could easily disagree.
 *
 *  1. SQUEEZE   narrow bands precede a meaningful move. Note this predicts
 *               MAGNITUDE, not direction — a squeeze says "something is
 *               coming", not "it is going up". Tested both ways: does the move
 *               get bigger, and does its direction persist once it starts?
 *
 *  2. BAND->BAND  touching one band and travelling to the opposite one, as an
 *               actual trade with a stop, not just as an observation.
 *
 *  3. Comparison against the same period's baseline, so "big move followed" is
 *     measured against what normally follows rather than against nothing.
 *
 * Usage: node scripts/test_bollinger.mjs [--tf H4] [--years 2] [--endYearsAgo 0]
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
import { atr, sma, bollinger } from '../src/indicators.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'GBPCHF AUDNZD EURNZD GBPNZD EURCHF CADCHF EURAUD GBPJPY AUDCHF GBPUSD GBPCAD USDCHF GBPAUD CADJPY EURCAD USDCAD AUDUSD NZDCHF USDJPY AUDJPY EURJPY NZDCAD EURUSD AUDCAD EURGBP NZDJPY NZDUSD CHFJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'H4';
const YEARS = parseFloat(argOf('--years') || '2');
const END = parseFloat(argOf('--endYearsAgo') || '0');
// The user's MT4 setting is Shift: 2 — bands plotted two bars forward, so the
// band seen at bar i is computed from data through i-2. That is what they are
// actually reading off the chart, and it is also strictly lookahead-free.
const SHIFT = parseInt(argOf('--shift') || '2', 10);
const FWD = 20;          // bars to look forward
const HOLD = 40;         // bars allowed for a band-to-band trade

const sq = { sqMove: [], normMove: [], persist: 0, persistN: 0 };
const bb2bb = { win: 0, loss: 0, open: 0, r: [] };

for (const sym of PAIRS) {
  try {
    const to = new Date(Date.now() - END * 365 * 24 * 3600e3);
    const from = new Date(to.getTime() - YEARS * 365 * 24 * 3600e3);
    const bars = ['D', 'W'].includes(TF)
      ? (await getCandles(sym, { granularity: TF, count: 5000 })).filter(b => b.time <= to.toISOString() && b.time >= from.toISOString())
      : await getCandlesRange(sym, { granularity: TF, from: from.toISOString(), to: to.toISOString() });
    if (bars.length < 200) continue;
    const bd = await getCandles(sym, { granularity: 'D', count: 60, price: 'B' });
    const ad = await getCandles(sym, { granularity: 'D', count: 60, price: 'A' });
    const sps = bd.map((b, i) => ad[i] ? ad[i].close - b.close : null).filter(v => v && v > 0).sort((x, y) => x - y);
    const spread = sps[Math.floor(sps.length / 2)] || 0;
    const closes = bars.map(b => b.close);
    const a = atr(bars, 14);
    const raw = bollinger(closes, 20, 2);
    // Apply the shift: band at i comes from the calculation at i-SHIFT.
    const shift = arr => arr.map((_, i) => (i - SHIFT >= 0 ? arr[i - SHIFT] : null));
    const bb = { upper: shift(raw.upper), lower: shift(raw.lower), mid: shift(raw.mid) };
    const width = closes.map((_, i) => (bb.upper[i] == null || !a[i]) ? null : (bb.upper[i] - bb.lower[i]) / a[i]);

    // A squeeze is width in the bottom quintile of its own recent history —
    // relative to the pair, not an absolute number.
    for (let i = 120; i < bars.length - FWD; i++) {
      if (width[i] == null || !a[i]) continue;
      const hist = width.slice(i - 100, i).filter(v => v != null).sort((x, y) => x - y);
      if (hist.length < 60) continue;
      const p20 = hist[Math.floor(hist.length * 0.2)];

      const fwd = bars.slice(i + 1, i + 1 + FWD);
      const hi = Math.max(...fwd.map(b => b.high)), lo = Math.min(...fwd.map(b => b.low));
      const range = (hi - lo) / a[i];                      // move size in ATR

      if (width[i] <= p20) {
        sq.sqMove.push(range);
        // Direction persistence: once it moves 1 ATR either way, does it keep
        // going another 1 ATR before retracing that far back?
        let first = null;
        for (const b of fwd) {
          if (b.close >= bars[i].close + a[i]) { first = 'up'; break; }
          if (b.close <= bars[i].close - a[i]) { first = 'down'; break; }
        }
        if (first) {
          sq.persistN++;
          const start = fwd.findIndex(b => first === 'up' ? b.close >= bars[i].close + a[i] : b.close <= bars[i].close - a[i]);
          const after = fwd.slice(start + 1);
          const cont = after.some(b => first === 'up' ? b.close >= bars[i].close + 2 * a[i] : b.close <= bars[i].close - 2 * a[i]);
          const back = after.some(b => first === 'up' ? b.close <= bars[i].close : b.close >= bars[i].close);
          if (cont && !back) sq.persist++;
        }
      } else sq.normMove.push(range);
    }

    // Band-to-band as a trade: enter on a close outside the band, stop 1 ATR
    // beyond the entry, target the opposite band.
    for (let i = 120; i < bars.length - HOLD; i++) {
      if (bb.lower[i] == null || !a[i]) continue;
      const b = bars[i];
      const long = b.close < bb.lower[i], short = b.close > bb.upper[i];
      if (!long && !short) continue;
      const entry = bars[i + 1].open;
      const stop = long ? entry - a[i] : entry + a[i];
      const risk = a[i];
      // Spread was missing from the first run. Every other result in this repo
      // charges it, and it is the difference between a thin edge and none.
      const costR = spread / risk;
      let done = null;
      for (let j = i + 1; j < Math.min(bars.length, i + HOLD); j++) {
        const c = bars[j];
        const tgt = long ? bb.upper[j] : bb.lower[j];      // opposite band, moving
        if (long ? c.low <= stop : c.high >= stop) { done = -1 - costR; break; }
        if (tgt != null && (long ? c.high >= tgt : c.low <= tgt)) { done = Math.abs(tgt - entry) / risk - costR; break; }
      }
      if (done === null) bb2bb.open++;
      else { bb2bb.r.push(done); done > 0 ? bb2bb.win++ : bb2bb.loss++; }
    }
  } catch (e) { /* skip */ }
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.log(`\nBOLLINGER (20,2, shift ${SHIFT}) — ${TF}, ${PAIRS.length} pairs, ${YEARS}y ending ${END}y ago\n`);
console.log(`1. SQUEEZE -> bigger move? (range over next ${FWD} bars, in ATR)`);
console.log(`   after a squeeze   n=${sq.sqMove.length}   avg range ${mean(sq.sqMove).toFixed(2)} ATR`);
console.log(`   normal            n=${sq.normMove.length}   avg range ${mean(sq.normMove).toFixed(2)} ATR`);
console.log(`   difference        ${((mean(sq.sqMove) / mean(sq.normMove) - 1) * 100).toFixed(1)}%`);
console.log(`\n2. SQUEEZE -> does the direction persist once it breaks?`);
console.log(`   broke 1 ATR n=${sq.persistN}   continued to 2 ATR without retracing: ${(sq.persist / (sq.persistN || 1) * 100).toFixed(1)}%`);
console.log(`\n3. BAND -> OPPOSITE BAND as a trade (stop 1 ATR, target the far band)`);
const n = bb2bb.r.length;
if (n) {
  const tot = bb2bb.r.reduce((a, b) => a + b, 0);
  console.log(`   n=${n}   win ${(bb2bb.win / n * 100).toFixed(1)}%   avg ${(tot / n >= 0 ? '+' : '') + (tot / n).toFixed(3)}R   totalR ${(tot >= 0 ? '+' : '') + tot.toFixed(1)}   (${bb2bb.open} unresolved)`);
}
console.log('');
