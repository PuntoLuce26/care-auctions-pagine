import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function writeJson(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function writeText(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, value, 'utf8');
}

export async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 25000),
    headers: {
      'User-Agent': opts.ua || 'CARe-QA/1.0 (+https://careauctions.co)',
      ...(opts.headers || {})
    }
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, headers: res.headers, text, url: res.url };
}

export async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, opts);
  let json = null;
  try { json = JSON.parse(r.text); } catch (e) {}
  return { ...r, json };
}

export function buildHash(html) {
  const m = String(html || '').match(/main\.[a-f0-9]{8}\.js/);
  return m ? m[0] : null;
}

export function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&egrave;/g, 'è')
    .replace(/&agrave;/g, 'à')
    .replace(/&igrave;/g, 'ì')
    .replace(/&ograve;/g, 'ò')
    .replace(/&ugrave;/g, 'ù')
    .replace(/&eacute;/g, 'é')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameOrigin(url, base) {
  try {
    return new URL(url, base).origin === new URL(base).origin;
  } catch (e) { return false; }
}

export function ageHours(iso) {
  const t = Date.parse(iso);
  if (!t) return null;
  return Math.round((Date.now() - t) / 36e5 * 10) / 10;
}

export function escMd(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function short(s, n = 180) {
  const v = String(s == null ? '' : s);
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

export function severityRank(s) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[s] ?? 9;
}

export function makeIssue({ severity, type, route = '', viewport = '', message, suggestion = '', source = '' }) {
  return { id: `${type}:${route}:${viewport}:${short(message, 60)}`, severity, type, route, viewport, message, suggestion, source };
}
