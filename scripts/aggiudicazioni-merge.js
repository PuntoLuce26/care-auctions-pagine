// scripts/aggiudicazioni-merge.js — 9/11/2026
// ---------------------------------------------------------------------------
// L'archivio dei prezzi di aggiudicazione (feed/aggiudicazioni.json) ha PIU'
// scrittori nello stesso giro di feed-sync in modalita' full: sync-feed.js (esiti
// del PVP) e poi fallco-aggiudicazioni.js e ivg-aggiudicazioni.js. Il 9/11 alle
// 01:58Z l'ultimo scrittore ha sovrascritto l'archivio con un array VUOTO: 16.771
// prezzi (298.835.634 EUR) sono spariti dalla pagina pubblica /aggiudicazioni,
// che da allora mostra zero righe. Ripristinati lo stesso giorno dal commit
// 9357e842; questo file esiste perche' non succeda piu'.
//
// REGOLE (ferme):
//   1) si UNISCE, non si sovrascrive: chiave = fonte|id;
//   2) un array vuoto NON si scrive mai: se non c'e' niente di nuovo, il file
//      resta com'e';
//   3) il merge non accorcia mai l'archivio: se il risultato ha meno record di
//      prima, non si scrive e si dice perche';
//   4) ogni record dichiara la sua fonte (fallcoaste, anivg, ivg, notarile-verona,
//      pvp): un prezzo senza fonte non e' un dato, e' un numero.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE_FEED = path.join(__dirname, '..', 'feed', 'aggiudicazioni.json');

function chiave(x) { return String((x && x.fonte) || '?') + '|' + String((x && x.id) || ''); }

function leggi(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : []; }
  catch (e) { return []; }
}

// Unisce `nuovi` all'archivio su disco. Restituisce il conto e se ha scritto.
function mergeRecords(file, nuovi, opts = {}) {
  const log = opts.log || (() => {});
  const fonte = opts.fonte || null;
  const vecchi = leggi(file);
  const m = new Map();
  for (const x of vecchi) if (x && x.id !== undefined && x.id !== null && x.id !== '') m.set(chiave(x), x);
  const prima = m.size;
  let aggiunti = 0, aggiornati = 0;
  for (const x of (nuovi || [])) {
    if (!x || x.id === undefined || x.id === null || x.id === '') continue;
    const y = fonte && !x.fonte ? Object.assign({}, x, { fonte }) : x;
    const k = chiave(y);
    if (!m.has(k)) { m.set(k, y); aggiunti++; }
    else { m.set(k, Object.assign({}, m.get(k), y)); aggiornati++; }
  }
  const fuori = [...m.values()];
  if (!fuori.length) { log('aggiudicazioni: nessun record — file lasciato com\'era (' + vecchi.length + ')'); return { prima, dopo: vecchi.length, aggiunti: 0, scritto: false }; }
  if (fuori.length < prima) { log('aggiudicazioni: il merge accorcia (' + prima + ' -> ' + fuori.length + ') — NON scrivo'); return { prima, dopo: prima, aggiunti, scritto: false }; }
  fs.writeFileSync(file, JSON.stringify(fuori));
  const perFonte = {};
  for (const x of fuori) perFonte[(x && x.fonte) || '?'] = (perFonte[(x && x.fonte) || '?'] || 0) + 1;
  log('aggiudicazioni.json: ' + fuori.length + ' record (prima ' + prima + ', +' + aggiunti + ' nuovi, ' + aggiornati + ' aggiornati) — fonti: ' + JSON.stringify(perFonte));
  return { prima, dopo: fuori.length, aggiunti, scritto: true };
}

// Forme delle due fonti raccolte dal workflow.
function daFallco(j) {
  const v = (j && j.voci) || [];
  return v.map(x => ({
    id: String(x.id),
    descrizione: String(x.descrizione || '').slice(0, 140),
    prezzo: x.prezzo_numero,
    prezzo_label: x.prezzo_label || '',
    termina: String(x.termine || '').slice(0, 10),
    ivg: x.ivg || '',
    tribunale: x.tribunale || '',
    fonte: 'fallcoaste',
  }));
}

function daIvg(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(x => x && x.venduto && x.prezzo)
    .map(x => ({ id: x.id, titolo: x.titolo, prezzo: x.prezzo, url: x.url, fonte: 'ivg' }));
}

if (require.main === module) {
  const [tipo, input, out] = process.argv.slice(2);
  const file = out || FILE_FEED;
  const log = (m) => console.log(m);
  if (!tipo) { console.log('uso: node scripts/aggiudicazioni-merge.js fallco|ivg <file-raccolta> [feed/aggiudicazioni.json]'); process.exit(0); }
  let j = null;
  try { j = JSON.parse(fs.readFileSync(input, 'utf8')); }
  catch (e) { console.log('aggiudicazioni: raccolta ' + tipo + ' non leggibile (' + e.message.slice(0, 60) + ') — archivio intatto'); process.exit(0); }
  const nuovi = tipo === 'fallco' ? daFallco(j) : tipo === 'ivg' ? daIvg(j) : [];
  if (!nuovi.length) { console.log('aggiudicazioni: la raccolta ' + tipo + ' non ha voci utili — archivio intatto'); process.exit(0); }
  mergeRecords(file, nuovi, { log });
}

module.exports = { mergeRecords, daFallco, daIvg, chiave };
