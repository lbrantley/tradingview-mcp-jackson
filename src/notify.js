/**
 * Pushover notification helper.
 *
 * Reads PUSHOVER_TOKEN, PUSHOVER_USER, PUSHOVER_ENABLED from .env.
 * Fire-and-forget: never throws, logs failures to stderr.
 *
 * Usage:
 *   import { notify, notifyOnce } from './notify.js';
 *   notify({ title: 'TP1 hit', message: 'USDJPY +75p', priority: 0 });
 *   notifyOnce('USDJPY:REV_SHORT:ALL_GREEN', { ... });  // dedupes via cache file
 */
import 'dotenv/config';
import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTIFY_CACHE = join(__dirname, '..', 'notification_cache.json');

const ENABLED = process.env.PUSHOVER_ENABLED === '1';
const TOKEN = process.env.PUSHOVER_TOKEN || '';
const USER = process.env.PUSHOVER_USER || '';

function loadCache() {
  if (!existsSync(NOTIFY_CACHE)) return {};
  try { return JSON.parse(readFileSync(NOTIFY_CACHE, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  try { writeFileSync(NOTIFY_CACHE, JSON.stringify(cache, null, 2)); }
  catch { /* ignore */ }
}

export function notify({ title, message, priority = 0, url, url_title, sound }) {
  if (!ENABLED) return Promise.resolve({ skipped: 'disabled' });
  if (!TOKEN || !USER) {
    console.error('[notify] PUSHOVER_TOKEN/PUSHOVER_USER missing — skipping');
    return Promise.resolve({ skipped: 'no_creds' });
  }
  const payload = new URLSearchParams({ token: TOKEN, user: USER, message: String(message || '').slice(0, 1024) });
  if (title) payload.set('title', String(title).slice(0, 250));
  if (priority) payload.set('priority', String(priority));
  if (url) payload.set('url', String(url));
  if (url_title) payload.set('url_title', String(url_title));
  if (sound) payload.set('sound', String(sound));
  const body = payload.toString();
  return new Promise(resolve => {
    const req = https.request({
      method: 'POST',
      hostname: 'api.pushover.net',
      path: '/1/messages.json',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) console.error(`[notify] ${res.statusCode}: ${data}`);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', err => {
      console.error(`[notify] error: ${err.message}`);
      resolve({ error: err.message });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Send a notification only if `key` hasn't been sent within `cooldownMs`.
 * Used to prevent the same condition from spamming on repeated scans.
 */
export function notifyOnce(key, opts, cooldownMs = 4 * 3600 * 1000) {
  if (!ENABLED) return Promise.resolve({ skipped: 'disabled' });
  const cache = loadCache();
  const last = cache[key];
  if (last && Date.now() - last < cooldownMs) {
    return Promise.resolve({ skipped: 'cooldown', lastSent: new Date(last).toISOString() });
  }
  cache[key] = Date.now();
  saveCache(cache);
  return notify(opts);
}
