#!/usr/bin/env node
/**
 * Auto-refresh market_context.json using Claude with web-search.
 *
 * Runs at the start of every daily review (called from deliver_review.mjs).
 * The goal is IMPACT-DRIVEN freshness: only themes that are actively
 * moving currencies stay in the active list. Anything that's faded out
 * of the market's attention gets retired.
 *
 * Design:
 *   1. Load current market_context.json (active themes only)
 *   2. Send to Claude with web_search tool enabled and today's date
 *   3. Claude decides for each theme: keep-as-is, refresh, or retire
 *   4. Claude proposes any NEW theme that's now high-impact
 *   5. Write back the updated file — always keep 2-4 active themes
 *   6. Non-fatal on failure (missing API key, timeout, parse error) —
 *      logs and continues with existing file
 *
 * Env:
 *   ANTHROPIC_API_KEY   — required. From console.anthropic.com.
 *   ANTHROPIC_MODEL     — optional. Default: claude-sonnet-4-6.
 *   MACRO_REFRESH_OFF   — set to "1" to skip refresh (dev / debugging)
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKET_CONTEXT = join(__dirname, '..', 'market_context.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const REFRESH_OFF = process.env.MACRO_REFRESH_OFF === '1';

function log(msg) {
  console.log(`[macro_refresh] ${msg}`);
}

const SYSTEM_PROMPT = `You are a forex macro analyst maintaining a rolling list of the 2-4 highest-impact themes currently moving G10 currencies (USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD).

Your job: given today's date and the current market_context.json, produce an updated JSON file that reflects only themes with MATERIAL, MEASURABLE impact on FX RIGHT NOW. Use web_search aggressively to verify facts and find new high-impact events.

Rules:
1. IMPACT filter: a theme belongs on the active list only if it is currently moving 30+ pips per day across multiple currency pairs, or has a clear near-term binary event risk. Waning themes (no longer moving markets) go to _retired[] with an endReason.
2. Fresh facts: rewrite summaries to reflect the last 3-5 days of events. Update watchLevels to current price/policy inflection points.
3. Concentration: keep 2 to 4 active themes. Never more than 5. If you'd add a 5th, retire the weakest instead.
4. Structural continuity: prefer refreshing an existing theme's summary/implications over retire+create. Only retire when the driver is genuinely gone.
5. Preserve schema exactly. Every active theme must have: id, title, started (ISO date), summary, implications (per-currency map), watchLevel, affectedPairs (array).
6. Retired themes go to _retired[] with id, title, started, endDate (today), endReason.
7. Preserve any historical entries already in _retired[] — do not delete them, only append.
8. Do not touch _meta except to update lastUpdated to today's ISO date, and set autoRefreshSummary to a one-sentence summary of what changed this run.

Output requirements — CRITICAL:
- After completing your web searches, your final reply must be ONLY raw JSON.
- Do NOT preface with "Here is the updated file" or "I now have the data" or any explanation.
- Do NOT use \`\`\`json code fences.
- Start your reply with { and end with }. Nothing else. No text before, no text after.
- The content must be valid JSON that parses.`;

function buildUserMessage(currentFile, today) {
  return `Today's date: ${today}
Current market_context.json:

${currentFile}

Use web_search to verify each active theme is still market-moving today (impact filter: 30+ pips/day across multiple pairs, or clear near-term binary event). Update summaries with the last 3-5 days of facts. Retire fading themes. Propose at most one NEW theme if a truly high-impact event has emerged in the last week that isn't captured.

Return the full updated JSON file as raw JSON only (no code fences, no prose).`;
}

async function callAnthropic(system, userMessage) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing from .env');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: userMessage }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
      ],
    }),
    signal: AbortSignal.timeout(180_000),  // 3 min hard cap
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
  }
  const data = await res.json();
  // Pull the final text block (last content item that has text; earlier
  // items may be tool_use / tool_result from the web_search loop).
  const textBlocks = (data.content || []).filter(c => c.type === 'text' && typeof c.text === 'string');
  const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : null;
  if (!text) throw new Error('No text block in Anthropic response');
  return { text, usage: data.usage };
}

function stripCodeFences(s) {
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    const lastFence = trimmed.lastIndexOf('```');
    if (firstNewline > -1 && lastFence > firstNewline) {
      return trimmed.slice(firstNewline + 1, lastFence).trim();
    }
  }
  return trimmed;
}

// Robust JSON extractor — handles all three failure modes we've observed:
//   1. Response is pure JSON (parse directly)
//   2. Response is JSON wrapped in ```json ... ``` fences
//   3. Response has prose preamble then JSON ("I now have the data... {...}")
// Uses depth tracking with string-literal awareness to find the outermost
// balanced { ... } block that parses.
function extractJson(text) {
  const cleaned = stripCodeFences(text);
  try { JSON.parse(cleaned); return cleaned; } catch {}

  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { JSON.parse(candidate); return candidate; } catch {}
      }
    }
  }
  return null;
}

function validateShape(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  if (!Array.isArray(obj.themes)) return 'themes missing or not array';
  if (obj.themes.length < 1 || obj.themes.length > 5) return `themes count out of range (${obj.themes.length})`;
  for (const [i, t] of obj.themes.entries()) {
    for (const field of ['id', 'title', 'started', 'summary', 'implications', 'watchLevel', 'affectedPairs']) {
      if (!(field in t)) return `theme[${i}] missing ${field}`;
    }
  }
  if (!obj._meta || typeof obj._meta !== 'object') return '_meta missing';
  return null;
}

async function main() {
  if (REFRESH_OFF) {
    log('MACRO_REFRESH_OFF=1 — skipping');
    return;
  }
  if (!ANTHROPIC_API_KEY) {
    log('ANTHROPIC_API_KEY not set — skipping (existing market_context.json will be used as-is)');
    return;
  }
  if (!existsSync(MARKET_CONTEXT)) {
    log('market_context.json missing — cannot refresh, skipping');
    return;
  }

  const currentRaw = readFileSync(MARKET_CONTEXT, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  log(`Refreshing themes (today=${today}, model=${MODEL})...`);

  let response;
  try {
    response = await callAnthropic(SYSTEM_PROMPT, buildUserMessage(currentRaw, today));
  } catch (e) {
    log(`API call failed: ${e.message} — keeping existing file`);
    return;
  }

  const cleaned = extractJson(response.text);
  if (!cleaned) {
    log(`No JSON found in response — keeping existing file`);
    log(`Raw response head: ${response.text.slice(0, 300)}`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    log(`Parse failed: ${e.message} — keeping existing file`);
    log(`Raw response head: ${cleaned.slice(0, 300)}`);
    return;
  }

  const shapeErr = validateShape(parsed);
  if (shapeErr) {
    log(`Shape validation failed: ${shapeErr} — keeping existing file`);
    return;
  }

  // Merge: preserve existing _retired[] history in case Claude accidentally
  // shortened it. Keep any retired entry that Claude didn't include AND
  // append any new retirements Claude added.
  try {
    const current = JSON.parse(currentRaw);
    const oldRetired = Array.isArray(current._retired) ? current._retired : [];
    const newRetired = Array.isArray(parsed._retired) ? parsed._retired : [];
    const seenIds = new Set(newRetired.map(r => r.id));
    for (const r of oldRetired) {
      if (!seenIds.has(r.id)) newRetired.push(r);
    }
    parsed._retired = newRetired;
  } catch { /* if current parse fails, just use Claude's _retired */ }

  writeFileSync(MARKET_CONTEXT, JSON.stringify(parsed, null, 2));
  const usage = response.usage || {};
  log(`✅ Refreshed. Themes: ${parsed.themes.length} active, ${(parsed._retired || []).length} retired. Tokens: ${usage.input_tokens || '?'} in / ${usage.output_tokens || '?'} out.`);
  const summary = parsed._meta?.autoRefreshSummary;
  if (summary) log(`  Changes: ${summary}`);
}

main().catch(err => {
  console.error(`[macro_refresh] unexpected error: ${err.message}`);
  process.exitCode = 0;  // non-fatal on any path
});
