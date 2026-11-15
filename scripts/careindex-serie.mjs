// scripts/careindex-serie.mjs — 15/11/2026
// ---------------------------------------------------------------------------
// DIFETTO 5 del 15/11/2026: /ca-re-index chiede /feed/careindex-serie.json?t=… e riceve 404.
// Il nome lo dichiara l'app stessa (documento dei campi dentro la pagina servita):
//   "careindex.serie: elaborazione dell'app finché non esiste feed/careindex-serie.json
//    (poi letta da lì): prezzoMq = media di prezzoBase / mq dei lotti residenziali con
//    superficie; indice = prezzoMq / prezzoMq del primo giorno × 100; lotti = numero di
//    quei lotti".
// Il generatore ESISTEVA ma scriveva un altro nome: scripts/esiti-sync.js scrive
// feed/ca-re-index-esiti.json (indice aggregato dei prezzi di aggiudicazione: niente serie
// giornaliera, niente €/mq). Questo script produce il file con il nome che la pagina chiede.
//
// REGOLE: prezzo BASE (mai la minima, che è il pavimento di legge del 25%); superfici solo
// se dichiarate dalla fonte (cache perizie feed/superfici-attivi.json o testo del lotto) —
// i lotti senza superficie NON si stimano e restano fuori, e la copertura si dichiara;
// nessun punto con meno di MIN_LOTTI lotti (un indice su 1 lotto non è una misura).
// COSTO: legge gli shard regionali (feed/indice.json → regioni[].filesImm), quindi si
// autolimita a un giro al giorno (SERIE_ORE=20) per non ripagarlo a ogni feed-sync.
import fs from 'node:fs';
import path from 'node:path';

const FEED = process.env.FEED_DIR || 'feed';
const OUT = path.join(FEED, 'careindex-serie.json');
const GIORNI = Number(process.env.SERIE_GIORNI || 90);
const MIN_LOTTI = Number(process.env.SERIE_MIN_LOTTI || 5);
const ORE = Number(process.env.SERIE_ORE || 20);
const FORZA = process.env.SERIE_FORZA === '1';
const CANARY = 'care-canary-d2c32afaa5d5';
const ORA = new Date().toISOString();

function leggi(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } }

// autolimite: la serie è giornaliera, non ha senso rifarla a ogni giro di feed-sync
if (!FORZA) {
  const vecchio = leggi(OUT, null);
  const quando = vecchio && vecchio.meta && Date.parse(vecchio.meta.generatoIl || vecchio.generatoIl || '');
  if (quando && (Date.now() - quando) < ORE * 3600 * 1000) {
    console.log('careindex-serie: aggiornato ' + new Date(quando).toISOString() + ' (<' + ORE + 'h) — salto');
    process.exit(0);
  }
}

const cache = (leggi(path.join(FEED, 'superfici-attivi.json'), {}) || {}).lotti || {};
const mqCache = {};
for (const [id, v] of Object.entries(cache)) { const m = Number(v && v.mq); if (m > 0) mqCache[String(id)] = m; }

// elenco degli shard residenziali: indice.json, altrimenti italia-imm-*
let files = [];
const indice = leggi(path.join(FEED, 'indice.json'), null);
if (indice && indice.regioni) {
  for (const r of Object.keys(indice.regioni)) files.push(...((indice.regioni[r] || {}).filesImm || []));
}
files = [...new Set(files)].filter(f => fs.existsSync(path.join(FEED, f)));
if (!files.length) files = fs.readdirSync(FEED).filter(f => /^italia-imm-\d+\.json$/.test(f)).sort();
if (!files.length) { console.log('careindex-serie: nessuno shard residenziale in ' + FEED + ' — file non scritto'); process.exit(0); }

const RE_MQ = /(\d{1,5}(?:[.,]\d{1,3})?)\s*(?:m2|m²|mq|metri\s+quadrati)\b/i;
const RESIDENZIALE = /^(APPARTAMENTO|ABITAZIONE_|VILLA|VILLETTA|PORZIONE_DI_FABBRICATO|FABBRICATO|MONOLOCALE|ATTICO|LOFT|RUSTICO|CASALE)/i;
const RES_DESC = /appartament|abitazion|villetta|villa |residenzial|attico|monolocale|rustico|casale/i;

function mqDi(x) {
  const dallaCache = mqCache[String(x.id)];
  if (dallaCache) return { mq: dallaCache, da: 'perizia' };
  const m = RE_MQ.exec(String(x.titolo || '') + ' ' + String(x.descrizione || ''));
  if (!m) return null;
  const v = Number(String(m[1]).replace(/\./g, '').replace(',', '.'));
  return (v >= 15 && v <= 2000) ? { mq: v, da: 'descrizione' } : null;
}

const giorni = new Map();
let considerati = 0, conMq = 0, scartati = 0, letti = 0;
const t0 = Date.now();
for (const f of files) {
  const arr = leggi(path.join(FEED, f), []);
  if (!Array.isArray(arr)) continue;
  letti += arr.length;
  for (const x of arr) {
    const tit = String(x.titolo || '');
    if (!(RESIDENZIALE.test(tit) || RES_DESC.test(tit + ' ' + String(x.descrizione || '').slice(0, 160)))) continue;
    considerati++;
    const prezzo = Number(x.prezzoBase) || 0;
    const giorno = String(x.pubblicazione || '').slice(0, 10);
    if (!(prezzo >= 5000 && prezzo <= 5000000) || !/^\d{4}-\d{2}-\d{2}$/.test(giorno)) { scartati++; continue; }
    const s = mqDi(x);
    if (!s) { scartati++; continue; }
    const prezzoMq = prezzo / s.mq;
    if (!(prezzoMq >= 100 && prezzoMq <= 20000)) { scartati++; continue; }
    conMq++;
    if (!giorni.has(giorno)) giorni.set(giorno, { somma: 0, n: 0 });
    const g = giorni.get(giorno); g.somma += prezzoMq; g.n++;
  }
}

const serie = [...giorni.entries()]
  .filter(([, g]) => g.n >= MIN_LOTTI)
  .map(([giorno, g]) => ({ giorno, prezzoMq: Math.round(g.somma / g.n), lotti: g.n }))
  .sort((a, b) => a.giorno.localeCompare(b.giorno))
  .slice(-GIORNI);

if (serie.length < 7) { console.log('careindex-serie: serie troppo corta (' + serie.length + ' giorni) — non scrivo'); process.exit(0); }
const base = serie[0].prezzoMq || 1;
for (const p of serie) p.indice = Math.round((p.prezzoMq / base) * 1000) / 10;

const primo = serie[0].giorno, ultimo = serie[serie.length - 1].giorno;
const out = {
  generatoIl: ORA,
  aggiornato: ORA,
  serie,
  meta: {
    titolo: 'CAReIndex — serie del prezzo base al metro quadro dei lotti residenziali',
    canary: CANARY,
    canaryNota: 'valore di riconoscimento della copia dei dati',
    generatoIl: ORA,
    cadenza: 'al massimo un giro ogni ' + ORE + ' h, dentro il workflow feed-sync',
    fonte: "Portale delle Vendite Pubbliche (Ministero della Giustizia) — shard regionali dei lotti (feed/<regione>-imm-N.json)",
    metodo: "prezzoMq = media di prezzoBase / superficie dei lotti residenziali con superficie dichiarata; indice = prezzoMq / prezzoMq del primo giorno x 100; lotti = quanti lotti hanno prodotto quel punto. Si usa il PREZZO BASE, mai la minima (che e' il pavimento di legge del 25%).",
    finestra: { giorni: GIORNI, dal: primo, al: ultimo, minLottiPerGiorno: MIN_LOTTI },
    copertura: {
      fileLetti: files.length, lottiLetti: letti,
      lottiResidenziali: considerati, lottiConSuperficie: conMq,
      quotaPct: considerati ? Math.round((1000 * conMq) / considerati) / 10 : 0,
      giorniInSerie: serie.length, scartati,
      nota: 'le superfici vengono dalla cache delle perizie (feed/superfici-attivi.json) e, quando la descrizione le dichiara, dal testo del lotto; i lotti senza superficie NON si stimano e restano fuori',
    },
    durataSec: Math.round((Date.now() - t0) / 1000),
  },
  nota: "Serie giornaliera del CAReIndex, servita da /feed/careindex-serie.json e letta da /ca-re-index. Prima del 15/11/2026 il file non esisteva (404) e il grafico restava senza serie.",
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('careindex-serie: ' + serie.length + ' giorni (' + primo + ' -> ' + ultimo + ') · ' + conMq + '/' + considerati + ' lotti con superficie su ' + letti + ' letti · prezzoMq ' + serie[0].prezzoMq + ' -> ' + serie[serie.length - 1].prezzoMq + ' · ' + Math.round((Date.now() - t0) / 1000) + 's');
