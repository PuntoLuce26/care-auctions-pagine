#!/usr/bin/env node
/**
 * EINSTEIN+ v1 — gate del brief, prima di far lavorare il branco.
 * Contratto: node einstein-plus.mjs <brief.json>; exit 0 PASS, 2 FAIL.
 * Un brief senza verifica, senza permessi o con placeholder non passa.
 */
import fs from 'node:fs';
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('EINSTEIN+: brief mancante'); process.exit(2); }
let b; try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('EINSTEIN+: JSON non valido'); process.exit(2); }
const req = ['id', 'obiettivo', 'artefatto', 'verifica', 'permessi', 'scadenza', 'proprietario', 'criteri'];
const checks = [];
for (const k of req) checks.push({ nome: 'campo ' + k, ok: b[k] != null && (Array.isArray(b[k]) ? b[k].length > 0 : String(b[k]).trim().length > 0) });
const testo = JSON.stringify(b);
checks.push({ nome: 'nessun placeholder', ok: !/(TBD|DA COMPILARE|placeholder|lorem ipsum|\.\.\.)/i.test(testo) });
checks.push({ nome: 'verifica eseguibile (comandi/URL)', ok: Array.isArray(b.verifica) && b.verifica.every(v => /^(node|npm|npx|curl|https?:\/\/|\.\/|bash|python)/i.test(String(v).trim())) });
const permessiOk = ['read-only', 'workspace-write', 'danger-full-access'];
checks.push({ nome: 'permessi ammessi', ok: Array.isArray(b.permessi) && b.permessi.every(p => permessiOk.includes(p)) });
const data = new Date(b.scadenza + 'T23:59:59Z');
checks.push({ nome: 'scadenza valida e futura', ok: !Number.isNaN(data.getTime()) && data.getTime() > Date.now() });
const verdetto = checks.every(c => c.ok) ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ gate: 'EINSTEIN+', brief: b.id || null, checks, verdetto }, null, 2));
process.exit(verdetto === 'PASS' ? 0 : 2);
