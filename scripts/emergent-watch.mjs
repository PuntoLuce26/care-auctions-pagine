#!/usr/bin/env node
/** emergent-watch.mjs — misura Emergent da fuori (il pannello interno non ha API pubblica).
 *  Per ogni giro: TTFB mediana di 3 campioni su / dell'origine e del nostro sito, stato,
 *  dimensione HTML e hash del bundle (per capire quando pubblica). Storico in perf/emergent.json. */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (CARe-emergent-watch)';
const OGGI = new Date().toISOString();

async function misura(url, campioni = 3) {
  const tempi = [];
  let stato = 0, size = 0, bundle = '';
  for (let i = 0; i < campioni; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      stato = r.status;
      const body = await r.text();
      size = body.length;
      tempi.push(Date.now() - t0);
      const m = body.match(/main\.[a-f0-9]{8}\.js/);
      if (m) bundle = m[0];
    } catch (e) {
      stato = 0;
      tempi.push(Date.now() - t0);
    }
  }
  tempi.sort((a, b) => a - b);
  return { stato, ttfbMedian: tempi[Math.floor(tempi.length / 2)], size, bundle };
}

const origine = await misura('https://care-aste.emergent.host/');
const sito = await misura('https://careauctions.co/');

const dir = path.join(process.cwd(), 'perf');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'emergent.json');
let storico = [];
try { storico = (JSON.parse(fs.readFileSync(file, 'utf8')) || {}).punti || []; } catch (e) {}
const punto = {
  t: OGGI,
  origine: { stato: origine.stato, ttfb: origine.ttfbMedian, kb: Math.round(origine.size / 1024), bundle: origine.bundle },
  sito: { stato: sito.stato, ttfb: sito.ttfbMedian, kb: Math.round(sito.size / 1024) }
};
storico.push(punto);
storico = storico.slice(-500);
fs.writeFileSync(file, JSON.stringify({ aggiornato: OGGI, nota: 'TTFB misurato da GitHub Actions (3 campioni, mediana). Il CPU/memoria interni di Emergent non sono esposti.', punti: storico }));

// stato sintetico per il quadro/QA
const ultimi = storico.slice(-8);
const lenti = ultimi.filter((p) => p.origine.ttfb > 2500).length;
const giu = ultimi.filter((p) => p.origine.stato !== 200).length;
const stato = {
  aggiornato: OGGI,
  origine_ttfb_ultimo: origine.ttfbMedian,
  origine_ttfb_max_8: Math.max(...ultimi.map((p) => p.origine.ttfb)),
  sito_ttfb_ultimo: sito.ttfbMedian,
  punti_lenti_su_8: lenti,
  punti_giu_su_8: giu,
  bundle_origine: origine.bundle,
  allarme: giu > 0 ? 'origine non 200' : (lenti >= 3 ? 'origine lenta (>2,5 s per 3 giri)' : 'ok')
};
fs.writeFileSync(path.join(dir, 'stato.json'), JSON.stringify(stato, null, 1));
console.log(JSON.stringify(stato, null, 1));
