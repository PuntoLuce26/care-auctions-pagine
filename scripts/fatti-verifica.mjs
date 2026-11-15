#!/usr/bin/env node
/**
 * scripts/fatti-verifica.mjs — controlla gli artefatti di scripts/fatti-genera.mjs.
 * Non scrive niente: legge, misura e stampa. Esce 1 se qualcosa non torna.
 *
 * Controlla, in ordine:
 *   1) ai/fatti.json è JSON valido, è un array di fatti dentro { meta, fatti }
 *   2) quanti fatti mancano di fonte / rilevazione / copertura / url_fonte  → deve essere 0
 *   3) ogni frase contiene numero + «Fonte:» + «Rilevazione:» + «Copertura:»
 *   4) fatti/index.html contiene le stesse frasi nel testo visibile (tolti <script>/<style>)
 *   5) i blocchi application/ld+json si parsano e sono Dataset + FAQPage
 *
 * Uso: node scripts/fatti-verifica.mjs [--root=<dir>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const QUI = dirname(fileURLToPath(import.meta.url));

function argomento(nome) {
  const prefisso = `--${nome}=`;
  const trovato = process.argv.find((a) => a.startsWith(prefisso));
  return trovato ? trovato.slice(prefisso.length) : null;
}

const RADICE = resolve(argomento('root') || process.env.CARE_FATTI_ROOT || join(QUI, '..'));
const FILE_FATTI = join(RADICE, 'ai', 'fatti.json');
const FILE_PAGINA = join(RADICE, 'fatti', 'index.html');

const problemi = [];
const nota = (msg) => console.log(`  ${msg}`);

for (const file of [FILE_FATTI, FILE_PAGINA]) {
  if (!existsSync(file)) {
    console.error(`MANCA: ${file}`);
    process.exit(1);
  }
}

/* 1-3) JSON dei fatti ------------------------------------------------ */

console.log('— ai/fatti.json');
const documento = JSON.parse(readFileSync(FILE_FATTI, 'utf8'));
const fatti = Array.isArray(documento.fatti) ? documento.fatti : [];
if (!Array.isArray(documento.fatti)) problemi.push('ai/fatti.json non contiene un array «fatti»');
if (!documento.meta || !documento.meta.generato) problemi.push('ai/fatti.json non contiene meta.generato');
if (documento.meta && !documento.meta.canary) problemi.push('ai/fatti.json non contiene meta.canary');

const mancanti = { fonte: [], rilevazione: [], copertura: [], url_fonte: [] };
const senzaFormato = [];
for (const f of fatti) {
  for (const campo of Object.keys(mancanti)) {
    if (!f[campo] || String(f[campo]).trim() === '') mancanti[campo].push(f.id);
  }
  if (!/Fonte:/.test(String(f.frase)) || !/Rilevazione:/.test(String(f.frase)) || !/Copertura:/.test(String(f.frase))) {
    senzaFormato.push(f.id);
  }
  if (typeof f.valore !== 'number' || !Number.isFinite(f.valore)) problemi.push(`valore non numerico in ${f.id}`);
}

nota(`fatti: ${fatti.length}`);
for (const [campo, elenco] of Object.entries(mancanti)) {
  nota(`fatti senza ${campo}: ${elenco.length}${elenco.length ? ` → ${elenco.join(', ')}` : ''}`);
  if (elenco.length) problemi.push(`${elenco.length} fatti senza ${campo}`);
}
nota(`fatti con frase fuori formato (Fonte/Rilevazione/Copertura): ${senzaFormato.length}`);
if (senzaFormato.length) problemi.push(`${senzaFormato.length} frasi fuori formato`);
nota(`totale fatti dichiarato in meta: ${documento.meta?.totaleFatti}`);
nota(`non emessi dichiarati: ${(documento.meta?.nonEmessi || []).length}`);
if (documento.meta?.totaleFatti !== fatti.length) problemi.push('meta.totaleFatti non corrisponde al numero di fatti');

/* 4) Testo visibile dell'HTML --------------------------------------- */

console.log('— fatti/index.html');
const html = readFileSync(FILE_PAGINA, 'utf8');
const senzaScript = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
const testoVisibile = senzaScript
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

nota(`caratteri di testo visibile (senza <script>/<style>): ${testoVisibile.length}`);
nota(`fatti presenti nel testo visibile: ${fatti.filter((f) => testoVisibile.includes(f.frase)).length} su ${fatti.length}`);

const assentiVisibili = fatti.filter((f) => !testoVisibile.includes(f.frase)).map((f) => f.id);
if (assentiVisibili.length) problemi.push(`frasi non nel testo visibile: ${assentiVisibili.join(', ')}`);

if (!/dateModified:/.test(testoVisibile)) problemi.push('manca la riga dateModified nel testo visibile');
if (!/Provenienza del blocco:/.test(testoVisibile)) problemi.push('manca la riga di provenienza del blocco');
if (/<script(?![^>]*type="application\/ld\+json")/i.test(html.replace(/<\/?script[^>]*>/gi, (m) => m))) {
  const altriScript = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/application\/ld\+json/i.test(m[1]));
  if (altriScript.length) problemi.push(`la pagina contiene ${altriScript.length} <script> eseguibile: deve essere statica, zero JS`);
} else {
  nota('script eseguibili: 0 (solo JSON-LD)');
}

/* 5) JSON-LD -------------------------------------------------------- */

console.log('— JSON-LD');
const blocchi = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
nota(`blocchi application/ld+json: ${blocchi.length}`);
if (!blocchi.length) problemi.push('nessun blocco application/ld+json');

const tipi = [];
let faq = null;
for (const [indice, blocco] of blocchi.entries()) {
  let parsato;
  try {
    parsato = JSON.parse(blocco);
  } catch (errore) {
    problemi.push(`JSON-LD #${indice + 1} non è JSON valido: ${errore.message}`);
    continue;
  }
  tipi.push(parsato['@type']);
  if (parsato['@type'] === 'FAQPage') faq = parsato;
  nota(`JSON-LD #${indice + 1}: @type=${parsato['@type']} valido (${blocco.length} byte)`);
}

if (!tipi.includes('Dataset')) problemi.push('manca il JSON-LD Dataset');
if (!tipi.includes('FAQPage')) problemi.push('manca il JSON-LD FAQPage');

if (faq) {
  const domande = Array.isArray(faq.mainEntity) ? faq.mainEntity : [];
  const risposte = domande.filter((q) => typeof q.acceptedAnswer?.text === 'string' && q.acceptedAnswer.text.length > 40);
  nota(`FAQPage: ${domande.length} domande, ${risposte.length} con risposta completa`);
  if (risposte.length !== fatti.length) problemi.push(`FAQPage: ${risposte.length} risposte per ${fatti.length} fatti`);
  const domandaCatalogo = domande.find((q) => q.name === 'Quante aste giudiziarie ci sono in Italia?');
  if (!domandaCatalogo) problemi.push('FAQPage: manca la domanda «Quante aste giudiziarie ci sono in Italia?»');
  else if (!/^Al \d{2}\/\d{2}\/\d{4}.*Fonte:.*Rilevazione:.*Copertura:/.test(domandaCatalogo.acceptedAnswer.text)) {
    problemi.push('FAQPage: la risposta alla domanda sul catalogo non ha il formato numero+fonte+rilevazione+copertura');
  }
}

/* Esito ------------------------------------------------------------- */

console.log('');
if (problemi.length) {
  console.error(`VERIFICA FALLITA: ${problemi.length} problema/i`);
  for (const p of problemi) console.error(`  · ${p}`);
  process.exit(1);
}
console.log(`VERIFICA OK — ${fatti.length} fatti, 0 senza fonte, ${testoVisibile.length} caratteri di testo visibile, JSON-LD valido.`);
