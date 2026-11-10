#!/usr/bin/env node
/* QA performance: carico concorrente sul bordo/CDN. Budget p95 1s, errori <1%.
   Nota: il carico mondiale si regge su edge, cache e pagine statiche; l'origine
   Emergent resta il collo di bottiglia. Questo test misura il percorso reale. */
const fs = require('fs');
const path = require('path');
const BASE = 'https://careauctions.co';
const TARGETS = ['/', '/feed/statistiche.json', '/ai/knowledge.json', '/llms.txt'];
const CONC = 50, DUR = 10000;
const lat = []; let ok = 0, ko = 0;
const t0 = Date.now();
async function one() {
  while (Date.now() - t0 < DUR) {
    const u = BASE + TARGETS[Math.floor(Math.random() * TARGETS.length)];
    const s = process.hrtime.bigint();
    try { const r = await fetch(u, { headers: { 'User-Agent': 'CARe-Perf/1.0' } }); const e = process.hrtime.bigint(); lat.push(Number(e - s) / 1e6); if (r.ok) ok++; else ko++; }
    catch (e) { ko++; }
  }
}
(async () => {
  await Promise.all(Array.from({ length: CONC }, one));
  lat.sort((a, b) => a - b);
  const q = p => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;
  const totale = ok + ko, durata = Math.max(1, (Date.now() - t0) / 1000);
  const p95 = q(.95), p50 = q(.5), p99 = q(.99), err = totale ? ko / totale : 1;
  const stato = { generato: new Date().toISOString(), base: BASE, concorrenza: CONC, durata: Math.round(durata), richieste: totale, rps: Math.round(totale / durata), p50: Math.round(p50), p95: Math.round(p95), p99: Math.round(p99), errorePct: Math.round(err * 1000) / 10, budget: { p95Ms: 1000, errorePct: 1 }, ok: p95 < 1000 && err < 0.01, nota: 'Test sul bordo/CDN (cache reale). Il carico mondiale si regge su edge, cache e pagine statiche; l origine Emergent resta il collo di bottiglia.' };
  fs.mkdirSync(path.join(process.cwd(), 'perf'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'perf', 'stato.json'), JSON.stringify(stato, null, 2));
  console.log(JSON.stringify(stato));
  process.exit(stato.ok ? 0 : 1);
})();
