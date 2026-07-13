/**
 * Cross-platform helpers for finding the running scanner and pausing/resuming
 * it around CDP-sensitive operations (reviews, currency index refresh).
 *
 * On Unix (macOS, Linux) — uses SIGSTOP / SIGCONT to actually pause the process.
 * On Windows — SIGSTOP doesn't exist, so we kill the scanner and the caller
 * restarts it via a fresh detached spawn. Downtime is ~30 sec of scanner
 * startup instead of a truly transparent pause, but the CDP contention is
 * avoided just the same.
 */
import { execSync, spawn } from 'child_process';

const IS_WIN = process.platform === 'win32';

/**
 * Find the PID of the running continuous scanner, or null if none is found.
 * Excludes deliver_review, prune_news, refresh_currency_indices helper processes.
 */
export function findScannerPid() {
  if (IS_WIN) {
    // Windows: use CIM to query processes with their command lines
    try {
      const psScript = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'scripts.\\\\scanner.mjs' -and $_.CommandLine -notmatch 'deliver_review|prune_news|refresh_currency' } | Select-Object -First 1 -ExpandProperty ProcessId";
      const out = execSync(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const pid = parseInt(out.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  } else {
    // Unix: use ps aux + grep
    try {
      const out = execSync('ps aux | grep "node scripts/scanner.mjs" | grep -v grep | grep -v deliver_review | grep -v prune_news | grep -v refresh_currency', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = out.split('\n').filter(l => /node scripts\/scanner\.mjs$/.test(l.trim()));
      if (lines.length === 0) return null;
      const parts = lines[0].trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }
}

/**
 * Pause the scanner. On Unix this actually suspends the process; on Windows
 * this kills it (caller must call resumeScanner to spawn a fresh one).
 *
 * Returns an opaque "pause context" that resumeScanner needs to know how to
 * restore. The caller shouldn't inspect it.
 */
export function pauseScanner(pid, opts = {}) {
  const log = opts.log || (() => {});
  const cwd = opts.cwd || process.cwd();
  if (!pid) return { pid: null, wasKilled: false };
  if (IS_WIN) {
    log(`Killing scanner PID ${pid} (Windows can't SIGSTOP; will spawn fresh scanner on resume)`);
    try { process.kill(pid); } catch (e) { log(`  kill failed: ${e.message}`); }
    return { pid, wasKilled: true, cwd };
  } else {
    log(`Pausing scanner PID ${pid} (SIGSTOP)`);
    try { process.kill(pid, 'SIGSTOP'); } catch (e) { log(`  pause failed: ${e.message}`); }
    return { pid, wasKilled: false, cwd };
  }
}

/**
 * Resume the scanner. On Unix this sends SIGCONT to the same process; on
 * Windows this spawns a fresh detached scanner (because pauseScanner killed
 * the previous one).
 */
export function resumeScanner(ctx, opts = {}) {
  const log = opts.log || (() => {});
  if (!ctx || !ctx.pid) return;
  if (ctx.wasKilled) {
    log(`Restarting scanner (Windows) as detached background process`);
    try {
      const child = spawn('node', ['scripts/scanner.mjs'], {
        cwd: ctx.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      log(`  new scanner PID: ${child.pid}`);
    } catch (e) {
      log(`  restart failed: ${e.message}`);
    }
  } else {
    log(`Resuming scanner PID ${ctx.pid} (SIGCONT)`);
    try { process.kill(ctx.pid, 'SIGCONT'); } catch (e) { log(`  resume failed: ${e.message}`); }
  }
}
