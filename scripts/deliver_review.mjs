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
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
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
const NEWS_CACHE = join(REPO, 'news_cache.json');
const NEWS_UPCOMING = join(REPO, 'news_upcoming.json');
const NEWS_UPCOMING_REL = 'news_upcoming.json';

// Log to a file as well as stdout. run_brief.sh created logs/ and captured
// stdout, but that wrapper is macOS-only (hardcoded path, bash, nvm) — on the
// Windows VM nothing captured output, so two days of git failures left no
// trace beyond a Pushover ping. Own the logging here so it works everywhere.
const LOG_DIR = join(REPO, 'logs');
const LOG_FILE = join(LOG_DIR, `review_${KIND}_${TODAY}.log`);
let logReady = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (!logReady) {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      logReady = true;
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Never let logging break the run.
  }
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

// Credential failures are terminal: every retry hits the same wall, and on a
// headless VM there is no terminal for git to prompt on. Git Credential
// Manager reports this as "failed to execute prompt script" followed by
// "could not read Username". Detect it so the run bails immediately with a
// message that names the fix instead of the symptom.
function isAuthFailure(stderr) {
  return /could not read (Username|Password)|Authentication failed|terminal prompts disabled|failed to execute prompt script|Permission denied \(publickey\)|could not read from remote repository/i
    .test(stderr || '');
}

const AUTH_HINT = 'GitHub credentials unavailable to the scheduled task. '
  + 'Fix on the VM: git config --global credential.helper store, then run one '
  + 'manual `git push` and enter a PAT as the password.';

// The scanner must stay paused through the git block, not just the review.
// On the Windows VM pauseScanner KILLS the scanner and resumeScanner spawns a
// fresh one, so resuming right after the review put a live scanner back in the
// same worktree while this script was mid stash/rebase/push. With
// AUTO_PUSH_ENABLED=1 that scanner runs its own git add/commit/push, which
// races two ways:
//   - it re-dirties the tree between our stash and our rebase, so the rebase
//     refuses with "cannot pull with rebase: You have unstaged changes"
//   - it lands a commit on origin/main between our pull and our push, so the
//     push is rejected non-fast-forward
// Both surfaced to the user as "push failed" while a manual push minutes later
// worked fine. Hold the pause until git is done.
let pauseCtx = null;
let resumed = false;
function resumeOnce() {
  if (resumed || !pauseCtx) return;
  resumed = true;
  resumeScanner(pauseCtx, { log });
}

async function main() {
  log(`Delivering ${KIND} review for ${TODAY}`);

  // Step 0: pull latest from GitHub BEFORE running the review, so any dev
  // updates to tracked files (especially market_context.json — the
  // MACRO CONTEXT source) actually take effect in today's brief.
  // Before this pull, macro updates I pushed from Mac between reviews
  // never propagated to the VM until user manually pulled. The stash-then-
  // pop protects any unstaged runtime files (scanner_audit.json changes,
  // etc.) that the running scanner might have touched between 5:00 AM
  // self-exit and 6:00 AM review start.
  log('Pulling latest from GitHub for fresh macro context...');
  const preStatus = run(`git status --porcelain`);
  const preHasUnstaged = !!(preStatus && preStatus.trim());
  let prePullStashed = false;
  if (preHasUnstaged) {
    log(`  stashing unstaged files before pull:\n${preStatus.trim()}`);
    const stashR = runVerbose(`git stash push --include-untracked --quiet -m "deliver_review pre-pull stash ${new Date().toISOString()}"`);
    prePullStashed = stashR.ok;
  }
  const prePullR = runVerbose('git pull --rebase origin main');
  if (!prePullR.ok) {
    log(`  ⚠  pre-pull failed (exit ${prePullR.exitCode}): ${prePullR.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    if (isAuthFailure(prePullR.stderr)) log(`  ⚠  ${AUTH_HINT}`);
    log(`  Continuing with existing local state — macro context may be stale.`);
  } else {
    log(`  ✅ pulled — market_context.json + any other dev updates are current`);
  }
  if (prePullStashed) {
    const popR = runVerbose(`git stash pop --quiet`);
    if (!popR.ok) log(`  ⚠  pre-pull stash pop failed: ${popR.stderr.trim().split('\n')[0]}`);
  }

  // Step 0b: auto-refresh market_context.json via Claude + web_search so
  // the MACRO CONTEXT block in today's brief reflects the highest-impact
  // themes RIGHT NOW, not a snapshot from whenever the dev last touched
  // the file. Non-fatal — logs on any failure and keeps existing content.
  // Track outcome for the Pushover notification so silent failures become
  // loud within seconds of the 6am run instead of being discovered days
  // later. (Aug 5-7 briefs had byte-identical macro before we noticed.)
  log('Auto-refreshing macro context (Claude + web_search)...');
  const macroOut = run('node scripts/refresh_macro_context.mjs', { timeout: 4 * 60 * 1000 });
  let macroStatus = null;
  if (macroOut) {
    for (const line of macroOut.split('\n')) {
      if (line.trim()) log(`  ${line}`);
    }
    if (macroOut.includes('✅ Refreshed')) macroStatus = 'refreshed';
    else if (macroOut.includes('Parse failed') || macroOut.includes('No JSON found')) macroStatus = 'parse_fail';
    else if (macroOut.includes('Shape validation failed')) macroStatus = 'shape_fail';
    else if (macroOut.includes('API call failed')) macroStatus = 'api_fail';
    else if (macroOut.includes('ANTHROPIC_API_KEY not set')) macroStatus = 'no_key';
    else if (macroOut.includes('MACRO_REFRESH_OFF=1')) macroStatus = 'disabled';
    else macroStatus = 'unknown';
  } else {
    macroStatus = 'no_output';  // script didn't produce stdout — either crashed or spawn failed
  }

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

  // Step 2-3: the legacy setup review. This shells out to scanner.mjs --review,
  // which drives TradingView over CDP. That scanner was retired on 2026-08-20
  // in favour of scan_live.mjs (OANDA HTTP, no desktop app), so on a machine
  // without TradingView running this only produces CDP errors.
  //
  // Skipped automatically when the audit has nothing left to review, so the
  // job stops needing TradingView the moment the last legacy setup expires.
  // BRIEF_SKIP_REVIEW=1 forces it off regardless.
  let reviewText = '';
  const forcedOff = process.env.BRIEF_SKIP_REVIEW === '1';
  let pendingCount = 0;
  try {
    const auditPath = join(REPO, 'scanner_audit.json');
    if (existsSync(auditPath)) {
      const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
      pendingCount = (audit.setups || []).filter(x => x.status === 'pending').length;
    }
  } catch { pendingCount = 0; }

  if (forcedOff || pendingCount === 0) {
    log(forcedOff
      ? 'BRIEF_SKIP_REVIEW=1 — skipping the legacy setup review (no TradingView needed)'
      : `No pending legacy setups — skipping the review (retired scanner, no TradingView needed)`);
    reviewText = `Legacy setup review skipped — the CDP scanner was retired 2026-08-20.\n` +
      `Live setups now come from scripts/scan_live.mjs (OANDA, no TradingView).\n` +
      (pendingCount ? `${pendingCount} legacy setup(s) still pending.\n` : '');
  } else {
    const scannerPid = findScannerPid();
    if (scannerPid) log(`Found running scanner: PID ${scannerPid}`);
    else log('No running scanner detected — proceeding without pause');
    pauseCtx = pauseScanner(scannerPid, { log, cwd: REPO });

    log(`Running scanner --review (${pendingCount} legacy setups still pending)...`);
    try {
      const result = spawnSync('node', ['scripts/scanner.mjs', '--review'], {
        cwd: REPO, encoding: 'utf8', timeout: 15 * 60 * 1000, env: process.env,
      });
      reviewText = (result.stdout || '') + (result.stderr ? '\n\nSTDERR:\n' + result.stderr : '');
      log(`Review captured: ${reviewText.length} bytes`);
    } catch (e) {
      resumeOnce();
      throw e;
    }
    // A short or failed review is no longer fatal — the macro refresh is the
    // part worth delivering, and aborting here threw away a good refresh
    // because a retired scanner could not reach a chart.
    if (reviewText.length < 100) {
      log('Review output empty or failed — continuing with macro context only');
      reviewText = 'Legacy setup review failed (CDP/TradingView unavailable). Macro context below is current.';
    }
  }

  // Step 5: write to briefs/
  if (!existsSync(BRIEFS)) mkdirSync(BRIEFS, { recursive: true });
  const header = `# Scanner Review — ${TODAY} (${KIND})\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`\n`;
  const footer = '\n```\n';
  writeFileSync(OUT_FILE, header + reviewText + footer);
  log(`Wrote ${OUT_FILE}`);

  // Step 5b: write a trimmed news_upcoming.json (next 72h high+medium impact)
  // for dev-session use. news_cache.json is gitignored (large, noisy diffs),
  // so this small git-tracked snapshot lets Claude Code see the current
  // calendar without needing screenshots. Non-fatal on failure.
  try {
    if (existsSync(NEWS_CACHE)) {
      const cache = JSON.parse(readFileSync(NEWS_CACHE, 'utf8'));
      const now = Date.now();
      const horizon = now + 72 * 3600 * 1000;
      const upcoming = (cache.events || [])
        .filter(e => {
          const t = new Date(e.date).getTime();
          return t >= now && t <= horizon;
        })
        .filter(e => e.impact === 'High' || e.impact === 'Medium')
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map(e => ({
          date: e.date,
          currency: e.currency,
          impact: e.impact,
          title: e.title,
          forecast: e.forecast ?? null,
          previous: e.previous ?? null,
          affectedPairs: e.affectedPairs || [],
        }));
      const out = {
        generatedAt: new Date().toISOString(),
        horizonHours: 72,
        sourceCacheAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
        count: upcoming.length,
        events: upcoming,
      };
      writeFileSync(NEWS_UPCOMING, JSON.stringify(out, null, 2));
      log(`Wrote ${NEWS_UPCOMING} (${upcoming.length} events, next 72h)`);
    } else {
      log('news_cache.json not found — skipping news_upcoming write');
    }
  } catch (e) {
    log(`news_upcoming write failed (non-fatal): ${e.message}`);
  }

  // Step 6: git commit + push
  // Pull-rebase before push so we reconcile with anything the dev pushed
  // from the Mac between reviews. Silent-push-fail was hiding this — now
  // any git failure fires a Pushover so we hear about it immediately.
  const doPush = process.env.BRIEF_GIT_PUSH !== '0';
  let gitError = null;
  let authFailed = false;
  if (doPush) {
    log('Committing + pushing to GitHub...');
    run(`git add ${OUT_REL_PATH}`);
    if (existsSync(NEWS_UPCOMING)) run(`git add ${NEWS_UPCOMING_REL}`);
    // Also stage runtime files the scanner just wrote to, otherwise the
    // subsequent `git pull --rebase` refuses ("cannot pull with rebase: You
    // have unstaged changes"). These are tracked files that legitimately
    // move as part of every review pass — bundling them into the review
    // commit is the correct behavior anyway.
    for (const f of ['brief_data.json', 'observations.jsonl', 'market_context.json']) {
      if (existsSync(join(REPO, f))) run(`git add ${f}`);
    }
    const status = run(`git diff --cached --name-only`);
    if (status && status.trim()) {
      const msg = `review: ${KIND} @ ${TODAY}`;
      const commitR = runVerbose(`git commit -m "${msg}" --quiet`);
      if (!commitR.ok) {
        gitError = `git commit failed (exit ${commitR.exitCode}): ${commitR.stderr.trim().split('\n')[0]}`;
        log(`  ❌ ${gitError}`);
      } else {
        // Safety net: if any files are STILL unstaged after our explicit
        // git adds above, stash them so pull --rebase doesn't refuse. Any
        // stashed changes get restored after the rebase completes. Rare in
        // practice — the explicit adds cover the known runtime files —
        // but this handles unexpected scanner state or manual VM edits.
        const dirty = run(`git status --porcelain`);
        const hasUnstaged = !!(dirty && dirty.trim());
        let stashed = false;
        if (hasUnstaged) {
          log(`  ⚠  unstaged files present, stashing before rebase:\n${dirty.trim()}`);
          const stashR = runVerbose(`git stash push --include-untracked --quiet -m "deliver_review auto-stash ${new Date().toISOString()}"`);
          stashed = stashR.ok;
        }
        // Rebase-pull then push, retried as a pair. The Mac and the VM both
        // push main, so a commit can land in the window between our pull and
        // our push and reject it non-fast-forward. Re-pulling picks that
        // commit up and the next push goes through, instead of failing the
        // whole run over a few seconds of contention.
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          gitError = null;
          const pullR = runVerbose('git pull --rebase origin main');
          if (!pullR.ok) {
            gitError = `git pull --rebase failed (exit ${pullR.exitCode}): ${pullR.stderr.trim().split('\n').slice(-2).join(' | ')}`;
            log(`  ❌ attempt ${attempt}/${MAX_ATTEMPTS}: ${gitError}`);
            if (isAuthFailure(pullR.stderr)) { authFailed = true; log(`  ⚠  ${AUTH_HINT}`); }
            break;  // a refused/conflicted rebase won't resolve by retrying
          }
          const pushR = runVerbose('git push origin main');
          if (pushR.ok) {
            log(`  ✅ pushed${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
            break;
          }
          gitError = `git push failed (exit ${pushR.exitCode}): ${pushR.stderr.trim().split('\n').slice(-2).join(' | ')}`;
          log(`  ❌ attempt ${attempt}/${MAX_ATTEMPTS}: ${gitError}`);
          // No credentials means all three attempts fail identically. Stop.
          if (isAuthFailure(pushR.stderr)) { authFailed = true; log(`  ⚠  ${AUTH_HINT}`); break; }
        }
        // Restore any stashed changes so the scanner sees consistent state.
        if (stashed) {
          const popR = runVerbose(`git stash pop --quiet`);
          if (!popR.ok) {
            log(`  ⚠  stash pop failed (${popR.exitCode}) — check stash list manually. stderr: ${popR.stderr.trim().split('\n')[0]}`);
          }
        }
      }
    } else {
      log('  nothing to commit');
    }
  } else {
    log('BRIEF_GIT_PUSH=0 — skipping commit + push');
  }

  // Step 6b: git is done — safe to bring the scanner back now, before the
  // Pushover network call. This is the step that used to happen right after
  // the review, which is what created the race above.
  resumeOnce();

  // Step 7: send Pushover with URL
  const { summary, gradeLine } = extractSummary(reviewText);
  const url = `https://github.com/lbrantley/tradingview-mcp-jackson/blob/main/${OUT_REL_PATH}`;
  // Name the step that actually failed. This read "GIT PUSH FAILED" for any
  // git error, so a refused rebase was reported to the phone as a push
  // failure — which sent the 2026-08-13/14 diagnosis down the wrong path.
  // An auth failure is a different problem from a failed push and needs a
  // different response from the user, so it gets its own headline rather than
  // being reported as whichever git verb happened to hit the wall.
  const gitStep = authFailed
    ? 'GITHUB AUTH'
    : (gitError ? (gitError.split(' failed')[0] || 'git').toUpperCase() : null);
  const title = gitError
    ? `⚠️ ${KIND === 'weekly' ? 'Weekly' : 'Daily'} review — ${gitStep} FAILED (${TODAY})`
    : (KIND === 'weekly' ? `📊 Weekly review — ${TODAY}` : `🔍 Daily review — ${TODAY}`);
  const messageParts = [summary, gradeLine];
  // Macro refresh outcome — makes silent failures loud on the phone.
  const macroBadge = {
    refreshed: '🌐 Macro: fresh',
    parse_fail: '🌐 Macro: ⚠️ parse-fail (stale)',
    shape_fail: '🌐 Macro: ⚠️ shape-fail (stale)',
    api_fail: '🌐 Macro: ⚠️ API-fail (stale)',
    no_key: '🌐 Macro: ⚠️ no API key (stale)',
    no_output: '🌐 Macro: ⚠️ no output (stale)',
    unknown: '🌐 Macro: ⚠️ unknown result (stale)',
    disabled: '🌐 Macro: off (env)',
  }[macroStatus] || null;
  if (macroBadge) messageParts.push(macroBadge);
  if (gitError) {
    messageParts.push(`❌ ${gitError}`);
    if (authFailed) messageParts.push(`🔑 ${AUTH_HINT}`);
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

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  // Backstop: never leave the VM without a scanner. On Windows pauseScanner
  // killed it, so a throw anywhere between pause and Step 6b would otherwise
  // mean no scanner until the next manual start. No-op if already resumed.
  .finally(resumeOnce);
