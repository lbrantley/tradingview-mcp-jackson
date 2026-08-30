/**
 * THE ONE PLACE A SETUP IS DEFINED.
 *
 * Written 2026-08-30 after finding that scan_v2.mjs and approach.js were two
 * different strategies wearing the same vocabulary. The scanner checked none of
 * the open-field filters — no freshness, no approach speed, no cooldown — and
 * those filters ARE the edge there: they cut 44,904 touches to 147 trades. It
 * was emitting raw breaks, measured at -0.171R, and calling them validated.
 *
 * So both the scanner and the backtest now call this. A live scan is just the
 * setups whose bar index is the last one.
 *
 * BRANCHES, decided by clear room between the level and the next one ahead:
 *
 *   WALL   room < 2 ATR, bar CLOSED THROUGH, 2-6 levels stacked ahead
 *   FIELD  room > 8 ATR, bar CLOSED THROUGH, level is FRESH (1st/2nd test),
 *          price ARRIVED FAST (>= 1.5 ATR over 5 bars), zone has 3+ swings
 *   REV    room < 2 ATR, bar REJECTED — touched and closed back out
 *
 * A zone cannot re-fire within `cooldown` bars, so one long grind against a
 * level counts once rather than twenty times.
 *
 * The stop is anchored BEYOND the level; only its buffer is fitted. The target
 * is a measured move: the last directional DAILY swing leg, projected `fibExt`
 * beyond that leg's far end.
 */
import { atr, swings } from './indicators.js';
import { buildZones } from './structure.js';

export const DEFAULTS = {
  // SWEPT 2026-08-30, and these are the two that matter most: lookback decides
  // what a swing IS, tolATR decides which swings merge into one zone. Everything
  // downstream — room, branch, stop, target — is computed against whatever they
  // produce. Both had been sitting at buildZones' defaults, never chosen.
  //
  //   lb/tol      w0                  w2                  w4                  w6
  //   5/0.5   1.294/0.678/0.596       —                   —           0.891/0.732/0.514
  //   3/0.8   1.267/1.317/1.059  1.800/1.596/0.937  1.715/0.790/1.212  1.745/1.844/0.958
  //                                                        (WALL / FIELD / REV)
  //
  // Roughly doubles open field and reversals in every window and halves signal
  // volume. The whole 2-4 x 0.8-1.5 region beats 5/0.5, so it is a plateau
  // rather than a spike — which is what a real effect looks like rather than a
  // fitted one. Mechanism: a 3-bar lookback confirms swings sooner (the
  // confirmation lag), and a wider tolerance produces the fewer, wider bands a
  // trader actually draws instead of 24-pip hairlines.
  //
  // CAVEAT: grid-searched with all four windows used for SELECTION, so there is
  // no historical holdout left for these two values. The live period is the only
  // out-of-sample check available. If live results look nothing like the
  // backtest, suspect these first.
  lookback: 3,
  tolATR: 0.8,
  // Measured 2026-08-30. The branches had been validated against DIFFERENT zone
  // universes — open field on 3, wall and reversal on 2 — which changes the room
  // measurement and therefore every classification. Swept: 3 is better for open
  // field in all four windows (roughly double in two of them) and a wash for the
  // other two. One universe, and it is the stricter one.
  zoneMinTouches: 3,
  cooldown: 5,
  wallRoom: 2,              // ATR — under this is wall / reversal country
  fieldRoom: 8,             // ATR — over this is open field
  backupMin: 2, backupMax: 6,
  fieldMaxTest: 2,          // fresh: 1st or 2nd return to the level
  fastATR: 1.5,             // 5-bar travel that counts as arriving fast
  stopATR: { WALL: 0.5, FIELD: 1.5, REV: 2.0 },
  fibExt: 1.0,              // measured move beyond the daily leg's far end
  minLegATR: 0.5,
};

/** Last directional leg: a confirmed swing low then a LATER confirmed swing high
 *  for dir > 0, mirrored for a short. Both confirmed as of bar `i`. */
export function lastLeg(bars, sw, i, lookback, dir) {
  const first = dir > 0 ? sw.lows : sw.highs;
  const second = dir > 0 ? sw.highs : sw.lows;
  for (let n = second.length - 1; n >= 0; n--) {
    const b2 = second[n];
    if (b2 + lookback > i) continue;
    for (let m = first.length - 1; m >= 0; m--) {
      const a1 = first[m];
      if (a1 >= b2 || a1 + lookback > i) continue;
      const from = dir > 0 ? bars[a1].low : bars[a1].high;
      const to = dir > 0 ? bars[b2].high : bars[b2].low;
      if (dir > 0 ? to <= from : to >= from) break;
      return { from, to, size: Math.abs(to - from), fromAt: bars[a1].time, toAt: bars[b2].time };
    }
  }
  return null;
}

/**
 * Every setup in `bars`, in order. `daily` supplies the measured-move leg.
 * Nothing here reads a bar later than the one being decided on.
 */
export function findSetups(bars, daily, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const a = atr(bars, 14);
  const cl = bars.map(x => x.close);
  const sw = swings(bars, o.lookback);
  const swD = swings(daily, o.lookback);
  const zones = buildZones(bars, { lookback: o.lookback, tolATR: o.tolATR, minTouches: o.zoneMinTouches });
  if (!zones.length) return [];

  const lastAt = new Map(), testNo = new Map();
  const out = [];

  for (let i = 220; i < bars.length; i++) {
    if (a[i] == null || i < 6) continue;
    for (const z of zones) {
      if (z.confirmedTime > bars[i].time) continue;
      if (!(bars[i].low <= z.high && bars[i].high >= z.low)) continue;
      const key = z.kind + ':' + z.price.toFixed(6);
      if (i - (lastAt.get(key) ?? -1e9) < o.cooldown) continue;
      lastAt.set(key, i);
      const test = (testNo.get(key) ?? 0) + 1;
      testNo.set(key, test);

      const fromAbove = cl[i - 5] > z.price;
      const speed = Math.abs(cl[i] - cl[i - 5]) / a[i];
      const ahead = zones.filter(w => w.confirmedTime <= bars[i].time && Math.abs(w.price - z.price) > a[i] * 0.5)
        .filter(w => fromAbove ? w.price < z.price : w.price > z.price)
        .sort((x, y) => Math.abs(x.price - z.price) - Math.abs(y.price - z.price));
      const behind = zones.filter(w => w.confirmedTime <= bars[i].time && Math.abs(w.price - z.price) > a[i] * 0.5)
        .filter(w => fromAbove ? w.price > z.price : w.price < z.price)
        .sort((x, y) => Math.abs(x.price - z.price) - Math.abs(y.price - z.price));
      const room = ahead[0] ? Math.abs(ahead[0].price - z.price) / a[i] : 99;
      const backup = ahead.filter(w => Math.abs(w.price - z.price) <= a[i] * 8).length;

      const through = fromAbove ? bars[i].close < z.low : bars[i].close > z.high;
      const rejected = fromAbove ? bars[i].close > z.high : bars[i].close < z.low;

      let kind = null;
      if (through && room < o.wallRoom && backup >= o.backupMin && backup <= o.backupMax) kind = 'WALL';
      else if (through && room > o.fieldRoom && test <= o.fieldMaxTest &&
               speed >= o.fastATR) kind = 'FIELD';
      else if (rejected && room < o.wallRoom) kind = 'REV';
      if (!kind) continue;

      const dir = kind === 'REV' ? (fromAbove ? 1 : -1) : (fromAbove ? -1 : 1);
      const px = bars[i].close;
      const stop = dir > 0 ? z.low - a[i] * o.stopATR[kind] : z.high + a[i] * o.stopATR[kind];
      if (dir > 0 ? px <= stop : px >= stop) continue;

      const di = daily.findIndex(x => x.time > bars[i].time);
      const dIdx = (di < 0 ? daily.length : di) - 1;
      if (dIdx < 20) continue;
      const leg = lastLeg(daily, swD, dIdx, o.lookback, dir);
      if (!leg || leg.size < a[i] * o.minLegATR) continue;
      const target = dir > 0 ? leg.to + leg.size * o.fibExt : leg.to - leg.size * o.fibExt;
      if (dir > 0 ? target <= px : target >= px) continue;

      out.push({
        i, time: bars[i].time, kind, dir, zone: z,
        level: z.price, band: [z.low, z.high], touches: z.touches,
        confirmedTime: z.confirmedTime,
        // When the level FORMED, not when its last swing confirmed. A band with
        // 12 swings is not three days old, and confirmedTime reads like it is.
        formedTime: bars[Math.max(0, z.firstAt)]?.time ?? null,
        ageBars: z.firstAt != null ? i - z.firstAt : null,
        testNo: test, speed,
        room, backup, px, stop, target, risk: Math.abs(px - stop),
        rr: Math.abs(target - px) / Math.abs(px - stop),
        leg,
        ahead: ahead.slice(0, 3).map(w => w.price),
        behind: behind.slice(0, 2).map(w => w.price),
        atr: a[i],
        // the levels a REVERSAL travels toward are the ones behind the break
        aheadForTrade: (kind === 'REV' ? behind : ahead).slice(0, 3).map(w => w.price),
        behindForTrade: (kind === 'REV' ? ahead : behind).slice(0, 2).map(w => w.price),
      });
    }
  }
  return out;
}
