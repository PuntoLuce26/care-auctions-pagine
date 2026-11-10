#!/usr/bin/env node
// Pubblica il report come issue GitHub (una sola issue QA aperta, aggiornata a ogni giro).
// Non applica patch: la patch sicura la propone la CI su un branch/PR.
import { readFileSync } from 'node:fs';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) { console.log('publish: GITHUB_TOKEN/GITHUB_REPOSITORY assenti, salto.'); process.exit(0); }

let report;
try { report = JSON.parse(readFileSync('qa/out/report.json', 'utf8')); }
catch (e) { console.log('publish: report non leggibile, salto.'); process.exit(0); }

const s = report.summary || {};
const critical = Number(s.critical || 0), high = Number(s.high || 0);
if (critical + high === 0) { console.log('publish: nessun critico/alto, nessuna issue.'); process.exit(0); }

const summary = (() => { try { return readFileSync('qa/out/summary.md', 'utf8'); } catch (e) { return ''; } })();
const proposals = (() => { try { return readFileSync('qa/out/fix-proposals.md', 'utf8'); } catch (e) { return ''; } })();
const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;
const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
const title = `[QA] ${date} — ${critical} critici, ${high} alti`;
const body = [
  `Report automatico del QA cloud: ${runUrl}`,
  '',
  `Build sito: \`${report.build?.sito || '?'}\` · origine: \`${report.build?.origine || '?'}\``,
  '',
  summary.slice(0, 45000),
  '',
  proposals.slice(0, 18000)
].join('\n');

const H = { Authorization: 'Bearer ' + token, 'User-Agent': 'CARe-QA', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
const api = `https://api.github.com/repos/${repo}`;

async function apiCall(path, opts = {}) {
  const r = await fetch(api + path, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}

const open = await apiCall('/issues?state=open&per_page=30');
if (!open.ok) { console.log('publish: lettura issue fallita', open.status); process.exit(0); }
const existing = (open.json || []).find(i => !i.pull_request && String(i.title || '').startsWith('[QA]'));
if (existing) {
  const c = await apiCall(`/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  console.log(c.ok ? `publish: commento aggiunto alla issue #${existing.number}` : `publish: commento fallito ${c.status}`);
} else {
  const c = await apiCall('/issues', { method: 'POST', body: JSON.stringify({ title, body }) });
  console.log(c.ok ? `publish: issue creata #${c.json?.number}` : `publish: creazione fallita ${c.status} ${c.text.slice(0, 160)}`);
}
