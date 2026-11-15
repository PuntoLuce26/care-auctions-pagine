#!/usr/bin/env node
/** omi-tipologie.mjs — generatore del feed `feed/omi-tipologie.json`.
 *
 *  PERCHÉ ESISTE (15/11/2026). `feed/omi-tipologie.json` non aveva nessuno scrittore nel repo:
 *  verificato, nessuno script lo nomina. Era stato prodotto una volta (generatoIl 11/11) e da
 *  allora nessun giro lo toccava — quindi il canary non aveva un posto dove vivere.
 *
 *  PERCHÉ NON RICALCOLA I NUMERI. Il feed pubblica, per ogni tipologia OMI, `righe`, `min`, `max`,
 *  `canoneMq`. Ricalcolando dal dataset (semestre 2026/1) con la definizione «mediana delle
 *  mediane di zona» escono valori DIVERSI da quelli pubblicati (cod 20 Abitazioni civili:
 *  righe 21.132 · min 810 · max 1.100 · canone 3,1 contro 26.410 · 900 · 1.200 · 3,9).
 *  La formula esatta usata l'11/11 non è scritta in nessun file del repo: riscriverla a intuito
 *  cambierebbe i numeri pubblicati in silenzio — cioè il guasto peggiore, un numero nuovo che
 *  sembra solo rigenerato. Quindi: il generatore CONSERVA i valori, verifica la forma, e
 *  RICALCOLA solo per MISURARE lo scarto e dichiararlo (meta.verificaRicalcolo). Se e quando la
 *  definizione sarà fissata per iscritto, questa è la riga da cambiare.
 *
 *  INGRESSO: feed/omi-tipologie.json + (facoltativo) dataset OMI in OMI_DATASET, altrimenti
 *            puntoluce/dati/omi/omi-dataset.json. USCITA: feed/omi-tipologie.json.
 */
import fs from 'node:fs';

const FILE = 'feed/omi-tipologie.json';
const DS = process.env.OMI_DATASET || 'puntoluce/dati/omi/omi-dataset.json';
const CANARY = 'care-canary-d2c32afaa5d5';
const CANARY_NOTA = 'valore di riconoscimento della copia dei dati';

let dati;
try {
  dati = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.log('omi-tipologie: file non leggibile — non tocco niente (' + String(e.message || e).slice(0, 80) + ')');
  process.exit(0);
}

const formaOk = dati && dati.meta && Array.isArray(dati.meta.semestri) && Array.isArray(dati.tipologie)
  && dati.tipologie.length && dati.tipologie.every((t) => t && t.cod != null && t.descrizione);
if (!formaOk) {
  console.log('omi-tipologie: forma inattesa (servono meta.semestri e tipologie[].cod/descrizione) — non scrivo');
  process.exit(0);
}

// MISURA, NON APPLICAZIONE: ricalcolo dichiarato per far vedere lo scarto.
let verificaRicalcolo = null;
try {
  const ds = JSON.parse(fs.readFileSync(DS, 'utf8'));
  const sem = ds.meta.semestri[ds.meta.semestri.length - 1];
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); const m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const byCod = {};
  for (const c of Object.values(ds.comuni || {})) {
    const s = c.semestri && c.semestri[sem]; if (!s) continue;
    for (const z of Object.values(s.zone || {})) {
      for (const [cod, t] of Object.entries(z.tipologie || {})) {
        if (t == null || t.min == null) continue;
        (byCod[cod] = byCod[cod] || { mins: [], maxs: [], locs: [] });
        byCod[cod].mins.push(t.min); byCod[cod].maxs.push(t.max);
        if (t.locMin != null) byCod[cod].locs.push(t.locMin);
      }
    }
  }
  const d = byCod['20'];
  if (d) verificaRicalcolo = {
    semestre: sem,
    definizione: 'mediana delle mediane di zona del semestre corrente, per ogni tipologia',
    cod20: { righe: d.mins.length, min: med(d.mins), max: med(d.maxs), canoneMq: d.locs.length ? Number(med(d.locs).toFixed(1)) : null },
    applicato: false,
    motivoNonApplicato: 'La definizione usata per i valori pubblicati non è scritta nel repo: ricalcolarli con questa formula cambierebbe i numeri pubblicati. Il generatore conserva e dichiara.'
  };
  console.log('omi-tipologie: ricalcolo di controllo (non applicato) cod20 =', JSON.stringify(verificaRicalcolo.cod20));
} catch (e) {
  console.log('omi-tipologie: dataset non leggibile, nessuna verifica di ricalcolo (' + String(e.message || e).slice(0, 60) + ')');
}

const out = {
  meta: {
    ...dati.meta,
    canary: CANARY,
    canaryNota: CANARY_NOTA,
    aggiornato: new Date().toISOString(),
    generatore: 'scripts/omi-tipologie.mjs',
    notaGeneratore: 'I valori per tipologia sono conservati, non ricalcolati: la formula con cui sono stati prodotti non è documentata nel repo e riscriverla a intuito cambierebbe numeri pubblicati. Il generatore verifica la forma, conserva i valori e riporta in verificaRicalcolo lo scarto misurato con la formula dichiarata.',
    ...(verificaRicalcolo ? { verificaRicalcolo } : {})
  },
  semestre: dati.semestre,
  tipologie: dati.tipologie,
};
const finale = { meta: out.meta };
for (const k of Object.keys(dati)) if (k !== 'meta') finale[k] = dati[k];

fs.writeFileSync(FILE, JSON.stringify(finale));
console.log('omi-tipologie: scritto · canary ' + CANARY + ' · tipologie ' + finale.tipologie.length + ' · semestre ' + finale.semestre + ' · ' + (fs.statSync(FILE).size / 1024).toFixed(1) + ' KB');
