#!/usr/bin/env node
/**
 * Outcome-first discovery — the user's own method, made safe.
 *
 * Instead of proposing a strategy and testing it, label every bar by what
 * WOULD have happened (enter here, 1 ATR stop, 3R target), then ask which
 * conditions were present when it worked. Hypothesis-first has returned null
 * on three strategies; this asks the data what it contains rather than
 * checking what we guessed.
 *
 * The danger is finding structure in noise, so nothing here is a conclusion.
 * Any feature that stands out must then survive --endYearsAgo on a window it
 * was not discovered on. Discovery and validation are separate steps.
 *
 * Base rate matters: with a 1 ATR stop and a 3R target, a driftless walk wins
 * about 25% of the time. Only lift ABOVE the observed base rate is signal.
 *
 * Usage: node scripts/discover_features.mjs [--pairs A,B] [--years 2]
 *                                           [--endYearsAgo 0] [--tf H4] [--rr 3]
 */
import { getCandles, getCandlesRange } from '../src/oanda.js';
import { rsi, atr, sma, macd, bollinger, stochastic, rvi } from '../src/indicators.js';
import { buildZones } from '../src/structure.js';

const args = process.argv.slice(2);
const argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const ALL = 'EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF NZDUSD EURGBP EURJPY GBPJPY EURAUD AUDJPY EURCAD CADJPY AUDNZD GBPAUD'.split(' ');
const PAIRS = (argOf('--pairs') || ALL.join(',')).split(',').map(s => s.trim());
const YEARS = parseFloat(argOf('--years') || '2');
const END_AGO = parseFloat(argOf('--endYearsAgo') || '0');
const TF = argOf('--tf') || 'H4';
const RR = parseFloat(argOf('--rr') || '3');
const HORIZON = 60;          // bars allowed to resolve
const STOP_ATR = 1.0;

const rows = [];

for (const sym of PAIRS) {
  try {
    const to = new Date(Date.now() - END_AGO * 365 * 24 * 3600e3);
    const from = new Date(to.getTime() - YEARS * 365 * 24 * 3600e3);
    const bars = await getCandlesRange(sym, { granularity: TF, from: from.toISOString(), to: to.toISOString() });
    if (bars.length < 400) continue;

    const closes = bars.map(b => b.close);
    const a = atr(bars, 14);
    const r = rsi(closes, 14);
    const s50 = sma(closes, 50), s200 = sma(closes, 200);
    const md = macd(closes), bb = bollinger(closes), st = stochastic(bars), rv = rvi(bars);
    const atrAvg = sma(a.map(v => v ?? 0), 50);
    const zones = buildZones(bars, { lookback: 5, tolATR: 0.5, minTouches: 2 });

    for (let i = 220; i < bars.length - HORIZON; i++) {
      if (a[i] == null || s200[i] == null || md.hist[i] == null || bb.pctB[i] == null
        || st.k[i] == null || rv.rvi[i] == null || atrAvg[i] == null) continue;

      const entry = bars[i + 1].open;
      const risk = a[i] * STOP_ATR;
      if (!risk) continue;

      for (const dir of ['long', 'short']) {
        const L = dir === 'long';
        const stop = L ? entry - risk : entry + risk;
        const tgt = L ? entry + RR * risk : entry - RR * risk;
        let outcome = null;
        for (let j = i + 1; j < i + 1 + HORIZON && j < bars.length; j++) {
          const b = bars[j];
          if (L ? b.low <= stop : b.high >= stop) { outcome = 0; break; }   // stop first
          if (L ? b.high >= tgt : b.low <= tgt) { outcome = 1; break; }
        }
        if (outcome === null) continue;

        // Conditions present AT the entry bar. Nothing here reads forward.
        const visible = zones.filter(z => z.confirmedAt <= i);
        const above = visible.filter(z => z.price > entry).sort((x, y) => x.price - y.price)[0];
        const below = visible.filter(z => z.price < entry).sort((x, y) => y.price - x.price)[0];
        const t = new Date(bars[i].time);

        rows.push({
          sym, dir, win: outcome,
          rsi: r[i],
          bpct: bb.pctB[i],
          stoch: st.k[i],
          macdUp: md.hist[i] > (md.hist[i - 1] ?? 0) ? 1 : 0,
          macdPos: md.hist[i] > 0 ? 1 : 0,
          rviUp: rv.rvi[i] > (rv.signal[i] ?? 0) ? 1 : 0,
          vsSma50: (entry - s50[i]) / a[i],
          vsSma200: (entry - s200[i]) / a[i],
          volRegime: a[i] / atrAvg[i],
          mom20: (entry - closes[i - 20]) / a[i],
          distAbove: above ? (above.price - entry) / a[i] : null,
          distBelow: below ? (entry - below.price) / a[i] : null,
          hour: t.getUTCHours(),
          dow: t.getUTCDay(),
        });
      }
    }
  } catch (e) { console.error(`  ${sym}: ${e.message.slice(0, 50)}`); }
}

const base = rows.reduce((a, x) => a + x.win, 0) / rows.length * 100;
console.log(`\nOUTCOME-FIRST FEATURE SCAN — ${TF}, ${PAIRS.length} pairs, ${YEARS}y ending ${END_AGO}y ago`);
console.log(`entry = next open, stop = ${STOP_ATR} ATR, target = ${RR}R, ${HORIZON} bars to resolve`);
console.log(`n=${rows.length} resolved  |  BASE RATE ${base.toFixed(2)}%  <- only lift above this is signal\n`);

/** Report a feature bucketed, with lift over base and a rough significance. */
function report(name, buckets) {
  console.log(`${name}`);
  for (const [label, subset] of buckets) {
    if (subset.length < 200) { console.log(`  ${label.padEnd(20)} n=${String(subset.length).padStart(6)}  (too few)`); continue; }
    const wr = subset.reduce((a, x) => a + x.win, 0) / subset.length * 100;
    const lift = wr - base;
    // SD of the bucket's win count under the base rate.
    const sd = Math.sqrt(subset.length * (base / 100) * (1 - base / 100));
    const z = (subset.reduce((a, x) => a + x.win, 0) - subset.length * base / 100) / sd;
    const flag = Math.abs(z) >= 4 ? (z > 0 ? '  <<< ' + z.toFixed(1) + 'z' : '  >>> ' + z.toFixed(1) + 'z') : '';
    console.log(`  ${label.padEnd(20)} n=${String(subset.length).padStart(6)}  win ${wr.toFixed(2)}%  lift ${(lift >= 0 ? '+' : '') + lift.toFixed(2)}${flag}`);
  }
  console.log('');
}

const band = (f, edges) => edges.slice(0, -1).map((lo, k) => {
  const hi = edges[k + 1];
  return [`${lo} to ${hi}`, rows.filter(x => f(x) != null && f(x) >= lo && f(x) < hi)];
});

report('RSI(14)', band(x => x.rsi, [0, 30, 40, 50, 60, 70, 101]));
report('Bollinger %B', band(x => x.bpct, [-2, 0, 0.25, 0.5, 0.75, 1, 3]));
report('Stochastic %K', band(x => x.stoch, [0, 20, 40, 60, 80, 101]));
report('Distance from SMA50 (ATR)', band(x => x.vsSma50, [-99, -3, -1, 0, 1, 3, 99]));
report('Distance from SMA200 (ATR)', band(x => x.vsSma200, [-99, -5, -2, 0, 2, 5, 99]));
report('Volatility regime (ATR/avg)', band(x => x.volRegime, [0, 0.7, 0.9, 1.1, 1.4, 99]));
report('20-bar momentum (ATR)', band(x => x.mom20, [-99, -4, -1.5, 0, 1.5, 4, 99]));
report('Distance to zone ahead (ATR)', band(x => x.dir === 'long' ? x.distAbove : x.distBelow, [0, 1, 2, 4, 8, 99]));
report('Hour of day (UTC)', [['00-06 Asia', rows.filter(x => x.hour < 6)], ['06-12 London', rows.filter(x => x.hour >= 6 && x.hour < 12)],
  ['12-16 overlap', rows.filter(x => x.hour >= 12 && x.hour < 16)], ['16-21 NY', rows.filter(x => x.hour >= 16 && x.hour < 21)],
  ['21-24 late', rows.filter(x => x.hour >= 21)]]);
report('Day of week (UTC)', [1, 2, 3, 4, 5].map(d => [['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][d], rows.filter(x => x.dow === d)]));
report('MACD histogram', [['positive', rows.filter(x => x.macdPos)], ['negative', rows.filter(x => !x.macdPos)],
  ['rising', rows.filter(x => x.macdUp)], ['falling', rows.filter(x => !x.macdUp)]]);
report('Direction', [['long', rows.filter(x => x.dir === 'long')], ['short', rows.filter(x => x.dir === 'short')]]);
