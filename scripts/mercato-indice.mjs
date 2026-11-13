#!/usr/bin/env node
/** mercato-indice.mjs — l'indice del mercato libero, a costo zero.
 *  Sorgente: Eurostat — House price index, quarterly (dataset prc_hpi_q, Italia, CC-BY 4.0).
 *  Perché Eurostat e non ISTAT: stessa famiglia di indici (ISTAT alimenta Eurostat), ma
 *  Eurostat espone API e JSON puliti, senza scraping di PDF. ISTAT resta citato come fonte primaria.
 *  Granularità dichiarata: trimestrale. Il giornaliero esiste solo per le aste. */
import fs from 'node:fs';

const URL_ = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hpi_q?geo=IT&format=JSON&lang=EN';
const OUT = process.argv[2] || 'feed/mercato-indice.json';

// 13/11/2026 — FONTE PUBBLICA + DATA DI RILEVAZIONE.
// La fonte di questo feed NON è il PVP: qui non ci sono aste, c'è l'indice dei prezzi delle
// abitazioni del mercato libero. Dichiarare il PVP sarebbe falso. La fonte vera è Eurostat
// (prc_hpi_q), che è alimentato da ISTAT: entrambi pubblici e controllabili.
const FONTE = {
  nome: 'Eurostat — House price index (prc_hpi_q), alimentato da ISTAT',
  url: 'https://ec.europa.eu/eurostat/databrowser/view/prc_hpi_q/default/table',
};

const r = await fetch(URL_, { headers: { 'User-Agent': 'CARe-merce' } });
if (!r.ok) { console.error('Eurostat non raggiungibile', r.status); process.exit(1); }
// Istante VERO della raccolta: la risposta della fonte. Non l'istante di scrittura del file.
const raccolta = new Date().toISOString();
const d = await r.json();
// Revisione dichiarata dalla fonte (JSON-stat `updated`): quando Eurostat ha pubblicato questi numeri.
const revisioneFonte = (() => { const t = Date.parse(String(d.updated || '')); return Number.isFinite(t) ? new Date(t).toISOString() : null; })();

const dims = d.id;                 // ['freq','purchase','unit','geo','time']
const size = d.size;
const cat = (k) => d.dimension[k].category;
const periodi = Object.entries(cat('time').index).sort((a, b) => a[1] - b[1]).map(([p]) => p);
const acquisti = Object.entries(cat('purchase').index).sort((a, b) => a[1] - b[1]).map(([k]) => k);
const unita = Object.entries(cat('unit').index).sort((a, b) => a[1] - b[1]).map(([k]) => k);

// indice piatto: freq × purchase × unit × geo × time
const at = (ip, iu, it) => d.value[String(0 * size[1] * size[2] * size[3] * size[4] + ip * size[2] * size[3] * size[4] + iu * size[3] * size[4] + 0 * size[4] + it)];

const iU = unita.indexOf('I15_Q');
const serie = (iP) => {
  const out = [];
  let prec = null;
  for (let it = 0; it < periodi.length; it++) {
    const v = at(iP, iU, it);
    if (v === undefined) continue;
    out.push({ periodo: periodi[it], indice: Math.round(v * 10) / 10, variazionePct: prec ? Math.round((v - prec) / prec * 1000) / 10 : null });
    prec = v;
  }
  return out;
};

const feed = {
  fonte: FONTE,
  rilevazione: raccolta,
  meta: {
    titolo: 'Mercato libero — indice dei prezzi delle abitazioni',
    fonte: FONTE,
    fonteTesto: 'Eurostat, House price index (prc_hpi_q). ISTAT alimenta Eurostat: la serie primaria è ISTAT.',
    rilevazione: raccolta,
    rilevazioneRevisioneFonte: revisioneFonte,
    rilevazioneNota: 'Istante in cui la serie è stata LETTA da Eurostat (prc_hpi_q): è la raccolta, non la scrittura del file. La serie è trimestrale: l\'ultimo periodo pubblicato è l\'ultimo dato che esiste e non cambia fra due letture.',
    rilevazioneMotivo: null,
    licenza: 'CC-BY 4.0',
    granularita: 'trimestrale',
    base: 'indice 2015 = 100',
    generatoIl: new Date().toISOString(),
    nota: 'Il mercato libero non ha un dato giornaliero. L\'unica serie giornaliera del progetto è quella delle aste (feed/aste-trend.json).'
  },
  totale: serie(acquisti.indexOf('TOTAL')),
  nuove: serie(acquisti.indexOf('DW_NEW')),
  esistenti: serie(acquisti.indexOf('DW_EXST'))
};
fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(feed));
console.log('periodi:', feed.totale.length, '·', feed.totale[0].periodo, '→', feed.totale[feed.totale.length - 1].periodo);
console.log('ultimo totale:', JSON.stringify(feed.totale[feed.totale.length - 1]));
console.log('feed:', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');
