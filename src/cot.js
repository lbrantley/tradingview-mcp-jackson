/**
 * CFTC COMMITMENT OF TRADERS — speculative positioning in currency futures.
 *
 * Answers one question the price data cannot: is a theme CROWDED? A clean
 * currency-strength read tells you which way the market has been going. This
 * tells you whether you are early to it or last through the door. Net
 * positioning at a 3-year extreme has fewer buyers left and more people to
 * squeeze.
 *
 * Source: CFTC's public Socrata API, Traders in Financial Futures report.
 * Free, no key, no region lock. Published Friday for the prior Tuesday, so it
 * is three days stale by release and up to ten by the following Monday. That
 * makes it CONTEXT, never timing.
 *
 * "Leveraged money" is the hedge-fund/CTA speculative bucket — the one whose
 * positioning actually gets squeezed. Asset managers are slower and structural.
 */
const API = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json';

// CFTC futures are quoted against USD, so a long EURO FX contract is short USD.
export const COT_MARKETS = {
  EUR: 'EURO FX - CHICAGO MERCANTILE EXCHANGE',
  JPY: 'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE',
  GBP: 'BRITISH POUND - CHICAGO MERCANTILE EXCHANGE',
  CHF: 'SWISS FRANC - CHICAGO MERCANTILE EXCHANGE',
  CAD: 'CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  AUD: 'AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  NZD: 'NZ DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  USD: 'USD INDEX - ICE FUTURES U.S.',
};

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'tradingview-mcp/1.0' } });
  if (!r.ok) throw new Error(`CFTC ${r.status}`);
  return r.json();
}

/**
 * Weekly history for one currency, newest first.
 * `weeks` back — 156 is three years, enough for a meaningful percentile.
 */
export async function cotHistory(ccy, weeks = 156) {
  const market = COT_MARKETS[ccy];
  if (!market) throw new Error(`no COT market mapped for ${ccy}`);
  const url = `${API}?$limit=${weeks}` +
    `&$order=report_date_as_yyyy_mm_dd DESC` +
    `&$where=market_and_exchange_names='${market.replace(/'/g, "''")}'`;
  const rows = await fetchJson(encodeURI(url));
  return rows.map(r => {
    const long = +r.lev_money_positions_long || 0;
    const short = +r.lev_money_positions_short || 0;
    const oi = +r.open_interest_all || 0;
    return {
      date: (r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
      long, short, net: long - short, oi,
      // net as a share of open interest — comparable across currencies and
      // across time, unlike raw contract counts
      netPct: oi ? 100 * (long - short) / oi : 0,
    };
  }).filter(r => r.date);
}

/**
 * Positioning for every mapped currency, with each one's net expressed as a
 * percentile of its own last three years. 0 = most short it has been,
 * 100 = most long.
 */
export async function cotSnapshot(weeks = 156) {
  const out = {};
  for (const ccy of Object.keys(COT_MARKETS)) {
    try {
      const h = await cotHistory(ccy, weeks);
      if (!h.length) continue;
      const cur = h[0];
      const sorted = h.map(x => x.netPct).sort((a, b) => a - b);
      const rank = sorted.findIndex(v => v >= cur.netPct);
      out[ccy] = {
        ...cur,
        weeks: h.length,
        percentile: h.length > 1 ? 100 * rank / (h.length - 1) : 50,
        // week-on-week change tells you whether the crowd is still arriving
        netChange: h[1] ? cur.net - h[1].net : 0,
      };
    } catch (e) { out[ccy] = { error: e.message }; }
  }
  return out;
}

/**
 * How crowded is a pair's theme? Positive = the market is long BASE and short
 * QUOTE, i.e. leaning the same way a long trade would.
 */
export function pairSkew(snap, sym) {
  const b = snap[sym.slice(0, 3)], q = snap[sym.slice(3)];
  if (!b || !q || b.error || q.error) return null;
  return {
    basePct: b.percentile, quotePct: q.percentile,
    // both extremes matter: long a currency already at its 3y long extreme
    // against one at its short extreme is the definition of a crowded trade
    skew: b.percentile - q.percentile,
    asOf: b.date,
  };
}
