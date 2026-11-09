// scripts/feed-regole.js — B e C · 6/11/2026
// ---------------------------------------------------------------------------
// Le due regole del feed che non devono vivere sparse dentro sync-feed.js:
//
// B — quali file NON si cancellano mai nella ricostruzione completa (MODE=full).
//     Il full e' pensato per rigenerare i file di regione dal PVP; i tre andamento-*
//     non si ricostruiscono da niente (sono storia: una rilevazione datata e due serie),
//     quindi se li cancella la storia del progetto sparisce. Restano.
//
// C — un numero si pubblica solo se e' una MISURA VIVA E DATATA.
//     Se la rilevazione degli esiti e' piu' vecchia di 7 giorni non si ricopia: si
//     pubblica `esiti: null` con il motivo. Meglio nessun numero che un numero che
//     sembra aggiornato solo perche' qualcuno l'ha ricopiato.
'use strict';
const fs = require('fs');

const SOGLIA_GIORNI = 7;

const PROTETTI_FEED = new Set([
  'indice.json',
  'indice-completo.json',
  'ore-aste.json',
  'esiti-ritirati.json',        // registro di ritiro esiti (C del 6/11), non si rigenera
  'andamento-esiti.json',       // rilevazione datata: se sparisce, si perde la data
  'andamento-prezzi.json',      // serie storica del prezzo medio
  'andamento-partecipazione.json', // serie storica della partecipazione
  // 9/11 — file generati da ALTRI workflow: il full rebuild li cancellava e restavano 404
  // finché il loro workflow non rigirava (npl.json è stato 404 per ore il 9/11).
  'npl.json',                 // workflow npl-sync
  'foto-procedure.json',       // workflow foto-sync
  'perizie-ocr.json',          // workflow ocr-perizie
  'ocr-stato.json',            // workflow ocr-perizie
  'indexnow.json',             // workflow indexnow-daily
  'ilive.json',                // elenco opere iLive, non generato da sync-feed
  // 9/11 — seconda ondata: altri file che il full delle 01:58 ha cancellato e che
  // NESSUN workflow ricostruisce (sono stati 404 per ore). Mai piu' nel mirino.
  'confronto-mercato.json',     // statistiche-mercato.js (confronto OMI)
  'prezzi-aggiudicazione.json',
  'esiti-riconciliazione.json',
  'foto-ricavate.json',         // foto-sync
  'foto-perizie-stato.json',    // foto-perizie
  'visite-rum.json',            // raccolta RUM Cloudflare
  'italia-imm.json',            // aggregati nazionali (script del Mac)
  'italia-mob.json',
  'emozioni91.json',
  'pagine91.json',
  // 9/11/2026 - l'archivio dei prezzi di aggiudicazione: 16.771 voci, 298.835.634 EUR.
  // Il full delle 01:58Z lo ha azzerato (l'ultimo scrittore del giro, IVG, ha scritto un
  // array vuoto) e NESSUN workflow lo ricostruisce da zero: ripristinato dal commit 9357e842.
  // Da oggi si scrive solo per merge (scripts/aggiudicazioni-merge.js) e non si cancella.
  'aggiudicazioni.json',
  'esiti-monitor.json',          // riepilogo esiti rigenerato dal sync, non si cancella
]);

// Nomi dei file di regione elencati in un indice (quelli che il full riscrive).
function fileDaIndice(indice) {
  const out = new Set();
  const regioni = (indice && indice.regioni) || {};
  for (const r of Object.keys(regioni)) {
    const g = regioni[r] || {};
    for (const f of [...(g.filesImm || []), ...(g.filesMob || [])]) if (f) out.add(f);
  }
  return out;
}

// Elenco dei .json di feed/ che la ricostruzione completa puo' cancellare.
// 9/11/2026 — SECONDA STRETTA (dopo il 404 di npl.json): non si cancella piu'
// "tutto tranne i protetti" ma SOLO i file elencati nell'indice vecchio, cioe'
// quelli che il full riscrive davvero con i lotti appena raccolti.
// Il full delle 01:58 ha passato unlink a 39 file: oltre ai file di regione sono
// spariti 10 feed nati da altri workflow o da script del Mac (confronto-mercato,
// prezzi-aggiudicazione, visite-rum, foto-ricavate, italia-imm/mob...) che nessuno
// rigenera -> 404 per ore. Senza indice non si cancella niente: meglio un file
// vecchio che un 404.
function fileDaCancellare(dir, indiceVecchio, protetti = PROTETTI_FEED) {
  if (indiceVecchio instanceof Set) { protetti = indiceVecchio; indiceVecchio = null; }
  const elenco = fileDaIndice(indiceVecchio);
  if (!elenco.size) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !protetti.has(f) && elenco.has(f));
}

// Conta le righe "misurate" di un blocco esiti (nonPubblicato NON conta: e' l'assenza).
function conteggioVivo(e) {
  if (!e) return 0;
  return (Number(e.aggiudicate) || 0) + (Number(e.deserte) || 0) + (Number(e.sospese) || 0);
}

function giorniDa(generato, adesso) {
  const t = Date.parse(String(generato || ''));
  if (!Number.isFinite(t)) return Infinity;
  return Math.floor((adesso - t) / 86400000);
}

// Ritorna { esiti, motivo, scriviCanone, rilevazione }.
function scegliEsiti({ modo, esitiAcc, canone, sogliaGiorni = SOGLIA_GIORNI, adesso = Date.now() }) {
  if (modo === 'full') {
    // il full ha appena rimisurato tutto: se ha visto esiti, sono la verita' del giorno
    if (conteggioVivo(esitiAcc) > 0) return { esiti: esitiAcc, motivo: null, scriviCanone: true, rilevazione: null };
    return {
      esiti: null,
      motivo: 'il PVP non pubblica gli esiti (campo "esito" vuoto): nessuna rilevazione',
      scriviCanone: false,
      rilevazione: null,
    };
  }

  // incrementale: il canone si usa solo se ha una data e non e' vecchio
  if (canone && canone.esiti && conteggioVivo(canone.esiti) > 0) {
    const t = Date.parse(String(canone.generato || ''));
    const etaMs = Number.isFinite(t) ? (adesso - t) : Infinity;
    const giorniFa = Number.isFinite(etaMs) ? Math.floor(etaMs / 86400000) : null;
    const data = String(canone.generato || '?').slice(0, 10);
    // "piu' vecchio di 7 giorni" si misura in millisecondi: 7 giorni e 4 ore e' vecchio
    if (etaMs <= sogliaGiorni * 86400000) {
      return { esiti: canone.esiti, motivo: null, scriviCanone: false, rilevazione: null };
    }
    return {
      esiti: null,
      motivo: 'rilevazione ferma dal ' + data,
      scriviCanone: false,
      rilevazione: { ...canone.esiti, data, giorniFa },
    };
  }

  return { esiti: null, motivo: 'nessuna rilevazione degli esiti disponibile', scriviCanone: false, rilevazione: null };
}

module.exports = { PROTETTI_FEED, SOGLIA_GIORNI, fileDaCancellare, fileDaIndice, scegliEsiti, conteggioVivo };

if (require.main === module) {
  // prova rapida: stampare la decisione con i dati veri di feed/
  const path = require('path');
  const FEED = process.argv[2] || path.join(__dirname, '..', 'feed');
  let canone = null;
  try { canone = JSON.parse(fs.readFileSync(path.join(FEED, 'andamento-esiti.json'), 'utf8')); } catch (e) {}
  console.log('protetti:', [...PROTETTI_FEED].join(', '));
  console.log('scegliEsiti(inc, canone attuale):', JSON.stringify(scegliEsiti({ modo: 'inc', esitiAcc: { aggiudicate: 0, deserte: 0, sospese: 0, nonPubblicato: 100 }, canone })));
  console.log('scegliEsiti(full, acc 0):', JSON.stringify(scegliEsiti({ modo: 'full', esitiAcc: { aggiudicate: 0, deserte: 0, sospese: 0, nonPubblicato: 100 }, canone })));
}
