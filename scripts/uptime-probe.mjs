#!/usr/bin/env node
/** Uptime probe: una misura ogni 15 min, storico 7 giorni su R2 stato/uptime/stato.json. */
import fs from 'node:fs';
import { leggiStato, pubblicaStato } from './stato-pubblica.mjs';
const BASE = process.env.BASE || 'https://careauctions.co';
const letto = await leggiStato('uptime/stato.json');
const storico = letto.ok && letto.json ? letto.json : { checks: [] };
const t0 = Date.now();
let status = 0, qa = null;
try {
  const r = await fetch(BASE + '/?uptime=' + Date.now(), { headers: { 'User-Agent': 'CARe-uptime/1.0' }, signal: AbortSignal.timeout(15000) });
  status = r.status;
} catch { status = 0; }
try {
  const r = await fetch(BASE + '/qa/stato.json?uptime=' + Date.now(), { headers: { 'User-Agent': 'CARe-uptime/1.0' }, signal: AbortSignal.timeout(10000) });
  if (r.ok) qa = await r.json();
} catch {}
const ms = Date.now() - t0;
const checks = [...(storico.checks || []), { ts: new Date().toISOString(), status, ms, qaHigh: qa?.summary?.high ?? null, qaCritical: qa?.summary?.critical ?? null }]
  .filter(c => Date.now() - new Date(c.ts).getTime() < 7 * 86400000).slice(-1000);
const out = { aggiornato: new Date().toISOString(), finestraGiorni: 7, checks };
fs.writeFileSync('/tmp/uptime-probe.json', JSON.stringify(out, null, 2) + '\n');
const res = await pubblicaStato('/tmp/uptime-probe.json', { chiave: 'uptime/stato.json', verifica: true });
console.log(JSON.stringify({ ok: true, status, ms, checks: checks.length, chiave: res.chiave }));
