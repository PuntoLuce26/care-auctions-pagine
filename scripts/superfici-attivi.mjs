#!/usr/bin/env node
/** superfici-attivi.mjs — il job che trovera' la superficie ai lotti ATTIVI.
 *  Perché serve: l'API di ricerca del PVP non ha la superficie e la descrizione non la contiene
 *  (verificato: 0/25). Il dato sta nella PERIZIA allegata al lotto, che si scopre solo dal
 *  dettaglio del lotto. Quindi: per ogni lotto attivo residenziale senza mq → dettaglio →
 *  trova l'allegato PERIZ → scarica il PDF → pdftotext → estrae i mq → cache.
 *  Ingresso: feed/ocr-priorita.json (lista lotti senza superficie) + cache feed/superfici-attivi.json
 *  Uscita: cache aggiornata. Girando ogni 30 minuti completa i 884 lotti in poche ore.
 *  Regola: se il PDF non ha una superficie leggibile, il lotto resta senza mq. Mai stimare. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const N = Number(process.env.SUP_N || 120);
const CACHE = 'feed/superfici-attivi.json';
const PRIO = 'feed/ocr-priorita.json';
const DETAIL = 'https://careauctions.co/api/pvp-documenti/';
const UA = { 'User-Agent': 'Mozilla/5.0 (CARe-superfici)' };

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')).lotti || {}; } catch (e) {}
const prio = JSON.parse(fs.readFileSync(PRIO, 'utf8'));
const ids = (prio.ids || []).map(String);

const haPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
console.log('in coda:', ids.length, '· già in cache:', Object.keys(cache).length, '· pdftotext:', haPdftotext ? 'sì' : 'NO (solo download)');

async function scarica(url, max = 30 * 1024 * 1024) {
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length <= max ? buf : null;
}

function estraiMq(testo) {
  const re = /(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:m2|m²|mq|metri\s+quadrati)\b/gi;
  const trovati = [];
  let m;
  while ((m = re.exec(testo)) !== null && trovati.length < 30) {
    const v = Number(String(m[1]).replace(/\./g, '').replace(',', '.'));
    if (v >= 10 && v <= 5000) trovati.push({ mq: v, contesto: testo.slice(Math.max(0, m.index - 50), m.index + 30).replace(/\s+/g, ' ').trim() });
  }
  if (!trovati.length) return null;
  const mq = Math.max(...trovati.map((x) => x.mq));
  return { mq, trovati: trovati.length, contesto: trovati[0].contesto };
}

let fatti = 0, conMq = 0, senzaPerizia = 0, errori = 0;
for (const id of ids) {
  if (fatti >= N) break;
  if (cache[id] && cache[id].mq) continue;
  try {
    const det = await (await fetch(DETAIL + id, { headers: UA })).json();
    const perizie = (det.allegati || []).filter((a) => String(a.t || '').toUpperCase() === 'PERIZ' && a.u);
    if (!perizie.length) { cache[id] = { mq: null, motivo: 'nessuna perizia allegata' }; senzaPerizia++; fatti++; continue; }
    const pdf = await scarica(perizie[0].u);
    if (!pdf) { cache[id] = { mq: null, motivo: 'pdf non scaricabile' }; errori++; fatti++; continue; }
    if (!haPdftotext) { cache[id] = { mq: null, motivo: 'pdftotext assente sul sistema' }; fatti++; continue; }
    const tmp = '/tmp/sup-' + process.pid + '.pdf';
    fs.writeFileSync(tmp, pdf);
    let testo = '';
    try { testo = execFileSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000 }); } catch (e) { testo = ''; }
    try { fs.unlinkSync(tmp); } catch (e) {}
    const r = estraiMq(testo || '');
    if (r) { cache[id] = { mq: r.mq, trovati: r.trovati, contesto: r.contesto, quando: new Date().toISOString() }; conMq++; }
    else { cache[id] = { mq: null, motivo: 'superficie non leggibile nella perizia', quando: new Date().toISOString() }; }
    fatti++;
    if (fatti % 20 === 0) console.log(' fatti', fatti, '· con mq', conMq);
  } catch (e) { errori++; fatti++; }
}

const meta = {
  generatoIl: new Date().toISOString(),
  fonte: 'PVP — dettaglio lotto e perizia allegata (PDF), estrazione con pdftotext',
  metodo: 'Per ogni lotto attivo senza superficie: dettaglio PVP → allegato PERIZ → PDF → pdftotext → valore massimo tra i mq trovati (10-5000). Nessuna stima: se la perizia non riporta la superficie, il lotto resta senza.',
  lotti: Object.keys(cache).length,
  conMq: Object.values(cache).filter((x) => x.mq).length
};
fs.writeFileSync(CACHE, JSON.stringify({ meta, lotti: cache }));
console.log(`giro: ${fatti} lotti esaminati · con mq: ${conMq} · senza perizia: ${senzaPerizia} · errori: ${errori}`);
console.log('cache:', meta.lotti, 'lotti ·', meta.conMq, 'con superficie ·', (fs.statSync(CACHE).size / 1024).toFixed(0), 'KB');
