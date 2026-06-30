/**
 * Pre-aggregated stats from scanner_audit.json for the brief agents.
 *
 * scanner_audit.json is gitignored (large, noisy diffs); this file is tracked
 * so the cloud-scheduled brief agents can read it via `git clone` without
 * needing live filesystem access to the production VM.
 *
 * Regenerated at the end of each scan pass. Diff stays small because most
 * fields are aggregates that only move on state transitions.
 */
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIEF_DATA = join(__dirname, '..', 'brief_data.json');

const WIN_STATUSES = new Set(['tp1_hit', 'tp2_hit', 'tp3_hit', 'tp3_extended']);
const LOSS_STATUSES = new Set(['stopped']);
const EXPIRED_STATUSES = new Set(['expired']);

function isWin(s) { return WIN_STATUSES.has(s.status); }
function isLoss(s) { return LOSS_STATUSES.has(s.status); }
function isExpired(s) { return EXPIRED_STATUSES.has(s.status); }

function effectiveType(s) {
  return s.ltfConfirmed && s.suggestedDirection ? s.suggestedDirection : s.type;
}

function pipsFor(s) {
  const ref = s.entryLevel ?? s.entryPrice ?? s.triggerPrice;
  const exit = s.exitPrice;
  if (ref == null || exit == null) return 0;
  const isLong = effectiveType(s).includes('LONG');
  const mul = s.symbol.includes('JPY') ? 100 : 10000;
  return Math.round((isLong ? exit - ref : ref - exit) * mul);
}

function bucketBy(items, keyFn) {
  const out = {};
  for (const x of items) {
    const k = keyFn(x);
    if (!k) continue;
    (out[k] = out[k] || []).push(x);
  }
  return out;
}

function perfSummary(items) {
  const wins = items.filter(isWin);
  const losses = items.filter(isLoss);
  const expired = items.filter(isExpired);
  const totalPips = items.reduce((s, x) => s + pipsFor(x), 0);
  const decided = wins.length + losses.length;
  return {
    total: items.length,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    pipsTotal: totalPips,
    winRate: decided > 0 ? +(wins.length / decided * 100).toFixed(1) : null,
  };
}

export function generateBriefData(log) {
  const now = Date.now();
  const setups = log.setups || [];

  const last24hCutoff = now - 24 * 3600000;
  const last7dCutoff  = now - 7 * 24 * 3600000;

  const closedSetups = setups.filter(s => s.exitTime);
  const closed24h = closedSetups.filter(s => new Date(s.exitTime).getTime() >= last24hCutoff);
  const closed7d  = closedSetups.filter(s => new Date(s.exitTime).getTime() >= last7dCutoff);

  const openPositions = setups
    .filter(s => s.status === 'pending' && s.triggered)
    .map(s => {
      const ref = s.triggerPrice ?? s.entryLevel ?? s.entryPrice;
      const last = s.lastPrice ?? ref;
      const isLong = effectiveType(s).includes('LONG');
      const mul = s.symbol.includes('JPY') ? 100 : 10000;
      const livePips = ref != null && last != null
        ? Math.round((isLong ? last - ref : ref - last) * mul)
        : 0;
      return {
        symbol: s.symbol,
        type: effectiveType(s),
        entry: ref,
        currentPrice: last,
        sl: s.ltfConfirmed && s.continuationLevels?.sl != null ? s.continuationLevels.sl : s.sl,
        tp1: s.ltfConfirmed && s.continuationLevels?.tp1 != null ? s.continuationLevels.tp1 : s.tp1,
        tp2: s.ltfConfirmed && s.continuationLevels?.tp2 != null ? s.continuationLevels.tp2 : s.tp2,
        tp3: s.tp3,
        plPips: livePips,
        mfePips: s.maxFavorable != null && ref != null
          ? Math.round((isLong ? s.maxFavorable - ref : ref - s.maxFavorable) * mul)
          : 0,
        maePips: s.maxAdverse != null && ref != null
          ? Math.round((isLong ? ref - s.maxAdverse : s.maxAdverse - ref) * mul)
          : 0,
        triggered: s.triggered,
        triggerTime: s.triggerTime,
        tp3Trailing: !!s.tp3Trailing,
        trailSL: s.trailSL,
      };
    });

  // Per-pair performance over the last 7 days — actionable for the brief.
  const byPair = bucketBy(closed7d, s => s.symbol);
  const perfByPair = Object.fromEntries(
    Object.entries(byPair).map(([sym, items]) => [sym, perfSummary(items)])
  );

  const byType = bucketBy(closed7d, s => effectiveType(s));
  const perfByType = Object.fromEntries(
    Object.entries(byType).map(([t, items]) => [t, perfSummary(items)])
  );

  // Top / bottom pair by pip total
  const pairEntries = Object.entries(perfByPair);
  pairEntries.sort((a, b) => b[1].pipsTotal - a[1].pipsTotal);
  const topPair = pairEntries[0] ? { pair: pairEntries[0][0], pips: pairEntries[0][1].pipsTotal } : null;
  const worstPair = pairEntries[pairEntries.length - 1]
    ? { pair: pairEntries[pairEntries.length - 1][0], pips: pairEntries[pairEntries.length - 1][1].pipsTotal }
    : null;

  // Recent closed setups (last 24h) trimmed to brief-relevant fields
  const recentOutcomes = closed24h
    .sort((a, b) => new Date(b.exitTime) - new Date(a.exitTime))
    .map(s => ({
      symbol: s.symbol,
      type: effectiveType(s),
      status: s.status,
      entry: s.entryLevel ?? s.entryPrice ?? s.triggerPrice,
      exit: s.exitPrice,
      pips: pipsFor(s),
      exitTime: s.exitTime,
    }));

  const data = {
    generatedAt: new Date(now).toISOString(),
    overall: perfSummary(setups),
    last24h: { ...perfSummary(closed24h), outcomes: recentOutcomes },
    last7d: perfSummary(closed7d),
    perfByPair,
    perfByType,
    topPair,
    worstPair,
    openPositions,
    pendingTotal: setups.filter(s => s.status === 'pending').length,
    tp3TrailingCount: setups.filter(s => s.tp3Trailing && s.status === 'pending').length,
  };

  try {
    writeFileSync(BRIEF_DATA, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[brief_data] write failed: ${e.message}`);
  }
  return data;
}
