#!/usr/bin/env node
/**
 * GREEN2+ v1 — verificatore indipendente anti-invenzione.
 * Contratto: node green2-plus.mjs <claims.json>; exit 0 PASS, 2 FAIL.
 * Ogni numero deve avere valore, fonte https e data di misura. I non misurati si dichiarano.
 */
import fs from 'node:fs';
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('GREEN2+: claims mancanti'); process.exit(2); }
let d; try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('GREEN2+: JSON non valido'); process.exit(2); }
const claims = Array.isArray(d.claim) ? d.claim : [];
const checks = [];
checks.push({ nome: 'almeno un claim', ok: claims.length > 0 });
for (const [i, c] of claims.entries()) {
  const n = c.id || ('claim-' + (i + 1));
  checks.push({ nome: n + ': valore', ok: c.valore != null && String(c.valore).trim() !== '' });
  checks.push({ nome: n + ': fonte https', ok: typeof c.fonte === 'string' && /^https:\/\/\S+$/i.test(c.fonte) });
  checks.push({ nome: n + ': data misura', ok: typeof c.misurato === 'string' && !Number.isNaN(new Date(c.misurato).getTime()) });
}
checks.push({ nome: 'non_misurate dichiarate', ok: Array.isArray(d.nonMisurate) });
// Anti-invenzione: una fonte dichiarata deve rispondere (HEAD o GET), non basta il testo.
for (const c of claims.slice(0, 5)) {
  if (!/^https:\/\//i.test(String(c.fonte || ''))) continue;
  try {
    const r = await fetch(c.fonte, { method: 'GET', headers: { 'User-Agent': 'CARe-GREEN2/1.0', Range: 'bytes=0-200' }, signal: AbortSignal.timeout(10000) });
    checks.push({ nome: (c.id || 'claim') + ': fonte raggiungibile', ok: r.status >= 200 && r.status < 400 });
  } catch { checks.push({ nome: (c.id || 'claim') + ': fonte raggiungibile', ok: false }); }
}
const verdetto = checks.every(c => c.ok) ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ gate: 'GREEN2+', claims: claims.length, checks, verdetto }, null, 2));
process.exit(verdetto === 'PASS' ? 0 : 2);
