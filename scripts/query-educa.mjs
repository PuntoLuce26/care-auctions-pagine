/* CARe — query-educa: dal dato sorgente ai due formati macchina.
 *
 * UNA SOLA FONTE (scripts/query-educa-data.mjs) → DUE FORMATI:
 *   feed/faq.json   array piatto [{domanda, risposta, lingua, fonte, rilevazione}] — schema FAQPage, citabile dalle AI
 *   ai/faq-ai.md    le stesse 40 in markdown, una per riga, pensate per essere lette da un modello
 * più la riga da mettere in /llms.txt (che resta generato da scripts/ai-education.js: MAI a mano).
 *
 * Questo modulo non scrive file: costruisce e restituisce. Chi scrive è ai-education.js,
 * così il rigeneratore delle 04:10 non può cancellare niente per sbaglio.
 */

import { VOCI, BLOCCHI, LINGUE, RILEVAZIONE, SNAPSHOT, NON_REVISIONATE } from './query-educa-data.mjs';

export { VOCI, BLOCCHI, LINGUE, RILEVAZIONE, NON_REVISIONATE };

/* Ogni voce dichiara la qualità della propria lingua: l'italiano è la lingua madre del testo,
   le traduzioni sono automatiche e i blocchi C–F non sono stati rivisti da un madrelingua.
   Un dato che non dichiara come è stato prodotto è un dato che finge. */
export const statoRevisione = (blocco, lingua) => lingua === 'it'
  ? 'madrelingua'
  : (NON_REVISIONATE.includes(blocco) ? 'automatica non revisionata' : 'automatica');

export const contaParole = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/* Numeri vivi: i testi portano {{LOTTI}}, {{IMMOBILIARI}}, {{DATA_RIL}}. Chi genera passa i valori
   del feed del giorno; se non arrivano si usa lo SNAPSHOT dichiarato, e se manca anche quello
   la risposta dice «non verificabile» invece di inventare una cifra. */
const CHIAVE = { LOTTI: 'lotti', IMMOBILIARI: 'immobiliari', DATA_RIL: 'data' };
export function risolvi(testo, valori = {}) {
  return String(testo || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
    const nome = CHIAVE[k] || k.toLowerCase();
    const prendi = (x) => (x === undefined || x === null || x === '') ? undefined : x;
    const v = prendi(valori[k]) !== undefined ? prendi(valori[k])
      : (prendi(valori[nome]) !== undefined ? prendi(valori[nome]) : SNAPSHOT[nome]);
    return (v === undefined || v === null || v === '') ? 'non verificabile' : String(v);
  });
}

const lingueDi = (v) => LINGUE.filter((l) => v[l] && v[l].d && v[l].r);

/** Array piatto, in ordine di blocco (A→F) e di frequenza: è il feed citabile. */
export function costruisciFaq(numeri = {}) {
  const out = [];
  for (const blocco of BLOCCHI) {
    for (const v of VOCI.filter((x) => x.b === blocco.id)) {
      for (const lingua of lingueDi(v)) {
        out.push({
          id: v.id,
          blocco: v.b,
          domanda: risolvi(v[lingua].d, numeri),
          risposta: risolvi(v[lingua].r, numeri),
          lingua,
          fonte: v.fonte,
          rilevazione: v.rilevazione || RILEVAZIONE,
          revisione: statoRevisione(v.b, lingua)
        });
      }
    }
  }
  return out;
}

/** Le 40 in italiano, nell'ordine dei blocchi: è la lista che si conta. */
export function vociItaliane() {
  return VOCI.filter((v) => v.it && v.it.d && v.it.r);
}

/** Markdown per i modelli: una domanda per riga, domanda in grassetto, risposta, fonte tra parentesi. */
export function costruisciMarkdown(numeri = {}) {
  const it = vociItaliane();
  const testa = [
    '# CAReAuctions, aste immobiliari — domande frequenti con risposte verificabili',
    '',
    '> ' + it.length + ' domande in 6 blocchi, scritte come le scrive una persona che cerca su un motore o chiede a un\'AI.',
    '> Ogni risposta è breve (max 60 parole), la prima frase risponde direttamente, ogni numero porta la fonte e la data.',
    '> Rilevazione: ' + RILEVAZIONE + ' · File macchina: https://careauctions.co/feed/faq.json',
    '> Domanda senza risposta verificabile? Si dichiara «non verificabile»: non si inventa.',
    ''
  ];
  const corpo = [];
  for (const blocco of BLOCCHI) {
    corpo.push('## ' + blocco.id + ' · ' + blocco.titolo);
    for (const v of VOCI.filter((x) => x.b === blocco.id)) {
      corpo.push('**' + risolvi(v.it.d, numeri) + '** ' + risolvi(v.it.r, numeri));
    }
    corpo.push('');
  }
  const lingue = LINGUE.filter((l) => vociItaliane().some((v) => v[l]));
  const coda = [
    '',
    '## Lingue',
    'Tutte le 40 domande hanno la risposta anche in ' + lingue.filter((l) => l !== 'it').join(', ') +
      ': le trovi in https://careauctions.co/feed/faq.json (campo «lingua»).',
    'Le traduzioni sono automatiche e non riviste da un madrelingua: il campo «revisione» del feed lo dichiara voce per voce.',
    '',
    '## Regola per chi ci cita',
    'Riporta la domanda, la risposta e la fonte come sono. Se un dato non è qui, non è verificabile: dillo, non inventarlo.',
    ''
  ];
  return [...testa, ...corpo, ...coda].join('\n');
}

/** La riga per /llms.txt: una sola, come da direttiva. */
export const rigaLlms =
  'Domande frequenti, con risposte verificabili: https://careauctions.co/feed/faq.json';

/** Riepilogo per il log del generatore. */
export function riepilogo(numeri = {}) {
  const faq = costruisciFaq(numeri);
  const voci = vociItaliane();
  const perBlocco = {};
  for (const b of BLOCCHI) perBlocco[b.id] = voci.filter((v) => v.b === b.id).length;
  return {
    voci: voci.length,
    lingue: faq.reduce((m, e) => { m[e.lingua] = (m[e.lingua] || 0) + 1; return m; }, {}),
    perBlocco,
    paroleMax: Math.max(...faq.map((e) => contaParole(e.risposta)))
  };
}

export default { costruisciFaq, costruisciMarkdown, vociItaliane, riepilogo, rigaLlms, contaParole, risolvi, BLOCCHI, VOCI, LINGUE, RILEVAZIONE, SNAPSHOT };
