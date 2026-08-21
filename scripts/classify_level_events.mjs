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
import { detect } from '../src/candles.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF NZDUSD EURGBP EURJPY GBPJPY EURAUD AUDJPY EURCAD CADJPY AUDNZD GBPAUD GBPCAD NZDJPY'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const TF = argOf('--tf') || 'D';
const END_AGO = parseFloat(argOf('--endYearsAgo') || '0');
const ONLY_TOUCHES = argOf('--touches') ? parseInt(argOf('--touches'), 10) : null;
const WINDOW = parseInt(argOf('--window') || '20', 10);
// How far counts as "significant", and whether it has to STICK.
const BREAK_ATR = parseFloat(argOf('--thresh') || '1.0');
const REV_ATR = BREAK_ATR;
// Persistence: bars after the threshold is reached at which price must STILL
// be beyond it. 0 = touch-and-go counts, which records a poke-and-snap-back as
// a break. Anything above 0 requires follow-through.
const PERSIST = parseInt(argOf('--persist') || '0', 10);

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

        // A level is only counted as broken/reversed if price is STILL past the
        // threshold PERSIST bars later. Without that, a poke through and an
        // immediate snap back scores as a break — which is a fakeout, not a
        // break, and is the gap between this measurement and what a trader sees.
        const holds = (j, px, below) => {
          const k = Math.min(use.length - 1, j + PERSIST);
          return below ? use[k].close <= px : use[k].close >= px;
        };
        let outcome = 'stall', bars_to = WINDOW;
        for (let j = i; j < Math.min(use.length, i + WINDOW); j++) {
          const c = use[j];
          if (fromAbove ? c.close <= throughPx : c.close >= throughPx) {
            if (holds(j, throughPx, fromAbove)) { outcome = 'break'; bars_to = j - i; break; }
            continue;
          }
          if (fromAbove ? c.close >= backPx : c.close <= backPx) {
            if (holds(j, backPx, !fromAbove)) { outcome = 'reverse'; bars_to = j - i; break; }
          }
        }

        // ROOM TO RUN. A 3 ATR move is impossible if another level sits 1 ATR
        // beyond — price runs into it and stalls. This is the same obstacle
        // effect discover_features found on generic entries, applied where it
        // should matter most: whether a BIG move is even available.
        const beyond = zones
          .filter(w => w.confirmedAt <= i && Math.abs(w.price - z.price) > av * 0.5)
          .filter(w => fromAbove ? w.price < z.price : w.price > z.price)
          .sort((x, y) => Math.abs(x.price - z.price) - Math.abs(y.price - z.price))[0];
        const room = beyond ? Math.abs(beyond.price - z.price) / av : 99;

        // COMPRESSION. Coiling before a level is the classic precursor to an
        // expansion move; measure it as recent range against typical range.
        let hi = -Infinity, lo = Infinity;
        for (let k = Math.max(0, i - 10); k <= i; k++) { hi = Math.max(hi, use[k].high); lo = Math.min(lo, use[k].low); }
        const compression = (hi - lo) / av;

        // How long price has been loitering at this level.
        let near = 0;
        for (let k = Math.max(0, i - 10); k <= i; k++) {
          if (use[k].low <= z.high && use[k].high >= z.low) near++;
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
          pat: detect(use, i, av), fromAbove,
          vol: av / atrAvg[i],
          room, compression, near,
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
console.log(`window ${WINDOW} bars, threshold ${BREAK_ATR} ATR, must still hold ${PERSIST} bars later`);
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
// Do candlestick patterns at a level predict what happens next? Judged in the
// direction the pattern is supposed to mean: a hammer is a bullish rejection,
// so at a level price fell into, it should predict REVERSE.
console.log('CANDLESTICK PATTERNS AT THE LEVEL');
{
  const names = Object.keys(ev[0]?.pat || {});
  for (const n of names) {
    const rs = ev.filter(e => e.pat[n]);
    if (rs.length < 150) { console.log(`  ${n.padEnd(14)} n=${String(rs.length).padStart(5)}  (too few)`); continue; }
    const [x, y, z] = share(rs);
    console.log(`  ${n.padEnd(14)} n=${String(rs.length).padStart(5)}` +
      `  break ${x.toFixed(1)}%${((x - bB) >= 0 ? '+' : '') + (x - bB).toFixed(1)}` +
      `  rev ${y.toFixed(1)}%${((y - bR) >= 0 ? '+' : '') + (y - bR).toFixed(1)}` +
      `  stall ${z.toFixed(1)}%`);
  }
  // The directional read: does a bullish pattern on a fall into the level
  // predict the turn, and a bearish one on a rise into it?
  console.log('\n  INDIVIDUAL reversal patterns, direction-matched:');
  for (const [nm, bk, bs] of [['hammer', 'hammer', 'shootingStar'], ['engulfing', 'bullEngulf', 'bearEngulf'],
                              ['star', 'morningStar', 'eveningStar'], ['doji', 'doji', 'doji']]) {
    const rs = ev.filter(e => e.fromAbove ? e.pat[bk] : e.pat[bs]);
    if (rs.length < 150) { console.log(`    ${nm.padEnd(10)} n=${rs.length} (too few)`); continue; }
    const [, y] = share(rs);
    console.log(`    ${nm.padEnd(10)} n=${String(rs.length).padStart(5)}  reverse ${y.toFixed(1)}%  (base ${bR.toFixed(1)}%)`);
  }
  const bullish = ev.filter(e => e.fromAbove && (e.pat.hammer || e.pat.bullEngulf || e.pat.morningStar));
  const bearish = ev.filter(e => !e.fromAbove && (e.pat.shootingStar || e.pat.bearEngulf || e.pat.eveningStar));
  console.log('');
  // CONTROL. Conditioning on arrival direction may be doing the work on its
  // own — a fall into a level then reversing is just a bounce, pattern or not.
  // Without this comparison the pattern gets credit for the conditioning.
  const fellIn = ev.filter(e => e.fromAbove);
  const roseIn = ev.filter(e => !e.fromAbove);
  const noPatFell = fellIn.filter(e => !(e.pat.hammer || e.pat.bullEngulf || e.pat.morningStar));
  const noPatRose = roseIn.filter(e => !(e.pat.shootingStar || e.pat.bearEngulf || e.pat.eveningStar));
  for (const [lbl, rs] of [
    ['CONTROL: any fall in', fellIn],
    ['  fall in, NO pattern', noPatFell],
    ['  fall in, WITH pattern', bullish],
    ['CONTROL: any rise in', roseIn],
    ['  rise in, NO pattern', noPatRose],
    ['  rise in, WITH pattern', bearish],
  ]) {
    if (rs.length < 100) { console.log(`  ${lbl}: n=${rs.length} (too few)`); continue; }
    const [x, y, z] = share(rs);
    console.log(`  ${lbl.padEnd(30)} n=${String(rs.length).padStart(5)}  REVERSE ${y.toFixed(1)}%${((y - bR) >= 0 ? '+' : '') + (y - bR).toFixed(1)}   break ${x.toFixed(1)}%   stall ${z.toFixed(1)}%`);
  }
}
console.log('');

report('LEVEL AGE (bars)', band(e => e.age, [0, 30, 80, 200, 1e9]));
report('ROOM TO RUN (ATR to next level beyond)', band(e => e.room, [0, 1, 2, 4, 8, 1e9]));
report('COMPRESSION (10-bar range / ATR)', band(e => e.compression, [0, 2, 3, 4.5, 99]));
report('BARS LOITERING AT LEVEL (of last 10)', band(e => e.near, [0, 2, 4, 11]));

// The three features that survived out-of-sample, combined. They describe
// different things — how many times the level has been tested, how hard price
// arrived, and where the touch bar closed — so they may not be redundant.
const fast = e => e.speed >= 1.5;
const slow = e => e.speed < 0.5;
const early = e => e.touchNo <= 2;
const late = e => e.touchNo >= 4;
// What the user actually wants: predict the BIG move, early. Room to run is
// the gating condition — price cannot travel 3 ATR if a level sits 1 ATR
// beyond. Test number and approach speed then say whether it will try.
report('BIG BREAK — stacking room, freshness, speed', [
  ['all touches', ev],
  ['room 8+ ATR', ev.filter(e => e.room >= 8)],
  ['+ 1st/2nd test', ev.filter(e => e.room >= 8 && e.touchNo <= 2)],
  ['+ fast approach', ev.filter(e => e.room >= 8 && e.touchNo <= 2 && e.speed >= 1.5)],
  ['+ closed through', ev.filter(e => e.room >= 8 && e.touchNo <= 2 && e.speed >= 1.5 && !e.closedOut)],
]);
report('BIG REVERSE — no room to go anywhere', [
  ['all touches', ev],
  ['room < 2 ATR', ev.filter(e => e.room < 2)],
  ['+ 4th+ test', ev.filter(e => e.room < 2 && e.touchNo >= 4)],
  ['+ slow approach', ev.filter(e => e.room < 2 && e.touchNo >= 4 && e.speed < 0.5)],
  ['+ closed back out', ev.filter(e => e.room < 2 && e.touchNo >= 4 && e.speed < 0.5 && e.closedOut)],
]);

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
