#!/usr/bin/env node
/**
 * Local brief generator — Anthropic API-backed replacement for the
 * /schedule cloud routine that never produced visible output.
 *
 * Usage:
 *   node src/generate_brief.mjs daily
 *   node src/generate_brief.mjs weekly
 *
 * Reads scanner state (brief_data.json, observations.jsonl,
 * news_overrides.json, memory dir, yesterday's brief), calls the
 * Claude API to synthesize a markdown brief, writes it to briefs/,
 * commits + pushes, and sends a Pushover summary.
 *
 * Env (via .env):
 *   ANTHROPIC_API_KEY  — required. From console.anthropic.com.
 *   ANTHROPIC_MODEL    — optional. Default: claude-sonnet-4-6.
 *   PUSHOVER_TOKEN     — required for delivery
 *   PUSHOVER_USER      — required for delivery
 *   BRIEF_GIT_PUSH     — set to "0" to skip auto-commit+push (dev). Default on.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { notify } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BRIEFS_DIR = join(ROOT, 'briefs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const AUTO_PUSH = process.env.BRIEF_GIT_PUSH !== '0';

function readIfExists(path, maxBytes = 200_000) {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path, 'utf8');
    return buf.length > maxBytes ? buf.slice(-maxBytes) : buf;
  } catch { return null; }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function loadContext() {
  const briefData = readIfExists(join(ROOT, 'brief_data.json'));
  const observations = readIfExists(join(ROOT, 'observations.jsonl'));
  const newsOverrides = readIfExists(join(ROOT, 'news_overrides.json'));
  const claudeMd = readIfExists(join(ROOT, 'CLAUDE.md'));

  // Latest prior brief for continuity
  let latestPriorBrief = null;
  if (existsSync(BRIEFS_DIR)) {
    const files = readdirSync(BRIEFS_DIR).filter(f => f.endsWith('.md')).sort();
    if (files.length > 0) {
      latestPriorBrief = { name: files[files.length - 1], body: readIfExists(join(BRIEFS_DIR, files[files.length - 1])) };
    }
  }
  return { briefData, observations, newsOverrides, claudeMd, latestPriorBrief };
}

const DAILY_PROMPT = `You are delivering a daily pre-session forex trading brief for the user.

CONTEXT FILES (below) contain:
- brief_data.json — pre-aggregated scanner stats (PRIMARY source)
- observations.jsonl — production observations logged this week
- news_overrides.json — upcoming high-impact economic events
- Yesterday's brief — for continuity
- CLAUDE.md — project context

Generate a daily brief with these sections:

1. **Lead paragraph** — Anything actionable RIGHT NOW (open trade near SL/TP, news <4h, fresh momentum). Skip if genuinely quiet.
2. **Last 24h scorecard** — From brief_data.json last24h: W/L/E, win rate, biggest winner/loser, notable moves.
3. **Open positions snapshot** — For each entry in openPositions[] with a notable P/L (±20p or more) or news exposure in next 24h: symbol, direction, P/L, MFE/MAE, distance to SL/TP1, tp3Trailing flag. Group by working / underwater / watch-list.
4. **Today's news risk (next 24h)** — Filter news_overrides for high/medium events on currencies of open positions. Mark each tailwind/headwind.
5. **New setups & momentum since yesterday** — Any 🚀 momentum alerts, ALL GREEN setups, or detection anomalies from observations.jsonl in last 24h.
6. **Recommended focus** — Top 2-4 pairs/setups to watch today, with the reason not just the level.

STYLE:
- Concise: under 600 words total
- Lead with what changed and what's actionable
- Markdown formatting
- Frame as an analyst partner giving a pre-session briefing, not a robot listing data
- If a position has sl:null, flag it explicitly — this is a known scanner gap

OUTPUT: Only the markdown body of the brief. No preamble, no code fences around the whole thing, no "Here is your brief:" text. Start directly with a heading.`;

const WEEKLY_PROMPT = `You are delivering a weekly trading brief for the user.

CONTEXT FILES contain the same scanner state as the daily brief.

Generate a weekly brief with:

1. **Last week's scorecard** — W/L/E across the full week, win rate, top pair by pips, worst pair, best setup type from perfByType, expected value per trade if computable.
2. **Open positions carried in** — For each in openPositions[]: symbol, direction, P/L, MFE/MAE, distance to SL/TP1, news risk in next 7d.
3. **Next week's news map** — Group high/medium events by currency for the next 7 days. Mark tailwind/headwind vs open positions. Flag clusters (NFP weeks, FOMC, CPI back-to-backs, central bank decisions).
4. **Macro lens** — What changed in HTF positioning last week. Currencies dominating strength. Pairs that flipped bias. Setup types that paid vs failed.
5. **Production observations** — Anything new in observations.jsonl. Group by detection_anomaly (bugs to fix), op_health (perf concerns), stat_pattern (data-driven insights). Rank by severity (urgent > warn > info).
6. **Recommended focus** — Top 3-5 pairs/setups for the coming week, with the reason.

STYLE:
- Under 1500 words
- Lead with what changed, not what is
- Analyst voice, not report
- Markdown

OUTPUT: Only the markdown body. Start directly with a heading.`;

function buildUserMessage(context, cadence) {
  const parts = [];
  parts.push(`Today (UTC): ${new Date().toISOString()}`);
  parts.push(`Cadence: ${cadence}`);
  parts.push('');
  if (context.claudeMd) {
    parts.push('=== CLAUDE.md ===');
    parts.push(context.claudeMd);
    parts.push('');
  }
  if (context.briefData) {
    parts.push('=== brief_data.json ===');
    parts.push(context.briefData);
    parts.push('');
  }
  if (context.observations) {
    parts.push('=== observations.jsonl ===');
    parts.push(context.observations);
    parts.push('');
  }
  if (context.newsOverrides) {
    parts.push('=== news_overrides.json ===');
    parts.push(context.newsOverrides);
    parts.push('');
  }
  if (context.latestPriorBrief) {
    parts.push(`=== previous brief (${context.latestPriorBrief.name}) ===`);
    parts.push(context.latestPriorBrief.body);
    parts.push('');
  }
  return parts.join('\n');
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
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty content from Anthropic API');
  return { text, usage: data.usage };
}

async function extractSummary(brief, cadence) {
  // Tight summary for Pushover — reuse the API but with a much smaller prompt.
  const prompt = `Extract a Pushover-friendly summary from this ${cadence} trading brief.
Under 4 short lines. Lead with anything actionable RIGHT NOW. Include the biggest number(s).
No greetings, no signoffs. Just the message body.

BRIEF:
${brief}`;
  const { text } = await callAnthropic(
    'You produce ultra-concise Pushover message bodies.',
    prompt,
  );
  return text.trim().slice(0, 900);
}

function commitAndPush(briefPath, cadence, date) {
  try {
    execSync(`git add "${briefPath}" 2>/dev/null`, { stdio: 'pipe', cwd: ROOT });
    const status = execSync('git diff --cached --name-only', { stdio: 'pipe', cwd: ROOT }).toString().trim();
    if (!status) return { pushed: false, reason: 'no_changes' };
    execSync(`git commit -m "brief: ${cadence} @ ${date}" --quiet`, { stdio: 'pipe', cwd: ROOT });
    execSync('git push origin main --quiet', { stdio: 'pipe', cwd: ROOT });
    return { pushed: true };
  } catch (e) {
    return { pushed: false, error: e.message.split('\n')[0] };
  }
}

async function main() {
  const cadence = process.argv[2] || 'daily';
  if (cadence !== 'daily' && cadence !== 'weekly') {
    console.error('Usage: node src/generate_brief.mjs [daily|weekly]');
    process.exit(2);
  }
  if (!existsSync(BRIEFS_DIR)) mkdirSync(BRIEFS_DIR, { recursive: true });

  console.log(`[${new Date().toISOString()}] Generating ${cadence} brief...`);
  const context = loadContext();
  const systemPrompt = cadence === 'daily' ? DAILY_PROMPT : WEEKLY_PROMPT;
  const userMessage = buildUserMessage(context, cadence);
  console.log(`  Context: brief_data=${!!context.briefData}, obs=${!!context.observations}, news=${!!context.newsOverrides}, prior=${!!context.latestPriorBrief}`);

  const { text: briefText, usage } = await callAnthropic(systemPrompt, userMessage);
  console.log(`  Anthropic usage: input=${usage.input_tokens} output=${usage.output_tokens}`);

  const date = todayUTC();
  const briefPath = join(BRIEFS_DIR, `${date}-${cadence}.md`);
  writeFileSync(briefPath, briefText);
  console.log(`  Written: ${briefPath}`);

  let pushInfo = { pushed: false };
  if (AUTO_PUSH) {
    pushInfo = commitAndPush(briefPath, cadence, date);
    console.log(`  Git: ${pushInfo.pushed ? 'pushed' : `skipped (${pushInfo.reason || pushInfo.error})`}`);
  }

  const summary = await extractSummary(briefText, cadence);
  const title = cadence === 'daily'
    ? `📊 Daily brief — ${date}`
    : `📊 Weekly brief — week of ${date}`;
  const pushoverResult = await notify({ title, message: summary, priority: 0 });
  console.log(`  Pushover: ${JSON.stringify(pushoverResult).slice(0, 200)}`);
  console.log(`[${new Date().toISOString()}] Done.`);
}

main().catch(err => {
  console.error(`[generate_brief] fatal: ${err.message}`);
  // Best-effort Pushover ping so failures are visible on the phone.
  notify({
    title: '⚠️ Brief generation failed',
    message: err.message.slice(0, 500),
    priority: 1,
  }).finally(() => process.exit(1));
});
