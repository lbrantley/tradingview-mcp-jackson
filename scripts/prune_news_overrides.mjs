#!/usr/bin/env node
/**
 * Prune stale entries from news_overrides.json.
 *
 * The workflow: user screenshots FF's forward calendar on Wednesday because FF's
 * JSON feed only carries a few days of forward events. Those manually-parsed
 * events get added to news_overrides.json to bridge the gap. Once the FF feed
 * catches up (usually within 3-5 days), the override entries are redundant and
 * cause double-display in the review output.
 *
 * This script scans news_cache.json (FF feed) and removes any override entry
 * that matches an FF event on (currency, title, date within ±2 hours). Also
 * removes any override with a date more than 24h in the past.
 *
 * Run manually or from deliver_review.mjs before generating the review.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERRIDES = join(__dirname, '..', 'news_overrides.json');
const CACHE = join(__dirname, '..', 'news_cache.json');
const MATCH_WINDOW_MS = 2 * 3600 * 1000; // 2h — matches dedupeMerge in scanner.mjs
const STALE_CUTOFF_MS = 24 * 3600 * 1000; // events > 24h in the past are stale

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

const overrides = loadJSON(OVERRIDES);
if (!overrides || !Array.isArray(overrides.manualEvents)) {
  console.log('news_overrides.json not found or malformed — nothing to prune');
  process.exit(0);
}

const cache = loadJSON(CACHE);
const ffEvents = cache?.events || [];
console.log(`Loaded ${overrides.manualEvents.length} manual events, ${ffEvents.length} FF cache events`);

const now = Date.now();
const kept = [];
const droppedByCache = [];
const droppedStale = [];

for (const ov of overrides.manualEvents) {
  const ovTime = new Date(ov.date).getTime();

  // Stale: event happened more than 24h ago
  if (ovTime < now - STALE_CUTOFF_MS) {
    droppedStale.push(ov);
    continue;
  }

  // Duplicate: FF cache has a matching event
  const match = ffEvents.find(e =>
    e.currency === ov.currency &&
    e.title === ov.title &&
    Math.abs(new Date(e.date).getTime() - ovTime) <= MATCH_WINDOW_MS
  );
  if (match) {
    droppedByCache.push({ ov, match });
    continue;
  }

  kept.push(ov);
}

console.log(`Kept:    ${kept.length}`);
console.log(`Pruned as stale (>24h old):     ${droppedStale.length}`);
console.log(`Pruned as FF-cache duplicates:  ${droppedByCache.length}`);

if (droppedByCache.length > 0) {
  console.log('\nCache-duplicate drops:');
  for (const d of droppedByCache) {
    console.log(`  - ${d.ov.currency} ${d.ov.title} @ ${d.ov.date}`);
    console.log(`    matched FF @ ${d.match.date}`);
  }
}

if (droppedStale.length > 0) {
  console.log('\nStale drops (event now in the past):');
  for (const d of droppedStale) {
    console.log(`  - ${d.currency} ${d.title} @ ${d.date}`);
  }
}

const totalDropped = droppedStale.length + droppedByCache.length;
if (totalDropped === 0) {
  console.log('\nNothing to prune.');
  process.exit(0);
}

// Write back — preserve _meta but bump lastUpdated
const out = {
  ...overrides,
  _meta: {
    ...(overrides._meta || {}),
    lastUpdated: new Date().toISOString().slice(0, 10),
    lastPrune: new Date().toISOString(),
    lastPruneCount: totalDropped,
  },
  manualEvents: kept,
};
writeFileSync(OVERRIDES, JSON.stringify(out, null, 2));
console.log(`\n✓ Wrote ${kept.length} entries to news_overrides.json`);
