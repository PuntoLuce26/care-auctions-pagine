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

// 18/11/2026 — la cadenza si DICHIARA qui e si MISURA qui: il check non deduce niente.
// Il valore dichiarato (cadenzaOre) è la cadenza attesa; mediana e massimo degli intervalli
// viaggiano nel payload come PROVENIENZA, così chi legge la soglia sa su quante osservazioni è basata.
// Regola (Lead 18/11): la soglia si mette SOPRA IL MASSIMO OSSERVATO, non sopra la mediana —
// altrimenti si misura il ritardo di GitHub, non un nostro guasto.
const intervalliOre = (() => {
  const ts = storico.map((p) => Date.parse(p && p.t)).filter(Boolean);
  const d = [];
  for (let i = 1; i < ts.length; i++) d.push((ts[i] - ts[i - 1]) / 3600000);
  return d;
})();
const medianaOre = (a) => {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y), m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const r1 = (v) => (v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 10) / 10);
const cadenzaMedianaH = r1(medianaOre(intervalliOre));
const cadenzaMassimoH = intervalliOre.length ? r1(Math.max(...intervalliOre)) : null;

// stato sintetico per il quadro/QA
const ultimi = storico.slice(-8);
const lenti = ultimi.filter((p) => p.origine.ttfb > 2500).length;
const giu = ultimi.filter((p) => p.origine.stato !== 200).length;
const stato = {
  aggiornato: OGGI,
  // 18/11/2026 — LA CADENZA È UN DATO DEL PAYLOAD, non una soglia nel codice del check.
  // Dichiarata qui dal generatore, con il valore MISURATO sugli intervalli di perf/emergent.json
  // (17→18/11/2026: 0,99 h · 5,4 h · 8,1 h · 9,2 h → mediana 8,1 h): emergent-watch.yml ha cron
  // `*/15` ma GitHub lo dirada, quindi la raccolta effettiva è ~8 h, non 15 min.
  // Chi legge calcola la soglia: cadenzaOre × 1,5 (minimo cadenzaOre + 2 h). Per cambiarla:
  // PERF_CADENZA_ORE=<ore> nel workflow, senza toccare né il produttore né il check.
  cadenzaOre: Number(process.env.PERF_CADENZA_ORE || 8),
  cadenzaOsservazioni: intervalliOre.length,
  cadenzaMedianaH,
  cadenzaMassimoH,
  cadenzaNota: 'dichiarata dal generatore (cadenzaOre); mediana e massimo sono MISURATI sugli intervalli di perf/emergent.json; GitHub dirada il cron */15',
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
