/**
 * MOVE WEIGHT — how much money a setup on this pair is likely to be worth.
 *
 * The user sizes every marker at 0.01 and manages the stop himself by entering
 * early, so the question he asked is about PAYOFF, not payoff-per-risk: given
 * two setups, which pair actually pays when it works?
 *
 * Tested 2026-09-22 over 3,390 setups on 28 pairs, measuring MFE in dollars on
 * a 0.01 marker until the stop hit or 120 H4 bars passed:
 *
 *     pair's dollar volatility -> MFE    0.313   the only input that works
 *     ATR above its own normal           0.089   weak
 *     room ahead (ATR)                   0.016   nothing
 *     volume trend                       flat
 *     WALL / FIELD / REV                 flat
 *     CONTINUATION vs REVERSAL           flat
 *
 * So the weight is a PAIR-LEVEL CONSTANT. Nothing about an individual setup
 * predicts how far it runs. The temptation is to add a situational component
 * anyway; the data does not support one, and a first pass that seemed to find
 * one turned out to be measuring MFE in units of the CURRENT atr, which a quiet
 * setup deflates. Against the pair's trailing-normal atr the sign flipped.
 *
 * It ANNOTATES. It never reorders and never filters — same rule as the RSI
 * grade. A slow pair with a good setup is still a good setup.
 */

/**
 * Median realised move per tier, in dollars on a 0.01 marker, from the backtest
 * above. Hardcoded because it needs forward data no live scan has. Monotone
 * A -> D, which is the whole reason the tiers are worth printing.
 */
export const TIER_TYPICAL = { A: 18, B: 16, C: 13, D: 10 };

/** Quote currency -> USD. Needed to compare an ATR across pairs at all. */
export async function quoteRates(getCandles) {
  const rates = { USD: 1 };
  const direct = [['EURUSD', 'EUR'], ['GBPUSD', 'GBP'], ['AUDUSD', 'AUD'], ['NZDUSD', 'NZD']];
  const inverse = [['USDJPY', 'JPY'], ['USDCHF', 'CHF'], ['USDCAD', 'CAD']];
  await Promise.all([
    ...direct.map(async ([sym, ccy]) => {
      const c = await getCandles(sym, { granularity: 'D', count: 2 });
      rates[ccy] = c[c.length - 1].close;
    }),
    ...inverse.map(async ([sym, ccy]) => {
      const c = await getCandles(sym, { granularity: 'D', count: 2 });
      rates[ccy] = 1 / c[c.length - 1].close;
    }),
  ]);
  return rates;
}

/** Dollars per unit of price movement on `units` of this pair. */
export function usdPerPrice(sym, rates, units = 1000) {
  const q = rates[sym.slice(3)];
  return q == null ? null : units * q;
}

/**
 * Tier the scanned pairs into quartiles by the dollar value of one H4 ATR.
 *
 * Quartiles rather than fixed dollar cuts: the user is choosing BETWEEN setups,
 * not deciding whether conditions are good enough to trade at all. The cost is
 * that a quarter of the board is always tier A, even in a dead market — the
 * grade is relative, and says nothing about absolute conditions. Recomputed
 * every scan, so it tracks regime instead of freezing today's ranking.
 *
 * @param {Map<string, number>} atrByPair  raw H4 ATR in price, per symbol
 * @returns {Map<string, {tier, rank, of, atrUsd, typical}>}
 */
export function moveWeights(atrByPair, rates, units = 1000) {
  const rows = [];
  for (const [sym, a] of atrByPair) {
    const mult = usdPerPrice(sym, rates, units);
    if (a > 0 && mult) rows.push({ sym, atrUsd: a * mult });
  }
  const out = new Map();
  if (!rows.length) return out;
  rows.sort((x, y) => y.atrUsd - x.atrUsd);
  const asc = rows.map(r => r.atrUsd).sort((x, y) => x - y);
  const q = p => asc[Math.floor(p * (asc.length - 1))];
  const cuts = { A: q(0.75), B: q(0.50), C: q(0.25) };
  rows.forEach((r, i) => {
    const tier = r.atrUsd >= cuts.A ? 'A' : r.atrUsd >= cuts.B ? 'B' : r.atrUsd >= cuts.C ? 'C' : 'D';
    out.set(r.sym, { tier, rank: i + 1, of: rows.length, atrUsd: r.atrUsd, typical: TIER_TYPICAL[tier] });
  });
  return out;
}

const ord = n => (n % 100 >= 11 && n % 100 <= 13) ? 'th'
  : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';

/** Full console line. */
export function weightLine(w) {
  if (!w) return null;
  return `MOVE ${w.tier}   $${w.atrUsd.toFixed(2)}/ATR — ${w.rank}${ord(w.rank)} of ${w.of}` +
    ` · this tier typically delivers $${w.typical}`;
}

/** Compact tag for a Pushover line, where every character is rationed. */
export function weightTag(w) {
  return w ? `[MOVE ${w.tier}]` : '';
}
