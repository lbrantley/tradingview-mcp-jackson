/**
 * OANDA v20 REST client — read-only.
 *
 * Replaces the CDP/TradingView scrape as the source of prices, candles, and
 * account truth. The scrape had to switch a chart and read a UI, which raced:
 * 1,834 "chart-switch did not settle" failures since 2026-07-30, plus exit
 * prices captured from the wrong symbol. An HTTP request cannot do either.
 *
 * It is also the only way to know what actually happened. The audit infers
 * outcomes by replaying bars against remembered levels; /transactions reports
 * real fills.
 *
 * NOTHING HERE WRITES. Every call is a GET. OANDA personal access tokens
 * cannot be scoped read-only, so the restraint has to live in the code —
 * see assertWritable() for the guard any future write path must pass.
 *
 * Env:
 *   OANDA_API_TOKEN            required
 *   OANDA_ACCOUNT_ID           default account for every call — the empty one
 *   OANDA_SANDBOX_ACCOUNT_ID   the only legal write target (same, by design)
 *   OANDA_LIVE_ACCOUNT_ID      real money; read-only, and only when named
 *   OANDA_ENV                  'live' (default) | 'practice'
 *   OANDA_ALLOW_TRADING        '1' to permit writes at all. Defaults off.
 */
import 'dotenv/config';

const HOSTS = {
  live: 'https://api-fxtrade.oanda.com',
  practice: 'https://api-fxpractice.oanda.com',
};

export const ENV = process.env.OANDA_ENV === 'practice' ? 'practice' : 'live';
export const HOST = HOSTS[ENV];
const TOKEN = process.env.OANDA_API_TOKEN;
export const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID || null;
export const SANDBOX_ACCOUNT_ID = process.env.OANDA_SANDBOX_ACCOUNT_ID || null;
// Real money. Never the default for anything — a caller has to name it.
export const LIVE_ACCOUNT_ID = process.env.OANDA_LIVE_ACCOUNT_ID || null;

if (!TOKEN) throw new Error('OANDA_API_TOKEN missing from .env');

// "OANDA:EURUSD" / "EURUSD" -> "EUR_USD". The scanner carries the first form
// everywhere; the API only accepts the third.
export function toInstrument(symbol) {
  const s = String(symbol).replace(/^OANDA:/, '').replace('_', '');
  if (s.length !== 6) throw new Error(`Cannot parse instrument from "${symbol}"`);
  return `${s.slice(0, 3)}_${s.slice(3)}`;
}

// "EUR_USD" -> "EURUSD", for matching back to audit records.
export function toSymbol(instrument) {
  return String(instrument).replace('_', '');
}

async function get(path, params = {}) {
  const url = new URL(HOST + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Accept-Datetime-Format': 'RFC3339',
    },
  });
  const body = await res.text();
  if (!res.ok) {
    // Surface OANDA's own message — its errors are specific and worth reading
    // (INSUFFICIENT_MARGIN, INVALID_INSTRUMENT, etc.) rather than a bare code.
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).errorMessage || msg; } catch { /* keep raw */ }
    throw new Error(`OANDA ${res.status} ${path} — ${msg}`);
  }
  return JSON.parse(body);
}

/** Every account this token can reach. Also the cheapest check that it works. */
export async function listAccounts() {
  return (await get('/v3/accounts')).accounts || [];
}

export async function getSummary(accountId = ACCOUNT_ID) {
  return (await get(`/v3/accounts/${accountId}/summary`)).account;
}

export async function getOpenTrades(accountId = ACCOUNT_ID) {
  return (await get(`/v3/accounts/${accountId}/openTrades`)).trades || [];
}

export async function getPendingOrders(accountId = ACCOUNT_ID) {
  return (await get(`/v3/accounts/${accountId}/pendingOrders`)).orders || [];
}

/** Current bid/ask. Replaces getQuote() and its chart-switch race entirely. */
export async function getPricing(symbols, accountId = ACCOUNT_ID) {
  const list = (Array.isArray(symbols) ? symbols : [symbols]).map(toInstrument);
  const data = await get(`/v3/accounts/${accountId}/pricing`, { instruments: list.join(',') });
  const out = {};
  for (const p of data.prices || []) {
    const bid = parseFloat(p.bids?.[0]?.price);
    const ask = parseFloat(p.asks?.[0]?.price);
    out[toSymbol(p.instrument)] = {
      bid, ask,
      mid: (bid + ask) / 2,
      spread: ask - bid,          // never in the audit; it is a real cost
      tradeable: p.tradeable,
      time: p.time,
    };
  }
  return out;
}

/**
 * Historical candles. This is what makes backtesting possible: 5000 bars per
 * request, so H4 over ~3 years arrives in a single call per pair.
 *
 * `complete: false` bars are still forming — excluded by default, because a
 * partial bar's high/low/close will change and would silently corrupt a
 * backtest.
 */
// `count` defaults to 500, so "was it asked for?" cannot be inferred from the
// value alone. Callers paging a range pass it deliberately.
const countExplicit = c => c !== undefined && c !== null;

export async function getCandles(symbol, {
  granularity = 'H4',
  count,
  from,
  to,
  price = 'M',              // M=mid, B=bid, A=ask
  includeIncomplete = false,
} = {}) {
  // OANDA rejects a from+to span whose implied bar count exceeds 5000, so
  // from+count is the only combination that can page a long range. Send count
  // whenever it is given, and drop `to` in that case to avoid the conflict.
  const params = { granularity, price };
  if (from && countExplicit(count)) { params.from = from; params.count = Math.min(count, 5000); }
  else if (from || to) { if (from) params.from = from; if (to) params.to = to; }
  else params.count = Math.min(count ?? 500, 5000);

  const data = await get(`/v3/instruments/${toInstrument(symbol)}/candles`, params);
  const key = price === 'B' ? 'bid' : price === 'A' ? 'ask' : 'mid';
  return (data.candles || [])
    .filter(c => includeIncomplete || c.complete)
    .map(c => ({
      time: c.time,
      open: parseFloat(c[key].o),
      high: parseFloat(c[key].h),
      low: parseFloat(c[key].l),
      close: parseFloat(c[key].c),
      volume: c.volume,
      complete: c.complete,
    }));
}

/**
 * Candles over an arbitrary range, paging around OANDA's 5000-per-request cap.
 *
 * Needed because the entry timeframe is finer than the level timeframe: H1
 * over two years is ~12,500 bars, so a single call silently truncates to the
 * most recent 5000 and a backtest would quietly test one year while reporting
 * two. Pages forward from `from` until the API stops returning new bars.
 */
export async function getCandlesRange(symbol, { granularity = 'H1', from, to, price = 'M' } = {}) {
  const end = new Date(to).getTime();
  let cursor = new Date(from).toISOString();
  const out = [];
  let guard = 0;
  while (guard++ < 40) {
    const batch = await getCandles(symbol, { granularity, from: cursor, price, count: 5000 });
    // from+count ignores `to`, so trim anything past the requested end.
    for (let n = batch.length - 1; n >= 0; n--) {
      if (new Date(batch[n].time).getTime() > end) batch.splice(n, 1);
    }
    if (!batch.length) break;
    // Overlap on the boundary bar is expected; drop anything already held.
    const fresh = out.length ? batch.filter(c => c.time > out[out.length - 1].time) : batch;
    if (!fresh.length) break;
    out.push(...fresh);
    const lastMs = new Date(out[out.length - 1].time).getTime();
    if (lastMs >= end || batch.length < 5000) break;
    cursor = new Date(lastMs + 1000).toISOString();
  }
  return out;
}

/**
 * Real fills — the ground truth the audit has never had. Use to reconcile what
 * the scanner said against what the account actually did.
 */
export async function getTransactions(accountId = ACCOUNT_ID, { from, to, type } = {}) {
  const data = await get(`/v3/accounts/${accountId}/transactions`, { from, to, type });
  return data.transactions || data;
}

/**
 * Transactions since a given id — the incremental form, for polling.
 *
 * /transactions returns pages of ids rather than the transactions themselves,
 * which is useless for a journal. sinceid returns the actual records.
 * Returns { transactions, lastId } so a caller can resume from where it left
 * off without re-reading history.
 */
export async function getTransactionsSince(id, accountId = ACCOUNT_ID) {
  const data = await get(`/v3/accounts/${accountId}/transactions/sinceid`, { id });
  return { transactions: data.transactions || [], lastId: data.lastTransactionID };
}

/** The account's most recent transaction id — the starting point for polling. */
export async function getLastTransactionId(accountId = ACCOUNT_ID) {
  const data = await get(`/v3/accounts/${accountId}/summary`);
  return data.lastTransactionID;
}

/**
 * Gate every future write must pass. Trading is off unless explicitly enabled,
 * and even then may only target the zero-balance sandbox account — so a
 * decimal-point slip cannot reach real money. Deliberately throws rather than
 * returning false: a caller that forgets to check should crash, not proceed.
 */
export function assertWritable(accountId) {
  if (process.env.OANDA_ALLOW_TRADING !== '1') {
    throw new Error('Refusing to write: OANDA_ALLOW_TRADING is not "1".');
  }
  if (!SANDBOX_ACCOUNT_ID) {
    throw new Error('Refusing to write: OANDA_SANDBOX_ACCOUNT_ID is not set.');
  }
  if (accountId !== SANDBOX_ACCOUNT_ID) {
    throw new Error(
      `Refusing to write to ${accountId} — only the sandbox account ` +
      `(${SANDBOX_ACCOUNT_ID}) is a legal write target.`
    );
  }
}

/**
 * The only write path in this module.
 *
 * Everything above is a GET. This is not, so it goes through assertWritable(),
 * which refuses unless OANDA_ALLOW_TRADING=1 AND the target is the sandbox
 * account. That guard is deliberate and should not be relaxed to "the live
 * account, carefully" — the whole point is that a bug, a bad loop, or a
 * misread signal cannot reach real money by accident.
 *
 * The stop and target go on as ON-FILL orders, not as follow-up requests. If
 * this process dies between placing the entry and placing the stop, OANDA has
 * still recorded both — an unprotected position cannot exist.
 */
async function post(path, body, accountId) {
  assertWritable(accountId);
  const res = await fetch(new URL(HOST + path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Accept-Datetime-Format': 'RFC3339',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { const j = JSON.parse(text); msg = j.errorMessage || j.orderRejectTransaction?.reason || msg; } catch { /* raw */ }
    throw new Error(`OANDA ${res.status} ${path} — ${msg}`);
  }
  return JSON.parse(text);
}

/**
 * Market order with the stop and target attached on fill.
 *
 * `units` is signed: positive is long, negative is short. 1000 units is 0.01
 * lot, the broker minimum and the "marker" size.
 */
export async function placeMarketOrder({
  symbol, units, stop, target, accountId = SANDBOX_ACCOUNT_ID, reason = '',
}) {
  if (!Number.isInteger(units) || units === 0) throw new Error(`units must be a non-zero integer, got ${units}`);
  if (stop == null) throw new Error('Refusing to place an order with no stop.');
  const digits = /JPY$/.test(symbol) ? 3 : 5;
  const order = {
    type: 'MARKET',
    instrument: toInstrument(symbol),
    units: String(units),
    timeInForce: 'FOK',
    positionFill: 'DEFAULT',
    stopLossOnFill: { price: stop.toFixed(digits), timeInForce: 'GTC' },
    clientExtensions: { tag: 'scan_live', comment: reason.slice(0, 128) },
  };
  if (target != null) {
    order.takeProfitOnFill = { price: target.toFixed(digits), timeInForce: 'GTC' };
  }
  return post(`/v3/accounts/${accountId}/orders`, { order }, accountId);
}
