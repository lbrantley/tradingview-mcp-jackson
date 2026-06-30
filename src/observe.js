/**
 * Production observations log — append-only JSONL substrate.
 *
 * Scanner writes structured observations during its passes; development
 * (Claude in session) reads them to find leads on what to improve next.
 * This is the production → development feedback loop.
 *
 * Schema (one JSON object per line):
 *   {
 *     ts: ISO 8601 timestamp,
 *     type: 'stat_pattern' | 'op_health' | 'detection_anomaly',
 *     severity: 'info' | 'warn' | 'urgent',
 *     message: short human-readable description,
 *     data: arbitrary object with structured context
 *   }
 *
 * Categories:
 *   stat_pattern      — observations from audit log: "5/7 CAD shorts stopped"
 *   op_health         — runtime/timing/perf issues: "Phase 3b consistently >3min"
 *   detection_anomaly — scanner produced something suspicious: "ALL GREEN with null SL/TP"
 *
 * Severity:
 *   info   — interesting, worth knowing
 *   warn   — worth investigating in next dev session
 *   urgent — fires a Pushover; user should look soon
 *
 * Usage:
 *   import { observe } from './observe.js';
 *   observe({
 *     type: 'detection_anomaly',
 *     severity: 'warn',
 *     message: 'ALL GREEN fired without SL/TP levels',
 *     data: { symbol: 'CADJPY', alertType: 'CONTINUATION LONG', entry: 113.95 }
 *   });
 *
 * The file is tracked in git so observations sync from production (Azure VM)
 * back to the dev repo via periodic commit/push (see deploy notes).
 */
import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { notify } from './notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBS_LOG = join(__dirname, '..', 'observations.jsonl');

const VALID_TYPES = new Set(['stat_pattern', 'op_health', 'detection_anomaly']);
const VALID_SEVERITIES = new Set(['info', 'warn', 'urgent']);

export function observe({ type, severity = 'info', message, data = {} }) {
  if (!VALID_TYPES.has(type)) {
    console.error(`[observe] invalid type: ${type}`);
    return;
  }
  if (!VALID_SEVERITIES.has(severity)) {
    console.error(`[observe] invalid severity: ${severity}`);
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    type,
    severity,
    message: String(message || '').slice(0, 500),
    data,
  };
  try {
    appendFileSync(OBS_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error(`[observe] write failed: ${e.message}`);
  }
  // Urgent observations also page the user so they can look immediately.
  if (severity === 'urgent') {
    notify({
      title: `🔬 Production observation`,
      message: `${type}: ${message}`,
      priority: 1,
    });
  }
}
