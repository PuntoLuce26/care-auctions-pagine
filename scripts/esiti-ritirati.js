// scripts/esiti-ritirati.js — C · 6/11/2026
// -----------------------------------------------------------------------------
// Cosa fa: toglie dai lotti gli esiti che erano stati scritti su un incrocio per id
// NON valido (gli id di feed/aggiudicazioni.json sono id di portale — fallcoaste,
// anivg, notarili — non idAnnuncio del PVP; 0 su 114 avevano il tribunale coerente).
//
// Perche' vive qui: i file feed/<regione>-imm-N.json vengono rigenerati; un esito
// scritto da uno script esterno verrebbe cancellato (full) o resterebbe per sempre
// (incrementale). La passata sta DENTRO sync-feed, dopo la scrittura dei file e
// PRIMA dei contatori, e si applica una volta sola (stato nel registro).
//
// Registro: feed/esiti-ritirati.json — { stato, motivo, verifica, ids: {id: "AGGIU"} }.
// Uso da riga di comando (prova locale):
//   node scripts/esiti-ritirati.js <cartella-feed>
'use strict';
const fs = require('fs');
const path = require('path');

// I campi che quello script aveva scritto insieme all'esito: vanno via insieme all'esito.
const CAMPI_RITIRATI = [
  'esito',
  'prezzoAggiudicazione',
  'prezzoAggiudicazioneTipo',
  'dataAggiudicazione',
  'tribunaleArchivio',
  'esitoFonte',
];

function applicaEsitiRitirati(FEED, indice, log = console.log) {
  const regPath = path.join(FEED, 'esiti-ritirati.json');
  if (!fs.existsSync(regPath)) return { rimossi: 0, toccati: 0, salta: true, motivo: 'registro assente' };

  let reg;
  try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); }
  catch (e) { return { rimossi: 0, toccati: 0, salta: true, motivo: 'registro illeggibile: ' + e.message }; }

  if (reg.stato === 'applicato') {
    return { rimossi: 0, toccati: 0, salta: true, motivo: 'gia applicato il ' + (reg.applicatoIl || '?') };
  }

  const ids = reg.ids || {};
  const totale = Object.keys(ids).length;
  if (!totale) return { rimossi: 0, toccati: 0, salta: true, motivo: 'registro senza id' };

  const files = new Set();
  for (const r of Object.keys((indice && indice.regioni) || {})) {
    const g = indice.regioni[r] || {};
    for (const f of [...(g.filesImm || []), ...(g.filesMob || [])]) files.add(f);
  }

  let rimossi = 0, toccati = 0;
  const perFile = [];
  for (const f of files) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(FEED, f), 'utf8')); } catch (e) { continue; }
    if (!Array.isArray(arr)) continue;
    let camb = 0;
    for (const x of arr) {
      const atteso = ids[String(x.id || '')];
      if (!atteso) continue;
      if (String(x.esito || '').toUpperCase() !== atteso) continue; // non tocca esiti diversi da quelli registrati
      for (const k of CAMPI_RITIRATI) if (k in x) delete x[k];
      camb++;
    }
    if (camb) {
      fs.writeFileSync(path.join(FEED, f), JSON.stringify(arr));
      rimossi += camb;
      toccati++;
      perFile.push(f + ':' + camb);
    }
  }

  const nonTrovati = totale - rimossi;
  reg.stato = 'applicato';
  reg.applicatoIl = new Date().toISOString();
  reg.applicati = { rimossi, toccati, nonTrovati, perFile: perFile.slice(0, 40) };
  fs.writeFileSync(regPath, JSON.stringify(reg));
  log('esiti ritirati: ' + rimossi + '/' + totale + ' rimossi in ' + toccati + ' file' +
    (nonTrovati ? ' — ' + nonTrovati + ' id non trovati (ok se il feed e stato rigenerato)' : ''));
  return { rimossi, toccati, nonTrovati, perFile };
}

module.exports = { applicaEsitiRitirati, CAMPI_RITIRATI };

if (require.main === module) {
  const FEED = process.argv[2] || path.join(__dirname, '..', 'feed');
  const indice = JSON.parse(fs.readFileSync(path.join(FEED, 'indice.json'), 'utf8'));
  const esito = applicaEsitiRitirati(FEED, indice);
  console.log(JSON.stringify(esito));
}
