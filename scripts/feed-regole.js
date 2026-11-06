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
]);

// Elenco dei .json di feed/ che la ricostruzione completa puo' cancellare.
function fileDaCancellare(dir, protetti = PROTETTI_FEED) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !protetti.has(f));
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

module.exports = { PROTETTI_FEED, SOGLIA_GIORNI, fileDaCancellare, scegliEsiti, conteggioVivo };

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
