#!/usr/bin/env node
/**
 * What does price DO at a level — break, reverse, or stall? And does the way
 * it arrives tell you which?
 *
 * The user's framing: stop predicting reversals and let the level be the
 * signal. Three outcomes are possible, so classify all three and look for what
 * separates them. Outcome-first again, but multi-class.
 *
 * Classification at each touch, relative to the direction price ARRIVED from:
 *   BREAK    closes through by >= breakATR and is still through after settle
 *   REVERSE  travels >= revATR back the way it came
 *   STALL    neither, within the window — price lingers
 *
 * "Reverse" is judged against the approach direction, not against the zone
 * label: price falling into support and bouncing is a reverse; price rising
 * into support from below and turning down is also a reverse.
 *
 * Usage: node scripts/classify_level_events.mjs [--tf D] [--years 4]
 *                                               [--endYearsAgo 0] [--touches 2]
 */
import { getCandles } from '../src/oanda.js';
import { atr, sma } from '../src/indicators.js';
import { buildZones } from '../src/structure.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF NZDUSD EURGBP EURJPY GBPJPY EURAUD AUDJPY EURCAD CADJPY AUDNZD GBPAUD GBPCAD NZDJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'D';
const END_AGO = parseFloat(argOf('--endYearsAgo') || '0');
const ONLY_TOUCHES = argOf('--touches') ? parseInt(argOf('--touches'), 10) : null;
const WINDOW = 20, BREAK_ATR = 1.0, REV_ATR = 1.0;

const ev = [];

for (const sym of PAIRS) {
  try {
    const bars = await getCandles(sym, { granularity: TF, count: 5000 });
    if (bars.length < 300) continue;
    const cut = END_AGO ? bars.length - Math.round(END_AGO * (TF === 'W' ? 52 : 260)) : bars.length;
    const use = bars.slice(0, Math.max(300, cut));
    const a = atr(use, 14);
    const closes = use.map(b => b.close);
    const atrAvg = sma(a.map(v => v ?? 0), 50);
    const zones = buildZones(use, { lookback: 5, tolATR: 0.5, minTouches: 2 });

    for (const z of zones) {
      if (ONLY_TOUCHES && z.touches !== ONLY_TOUCHES) continue;
      let seen = 0, lastIdx = z.confirmedAt;
      for (let i = z.confirmedAt + 1; i < use.length - WINDOW; i++) {
        const b = use[i];
        if (!(b.low <= z.high && b.high >= z.low)) continue;
        if (i - lastIdx < 3) continue;
        const av = a[i]; if (!av || !atrAvg[i]) continue;
        seen++;

        // Which way did price arrive? Compare to where it was before the run in.
        const ref = closes[Math.max(0, i - 5)];
        const fromAbove = ref > z.price;
        // Through = continuing past the level in the arrival direction.
        const throughPx = fromAbove ? z.low - BREAK_ATR * av : z.high + BREAK_ATR * av;
        const backPx = fromAbove ? z.high + REV_ATR * av : z.low - REV_ATR * av;

        let outcome = 'stall', bars_to = WINDOW;
        for (let j = i; j < Math.min(use.length, i + WINDOW); j++) {
          const c = use[j];
          if (fromAbove ? c.close <= throughPx : c.close >= throughPx) { outcome = 'break'; bars_to = j - i; break; }
          if (fromAbove ? c.close >= backPx : c.close <= backPx) { outcome = 'reverse'; bars_to = j - i; break; }
        }

        // How it arrived, measured only from bars at or before the touch.
        const speed = Math.abs(closes[i] - closes[Math.max(0, i - 5)]) / av;   // ATRs travelled in 5 bars
        const run = Math.abs(closes[i] - closes[Math.max(0, i - 20)]) / av;    // over 20
        const body = Math.abs(b.close - b.open), range = b.high - b.low || 1e-9;
        const wickFrac = 1 - body / range;
        // Did the touch bar close back out of the zone?
        const closedOut = fromAbove ? b.close > z.high : b.close < z.low;

        ev.push({
          sym, outcome, bars_to,
          touchNo: seen, zoneTouches: z.touches,
          age: i - z.firstAt,
          firstTest: seen === 1 ? 1 : 0,
          speed, run, wickFrac, closedOut: closedOut ? 1 : 0,
          vol: av / atrAvg[i],
        });
        lastIdx = i;
      }
    }
  } catch (e) { console.error(`  ${sym}: ${e.message.slice(0, 45)}`); }
}

const N = ev.length;
const share = rs => ['break', 'reverse', 'stall'].map(o =>
  (rs.filter(x => x.outcome === o).length / rs.length * 100));
const [bB, bR, bS] = share(ev);

console.log(`\nWHAT PRICE DOES AT A LEVEL — ${TF}, ${PAIRS.length} pairs${ONLY_TOUCHES ? `, ${ONLY_TOUCHES}-touch zones only` : ''}`);
console.log(`window ${WINDOW} bars, break/reverse threshold ${BREAK_ATR} ATR, judged vs ARRIVAL direction`);
console.log(`n=${N}\n`);
console.log(`  BASE          break ${bB.toFixed(1)}%   reverse ${bR.toFixed(1)}%   stall ${bS.toFixed(1)}%\n`);

function report(title, buckets) {
  console.log(title);
  for (const [label, rs] of buckets) {
    if (rs.length < 120) { console.log(`  ${label.padEnd(22)} n=${String(rs.length).padStart(5)}  (too few)`); continue; }
    const [x, y, z] = share(rs);
    const mark = (v, base) => {
      const d = v - base;
      return `${v.toFixed(1)}%${(d >= 0 ? '+' : '') + d.toFixed(1)}`.padStart(13);
    };
    console.log(`  ${label.padEnd(22)} n=${String(rs.length).padStart(5)}  break${mark(x, bB)}  rev${mark(y, bR)}  stall${mark(z, bS)}`);
  }
  console.log('');
}
const band = (f, edges) => edges.slice(0, -1).map((lo, k) =>
  [`${lo} to ${edges[k + 1]}`, ev.filter(e => f(e) >= lo && f(e) < edges[k + 1])]);

report('WHICH TEST IS THIS?', [1, 2, 3, 4].map(n =>
  [n === 4 ? '4th+ test' : `${n}${['st', 'nd', 'rd'][n - 1]} test`, ev.filter(e => n === 4 ? e.touchNo >= 4 : e.touchNo === n)]));
report('APPROACH SPEED (ATR over 5 bars)', band(e => e.speed, [0, 0.5, 1, 1.5, 2.5, 99]));
report('RUN INTO IT (ATR over 20 bars)', band(e => e.run, [0, 1, 2, 4, 99]));
report('TOUCH BAR: closed back out?', [['closed back out', ev.filter(e => e.closedOut)], ['closed inside/through', ev.filter(e => !e.closedOut)]]);
report('TOUCH BAR WICK FRACTION', band(e => e.wickFrac, [0, 0.4, 0.6, 0.8, 1.01]));
report('VOLATILITY REGIME', band(e => e.vol, [0, 0.8, 1.0, 1.3, 99]));
report('LEVEL AGE (bars)', band(e => e.age, [0, 30, 80, 200, 1e9]));

// The three features that survived out-of-sample, combined. They describe
// different things — how many times the level has been tested, how hard price
// arrived, and where the touch bar closed — so they may not be redundant.
const fast = e => e.speed >= 1.5;
const slow = e => e.speed < 0.5;
const early = e => e.touchNo <= 2;
const late = e => e.touchNo >= 4;
report('COMBINED — leaning BREAK', [
  ['closed through', ev.filter(e => !e.closedOut)],
  ['+ fast approach', ev.filter(e => !e.closedOut && fast(e))],
  ['+ 1st/2nd test', ev.filter(e => !e.closedOut && fast(e) && early(e))],
]);
report('COMBINED — leaning REVERSE', [
  ['closed back out', ev.filter(e => e.closedOut)],
  ['+ slow approach', ev.filter(e => e.closedOut && slow(e))],
  ['+ 4th+ test', ev.filter(e => e.closedOut && slow(e) && late(e))],
]);
