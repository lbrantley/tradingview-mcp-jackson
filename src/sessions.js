/**
 * WHEN THE RANGE HAPPENS.
 *
 * The user has a day job and two windows he can place orders in: roughly 6am
 * and 6pm Chicago. Everything here exists to make those two windows the right
 * two windows.
 *
 * Measured 2026-10-06 on H1 bars, 28 pairs, ~2 years, weekdays only, in
 * America/Chicago so DST is handled by the platform rather than by arithmetic.
 * Each hour's range is normalised to that PAIR's own average hour, so this is
 * session preference and not pair volatility — those are separate signals and
 * answer different questions.
 *
 *     07:00  1.39      <- NY pre-market
 *     08:00  1.45      <- NY opens
 *     09:00  1.58      <- the peak
 *     10:00  1.21
 *     02:00  1.25      <- London opens
 *     14:00-18:00  0.65-0.91   dead
 *
 * THIS IS THE MOST STABLE THING IN THE SYSTEM. Split-half persistence is 0.914
 * for the morning preference and 0.962 for the overnight one, against 0.72 for
 * the two-day volatility regime and 0.62 for cross-selection beta. The hours do
 * not drift because London and New York do not move.
 *
 * TWO FINDINGS THAT SHAPE HOW THIS IS USED:
 *
 * 1. No pair genuinely prefers the evening. Even the best overnight pairs are
 *    better in the morning — AUDJPY is 1.10x overnight against 1.32x in the
 *    morning. AUDNZD is the only near-tie. So this is not "morning pairs versus
 *    evening pairs"; the morning is better for everything and some pairs are
 *    merely less dead overnight.
 *
 * 2. An order placed at 6pm rests through Tokyo, London AND the next morning's
 *    NY overlap — about sixteen hours covering the best window of the next day.
 *    A 6am order gets the NY window and then the dead afternoon. So the EVENING
 *    review is the more powerful of the two, which is the opposite of how it
 *    looks. The user was already placing evening orders; that instinct was right.
 */

/** Range in each window as a multiple of that pair's own average hour. */
export const SESSION_SKEW = {
  USDCAD: { am: 1.67, pm: 0.81 }, EURCAD: { am: 1.59, pm: 0.80 },
  GBPCAD: { am: 1.58, pm: 0.82 }, CADCHF: { am: 1.56, pm: 0.83 },
  GBPUSD: { am: 1.54, pm: 0.89 }, USDCHF: { am: 1.54, pm: 0.89 },
  EURCHF: { am: 1.53, pm: 0.90 }, EURUSD: { am: 1.53, pm: 0.90 },
  GBPCHF: { am: 1.51, pm: 0.86 }, EURGBP: { am: 1.50, pm: 0.85 },
  CADJPY: { am: 1.44, pm: 0.99 }, AUDUSD: { am: 1.44, pm: 1.00 },
  AUDCAD: { am: 1.42, pm: 1.00 }, CHFJPY: { am: 1.40, pm: 1.01 },
  NZDUSD: { am: 1.39, pm: 0.99 }, GBPJPY: { am: 1.37, pm: 1.03 },
  USDJPY: { am: 1.37, pm: 1.04 }, AUDCHF: { am: 1.36, pm: 1.04 },
  EURAUD: { am: 1.34, pm: 1.08 }, GBPAUD: { am: 1.34, pm: 1.04 },
  EURJPY: { am: 1.33, pm: 1.07 }, NZDCAD: { am: 1.33, pm: 0.99 },
  AUDJPY: { am: 1.32, pm: 1.10 }, NZDJPY: { am: 1.28, pm: 1.09 },
  EURNZD: { am: 1.27, pm: 1.06 }, NZDCHF: { am: 1.27, pm: 1.03 },
  GBPNZD: { am: 1.26, pm: 1.04 }, AUDNZD: { am: 1.13, pm: 1.15 },
};

/** Range by hour of day, all pairs pooled. 1.00 is an average hour. */
export const HOUR_RANGE = {
  0: 0.82, 1: 1.13, 2: 1.25, 3: 1.23, 4: 1.04, 5: 0.98, 6: 1.10, 7: 1.39,
  8: 1.45, 9: 1.58, 10: 1.21, 11: 0.92, 12: 0.84, 13: 0.82, 14: 0.74,
  15: 0.69, 16: 0.91, 17: 0.68, 18: 0.65, 19: 0.97, 20: 0.99, 21: 0.84,
  22: 0.75, 23: 0.74,
};

export const WINDOWS = [
  { name: 'London open', from: 1, to: 3 },
  { name: 'NY overlap', from: 7, to: 10 },
  { name: 'Tokyo', from: 19, to: 23 },
];

/** Current hour in Chicago, DST handled by the platform. */
export function chicagoHour(now = new Date()) {
  return +new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', hour12: false,
  }).format(now) % 24;
}

/**
 * What the clock says right now: how active this hour is, and when the next
 * real window opens. Printed at the top of every scan so a setup is never read
 * without knowing whether anything is likely to happen for the next six hours.
 */
export function sessionClock(now = new Date()) {
  const h = chicagoHour(now);
  const mult = HOUR_RANGE[h];
  const live = WINDOWS.find(w => h >= w.from && h <= w.to);
  const next = WINDOWS
    .map(w => ({ ...w, in: (w.from - h + 24) % 24 }))
    .sort((a, b) => a.in - b.in)[0];
  return {
    hour: h, mult, live: live || null, next,
    state: mult >= 1.2 ? 'BUSY' : mult < 0.85 ? 'DEAD' : 'normal',
  };
}

/**
 * Which window an order placed now will rest through.
 *
 * A 6pm order covers Tokyo, London and the next NY overlap, so the pair's
 * overnight skew matters but the morning skew is what most fills land in. A 6am
 * order only has the NY overlap before the afternoon goes dead.
 */
export function restsThrough(now = new Date()) {
  const h = chicagoHour(now);
  if (h >= 16 || h <= 2) return { window: 'pm', covers: 'Tokyo, London and tomorrow\'s NY overlap', hours: 16 };
  if (h >= 3 && h <= 10) return { window: 'am', covers: 'the NY overlap', hours: Math.max(1, 11 - h) };
  return { window: 'am', covers: 'tomorrow — the rest of today is dead', hours: 0 };
}

/** The pair's skew for the window an order placed now will rest through. */
export function skewFor(sym, now = new Date()) {
  const s = SESSION_SKEW[sym];
  if (!s) return null;
  const w = restsThrough(now).window;
  return { window: w, mult: s[w], am: s.am, pm: s.pm,
           verdict: s[w] >= 1.3 ? 'prime' : s[w] >= 1.0 ? 'fair' : 'wrong window' };
}

/**
 * WHERE THE ENERGY IS — ATR(14) over ATR(100) per pair.
 *
 * Separate question from the session skew: this says which pairs are unusually
 * active NOW, the skew says when any pair is active. Measured over 77,812
 * observations, volatility PERSISTS rather than mean-reverting — a pair already
 * running covers 6.31 ATR over the next 20 bars against 3.67 for a quiet one.
 *
 * Shelf life is short: the ranking correlates 0.86 a day out, 0.72 at two days,
 * 0.28 at five, and nothing at ten. A two-day watchlist, refreshed daily.
 *
 * What it does NOT give is direction. After a bar moving more than 1.5x the
 * long-run ATR, price continued 47.7% of the time and reversed 52.3% — noise.
 * So energy picks the pair and structure picks the side. Chasing a pair because
 * it just moved is half right; guessing the direction is the other half.
 */
export function energyRanking(atr14ByPair, atr100ByPair) {
  const rows = [];
  for (const [sym, a14] of atr14ByPair) {
    const a100 = atr100ByPair.get(sym);
    if (!a14 || !a100) continue;
    const ratio = a14 / a100;
    rows.push({ sym, ratio,
      state: ratio >= 1.15 ? 'HOT' : ratio <= 0.9 ? 'quiet' : 'normal' });
  }
  return rows.sort((x, y) => y.ratio - x.ratio);
}
