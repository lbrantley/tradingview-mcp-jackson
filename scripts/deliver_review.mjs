#!/usr/bin/env node
/**
 * Deliver the scanner's --review output as a daily/weekly brief.
 *
 * Flow:
 *   1. Prune news_overrides.json (drop FF-cache dupes and past-stale entries)
 *   2. Pause the running scanner via SIGSTOP (avoids CDP contention)
 *   3. Run `node scripts/scanner.mjs --review` and capture output
 *   4. Resume scanner via SIGCONT
 *   5. Save output to briefs/YYYY-MM-DD-review.md
 *   6. Commit + push to GitHub
 *   7. Send Pushover ping with the GitHub URL to the file
 *
 * Replaces src/generate_brief.mjs (LLM-based synthesis). User preferred the
 * deterministic --review output over the LLM synthesis.
 *
 * Usage: node scripts/deliver_review.mjs [daily|weekly]
 * Default: daily
 *
 * Required env: PUSHOVER_TOKEN, PUSHOVER_USER
 * Optional env: BRIEF_GIT_PUSH=0 to skip the git push
 */
import 'dotenv/config';
import { execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { findScannerPid, pauseScanner, resumeScanner } from '../src/process_control.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const BRIEFS = join(REPO, 'briefs');
const KIND = (process.argv[2] || 'daily').toLowerCase();
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_FILE = join(BRIEFS, `${TODAY}-${KIND}-review.md`);
const OUT_REL_PATH = `briefs/${TODAY}-${KIND}-review.md`;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: REPO, stdio: 'pipe', ...opts }).toString();
  } catch (e) {
    return null;
  }
}

// Same as run() but surfaces errors instead of swallowing them. Use for git
// operations where a silent failure is unacceptable (push, rebase, commit).
// Returns { ok, stdout, stderr, exitCode }.
function runVerbose(cmd, opts = {}) {
  try {
    const out = execSync(cmd, { cwd: REPO, stdio: 'pipe', ...opts }).toString();
    return { ok: true, stdout: out, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : (e.message || 'unknown error'),
      exitCode: e.status ?? -1,
    };
  }
}

// findScannerPid / pauseScanner / resumeScanner are imported from
// src/process_control.js — they're cross-platform (SIGSTOP on Unix,
// kill+detached-restart on Windows since Windows lacks SIGSTOP).

// Extract a tight summary (title + up to ~4 lines) from the review output for
// the Pushover body. Keys off known section anchors in the review format.
function extractSummary(reviewText) {
  const lines = reviewText.split('\n');
  const momentum = lines.filter(l => l.includes('🚀 MOMENTUM ALERT'));
  const tp1 = lines.filter(l => /TP\d HIT/.test(l));
  const stopped = lines.filter(l => /STOPPED at/.test(l));
  const expired = lines.filter(l => l.includes('expired ('));
  const health = lines.find(l => l.includes('Win Rate:')) || '';
  const grade = (health.match(/Grade: (.+?)(?:$|\s{2})/) || [])[1] || '';

  const parts = [];
  if (momentum.length) parts.push(`🚀 ${momentum.length} momentum alert${momentum.length > 1 ? 's' : ''}`);
  if (tp1.length) parts.push(`✅ ${tp1.length} TP hit${tp1.length > 1 ? 's' : ''}`);
  if (stopped.length) parts.push(`❌ ${stopped.length} stopped`);
  if (expired.length) parts.push(`⏱ ${expired.length} expired`);
  if (parts.length === 0) parts.push('No transitions');
  const summary = parts.join(' · ');
  const gradeLine = grade ? `Health: ${grade}` : '';
  return { summary, gradeLine, counts: { momentum: momentum.length, tp: tp1.length, stopped: stopped.length, expired: expired.length } };
}

async function sendPushover({ title, message, url, url_title }) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) {
    log('Pushover disabled: token/user not set');
    return { skipped: true };
  }
  const body = new URLSearchParams({
    token, user,
    message: String(message).slice(0, 1024),
    title: String(title).slice(0, 250),
    priority: '0',
  });
  if (url) body.set('url', url);
  if (url_title) body.set('url_title', url_title);
  const bodyStr = body.toString();
  return new Promise(resolve => {
    const req = https.request({
      method: 'POST',
      hostname: 'api.pushover.net',
      path: '/1/messages.json',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', err => resolve({ error: err.message }));
    req.write(bodyStr);
    req.end();
  });
}

async function main() {
  log(`Delivering ${KIND} review for ${TODAY}`);

  // Step 1: prune stale overrides
  log('Pruning news_overrides.json...');
  const pruneOut = run('node scripts/prune_news_overrides.mjs');
  if (pruneOut) {
    for (const line of pruneOut.split('\n')) {
      if (line.trim()) log(`  ${line}`);
    }
  }

  // Step 1b: refresh currency index cache so the review has fresh backdrop
  log('Refreshing currency index cache...');
  const idxOut = run('node scripts/refresh_currency_indices.mjs', { timeout: 3 * 60 * 1000 });
  if (idxOut) {
    for (const line of idxOut.split('\n')) {
      if (line.trim()) log(`  ${line}`);
    }
  }

  // Step 2: find scanner, pause it
  const scannerPid = findScannerPid();
  if (scannerPid) log(`Found running scanner: PID ${scannerPid}`);
  else log('No running scanner detected — proceeding without pause');
  const pauseCtx = pauseScanner(scannerPid, { log, cwd: REPO });

  // Step 3: run review, capture output
  let reviewText = '';
  try {
    log('Running scanner --review...');
    const result = spawnSync('node', ['scripts/scanner.mjs', '--review'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 15 * 60 * 1000, // 15 min max
      env: process.env,
    });
    reviewText = (result.stdout || '') + (result.stderr ? '\n\nSTDERR:\n' + result.stderr : '');
    log(`Review captured: ${reviewText.length} bytes`);
  } finally {
    // Step 4: always resume scanner even if review failed
    resumeScanner(pauseCtx, { log });
  }

  if (reviewText.length < 100) {
    log('Review output looks empty — aborting');
    process.exit(1);
  }

  // Step 5: write to briefs/
  if (!existsSync(BRIEFS)) mkdirSync(BRIEFS, { recursive: true });
  const header = `# Scanner Review — ${TODAY} (${KIND})\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`\n`;
  const footer = '\n```\n';
  writeFileSync(OUT_FILE, header + reviewText + footer);
  log(`Wrote ${OUT_FILE}`);

  // Step 6: git commit + push
  // Pull-rebase before push so we reconcile with anything the dev pushed
  // from the Mac between reviews. Silent-push-fail was hiding this — now
  // any git failure fires a Pushover so we hear about it immediately.
  const doPush = process.env.BRIEF_GIT_PUSH !== '0';
  let gitError = null;
  if (doPush) {
    log('Committing + pushing to GitHub...');
    run(`git add ${OUT_REL_PATH}`);
    const status = run(`git diff --cached --name-only`);
    if (status && status.trim()) {
      const msg = `review: ${KIND} @ ${TODAY}`;
      const commitR = runVerbose(`git commit -m "${msg}" --quiet`);
      if (!commitR.ok) {
        gitError = `git commit failed (exit ${commitR.exitCode}): ${commitR.stderr.trim().split('\n')[0]}`;
        log(`  ❌ ${gitError}`);
      } else {
        // Rebase-pull so remote's newer commits don't reject our push.
        const pullR = runVerbose('git pull --rebase origin main');
        if (!pullR.ok) {
          gitError = `git pull --rebase failed (exit ${pullR.exitCode}): ${pullR.stderr.trim().split('\n').slice(-2).join(' | ')}`;
          log(`  ❌ ${gitError}`);
        } else {
          const pushR = runVerbose('git push origin main');
          if (!pushR.ok) {
            gitError = `git push failed (exit ${pushR.exitCode}): ${pushR.stderr.trim().split('\n').slice(-2).join(' | ')}`;
            log(`  ❌ ${gitError}`);
          } else {
            log('  ✅ pushed');
          }
        }
      }
    } else {
      log('  nothing to commit');
    }
  } else {
    log('BRIEF_GIT_PUSH=0 — skipping commit + push');
  }

  // Step 7: send Pushover with URL
  const { summary, gradeLine } = extractSummary(reviewText);
  const url = `https://github.com/lbrantley/tradingview-mcp-jackson/blob/main/${OUT_REL_PATH}`;
  const title = gitError
    ? `⚠️ ${KIND === 'weekly' ? 'Weekly' : 'Daily'} review — GIT PUSH FAILED (${TODAY})`
    : (KIND === 'weekly' ? `📊 Weekly review — ${TODAY}` : `🔍 Daily review — ${TODAY}`);
  const messageParts = [summary, gradeLine];
  if (gitError) {
    messageParts.push(`❌ ${gitError}`);
    messageParts.push(`File written locally on VM at briefs/${TODAY}-${KIND}-review.md — SSH in and push manually.`);
  } else {
    messageParts.push('Tap to open full review.');
  }
  const message = messageParts.filter(Boolean).join('\n');
  log('Sending Pushover...');
  const result = await sendPushover({
    title,
    message,
    url: gitError ? undefined : url,
    url_title: gitError ? undefined : 'Open review on GitHub',
  });
  log(`  ${JSON.stringify(result)}`);

  log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
