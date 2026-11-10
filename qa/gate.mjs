#!/usr/bin/env node
// Quality gate: il run diventa rosso solo per i problemi critici.
// I problemi alti/medi restano nel report e nell'issue, senza bloccare la pipeline.
import { readFileSync } from 'node:fs';

let report;
try { report = JSON.parse(readFileSync('qa/out/report.json', 'utf8')); }
catch (e) { console.log('::error::QA report non leggibile'); process.exit(1); }

const s = report.summary || {};
const critical = Number(s.critical || 0);
const high = Number(s.high || 0);
const medium = Number(s.medium || 0);

console.log(`QA gate: ${critical} critici · ${high} alti · ${medium} medi · ${s.total || 0} totali`);
if (critical > 0) {
  console.log(`::error::QA: ${critical} problemi critici (HTTP 5xx, pagina vuota, errore JS, build non allineata, feed fermo). Vedi il report.`);
  for (const i of (report.issues || []).filter(x => x.severity === 'critical').slice(0, 10)) {
    console.log(`- ${i.type} ${i.route || ''} ${i.viewport || ''}: ${String(i.message).slice(0, 180)}`);
  }
  process.exit(1);
}
console.log('QA gate: nessun problema critico.');
