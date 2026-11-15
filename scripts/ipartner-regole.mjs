#!/usr/bin/env node
/** ipartner-regole.mjs — generatore del feed `feed/ipartner-regole.json`.
 *
 *  PERCHÉ ESISTE (15/11/2026). Il feed non aveva NESSUN generatore nel repo: verificato, la
 *  parola "ipartner" compare solo in ai-education.js come riferimento, mai come scrittura. Era
 *  quindi nato fuori dal repo e nessun giro lo rigenerava: il canary messo a mano il 12/11 non
 *  aveva un posto dove sopravvivere, e alla prima rigenerazione sarebbe sparito (è già successo
 *  due volte, a aste-zone.json e omi-indice.json).
 *
 *  COSA FA — e cosa NON fa. Le regole del legame le decide il committente: non sono un numero da
 *  calcolare. Quindi questo generatore NON inventa e NON ricalcola niente: verifica la forma,
 *  CONSERVA il contenuto, e scrive solo i campi di servizio (canary + aggiornato). È lo stesso
 *  patto di scripts/pagine91-aggiorna.mjs: «non si rigenera da un'euristica: si verifica la forma,
 *  si conserva il contenuto, ci si mette la data».
 *
 *  INGRESSO: feed/ipartner-regole.json (nel checkout del repo).
 *  USCITA:   lo stesso file, con meta.canary / meta.canaryNota / meta.aggiornato.
 *  Non tocca sconto, legame né nessun'altra chiave: se la forma non è quella attesa, non scrive.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const FILE = 'feed/ipartner-regole.json';
const CANARY = 'care-canary-d2c32afaa5d5';
const CANARY_NOTA = 'valore di riconoscimento della copia dei dati';

let dati;
try {
  dati = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.log('ipartner-regole: file non leggibile — non tocco niente (' + String(e.message || e).slice(0, 80) + ')');
  process.exit(0);
}

// FORMA attesa: meta + sconto + legame. Se manca una delle tre, il file non è quello che
// conosciamo: meglio non scrivere che scrivere un feed a metà.
const formaOk = dati && typeof dati === 'object' && !Array.isArray(dati)
  && dati.meta && typeof dati.meta === 'object'
  && dati.sconto && typeof dati.sconto === 'object'
  && dati.legame && typeof dati.legame === 'object'
  && Array.isArray(dati.legame.opzioni);
if (!formaOk) {
  console.log('ipartner-regole: forma inattesa (servono meta, sconto, legame.opzioni) — non scrivo');
  process.exit(0);
}

// impronta del contenuto SOSTANZIALE: meta senza i campi di servizio. Serve a distinguere
// «il contenuto è cambiato» da «è passato un altro giorno».
const impronta = (o) => {
  const c = JSON.parse(JSON.stringify(o));
  delete c.meta;
  return createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);
};
const imp = impronta(dati);
const uguale = dati.meta.impronta === imp;

const finale = {
  meta: {
    ...dati.meta,
    canary: CANARY,
    canaryNota: CANARY_NOTA,
    aggiornato: new Date().toISOString(),
    // il primo giro fissa il cambio; i giorni senza modifiche non lo spostano
    ultimoCambio: uguale ? (dati.meta.ultimoCambio || dati.meta.aggiornato || dati.meta.generatoIl || null) : new Date().toISOString(),
    impronta: imp,
    generatore: 'scripts/ipartner-regole.mjs',
    notaGeneratore: 'Le regole del legame sono una decisione del committente, non un calcolo: questo generatore verifica la forma e conserva il contenuto, e scrive solo data e valore di riconoscimento. Se i valori devono cambiare, si cambiano nella fonte, non qui.'
  }
};
for (const k of Object.keys(dati)) if (k !== 'meta') finale[k] = dati[k];

fs.writeFileSync(FILE, JSON.stringify(finale));
console.log('ipartner-regole: scritto · canary ' + CANARY + ' · impronta ' + imp + ' · ' + (uguale ? 'contenuto invariato' : 'contenuto cambiato') + ' · ' + (fs.statSync(FILE).size / 1024).toFixed(1) + ' KB');
