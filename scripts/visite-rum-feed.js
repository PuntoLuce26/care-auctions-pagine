#!/usr/bin/env node
/** visite-rum-feed.js — pubblica feed/visite-rum.json copiando la lettura RUM del worker icare-ai.
 *
 *  PERCHÉ ESISTE (misurato il 12/11/2026): la raccolta è viva — la KV `visite_rum` del worker
 *  icare-ai (azione `visite-rum`) era aggiornata alle 2026-11-12T00:00:11Z con 24 giorni /
 *  5.000 visite / 5.590 pagine viste — mentre `feed/visite-rum.json` servito era fermo alle
 *  2026-11-07T18:43:47Z con 22 giorni / 3.040 visite / 3.890 pv. Fra la KV e il feed non c'era
 *  nessun ponte: il file era stato scritto una volta a mano (commit 467d2bbc, [Sam 5.9]) e
 *  nessun workflow né script lo nominava (`grep -rl "visite-rum" .github/workflows/ scripts/`
 *  → 0 file). Questo script è quel ponte.
 *
 *  COSA FA, in ordine:
 *   1. POST al worker icare-ai {azione:'visite-rum', chiave:REGIA_KEY} → legge la KV
 *   2. valida i dati (aggiornato, giorni non vuoti, totale numerico, somma coerente col totale)
 *      — se la raccolta è muta o incoerente NON scrive niente e fallisce (run rossa), perché
 *      un feed fermo si dichiara, non si stima
 *   3. se la KV è più vecchia di VISITE_RUM_STALE_MIN minuti (default 1500 ≈ 25 h, la raccolta
 *      del worker è quotidiana) forza la raccolta con {azione:'visite-rum-aggiorna'} e rilegge:
 *      così, quando la veglia dispatcha questo workflow perché l'artefatto è vecchio, il giro
 *      RIPARA davvero invece di ricopiare lo stesso dato stantio
 *   4. scrive feed/visite-rum.json con lo schema già in uso (aggiornato, fonte, nota, totale, giorni)
 *
 *  NUMERI: tutti e soli quelli della KV. Nessuna stima, nessun arrotondamento, nessun «zero»
 *  per i giorni senza dati (i giorni assenti restano assenti).
 */
const fs = require('fs');
const path = require('path');

const WORKER = 'https://icare-ai.misty-mode-1cbc.workers.dev';
const CHIAVE = process.env.REGIA_KEY || '';
const FILE = path.join(process.cwd(), 'feed', 'visite-rum.json');
const NOTA =
  'pagine viste (pv) e visite/sessioni (visite) per giorno; i visitatori unici esatti sono nel pannello Web Analytics';
const STALE_MIN = Number(process.env.VISITE_RUM_STALE_MIN || 1500);

async function chiama(azione) {
  const r = await fetch(WORKER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ azione, chiave: CHIAVE }),
  });
  const testo = await r.text();
  let j = null;
  try {
    j = JSON.parse(testo);
  } catch (e) {
    j = null;
  }
  return { http: r.status, j, testo };
}

/** Valida la lettura della KV. Ritorna il numero di giorni; lancia se il dato non è pubblicabile. */
function valida(d, provenienza) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${provenienza}: risposta senza dati`);
  if (typeof d.aggiornato !== 'string' || !Number.isFinite(Date.parse(d.aggiornato))) {
    throw new Error(`${provenienza}: campo «aggiornato» assente o non data`);
  }
  if (!d.giorni || typeof d.giorni !== 'object' || Array.isArray(d.giorni)) throw new Error(`${provenienza}: «giorni» assente`);
  const chiavi = Object.keys(d.giorni);
  if (chiavi.length === 0) throw new Error(`${provenienza}: «giorni» vuoto — raccolta non attiva, non pubblico`);
  if (!d.totale || typeof d.totale.visite !== 'number' || typeof d.totale.pv !== 'number') {
    throw new Error(`${provenienza}: «totale» non numerico`);
  }
  let pv = 0;
  let visite = 0;
  for (const k of chiavi) {
    const g = d.giorni[k] || {};
    pv += Number(g.pv) || 0;
    visite += Number(g.visite) || 0;
  }
  if (pv !== d.totale.pv || visite !== d.totale.visite) {
    throw new Error(
      `${provenienza}: incoerenza — somma giorni pv=${pv} visite=${visite} vs totale pv=${d.totale.pv} visite=${d.totale.visite}`
    );
  }
  return { giorni: chiavi.length, pv, visite };
}

function leggiPubblicato() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function main() {
  if (!CHIAVE) throw new Error('REGIA_KEY assente: senza chiave il worker risponde 403');
  if (!fs.existsSync(path.dirname(FILE))) throw new Error(`cartella assente: ${path.dirname(FILE)}`);

  let a = await chiama('visite-rum');
  if (a.http !== 200 || !a.j || a.j.ok !== true) {
    throw new Error(`lettura KV fallita: HTTP ${a.http} — ${String(a.testo || '').slice(0, 300)}`);
  }
  let d = a.j.dati;
  let v = valida(d, 'KV visite_rum');
  console.log(`KV: aggiornato ${d.aggiornato} · ${v.giorni} giorni · ${v.visite} visite · ${v.pv} pv`);

  const etaMin = Math.round((Date.now() - Date.parse(d.aggiornato)) / 60000);
  if (etaMin > STALE_MIN) {
    console.log(`KV ferma da ${etaMin} min (> ${STALE_MIN}): forzo la raccolta con «visite-rum-aggiorna»`);
    const b = await chiama('visite-rum-aggiorna');
    if (b.http !== 200 || !b.j || b.j.ok !== true) {
      throw new Error(`raccolta forzata fallita: HTTP ${b.http} — ${String(b.testo || '').slice(0, 300)}`);
    }
    a = await chiama('visite-rum');
    if (a.http !== 200 || !a.j || a.j.ok !== true) {
      throw new Error(`rilettura KV fallita: HTTP ${a.http} — ${String(a.testo || '').slice(0, 300)}`);
    }
    d = a.j.dati;
    v = valida(d, 'KV visite_rum dopo la forzatura');
    console.log(`KV dopo la forzatura: aggiornato ${d.aggiornato} · ${v.giorni} giorni · ${v.visite} visite · ${v.pv} pv`);
  }

  const out = {
    aggiornato: d.aggiornato,
    fonte: d.fonte || 'Cloudflare Web Analytics (RUM)',
    nota: NOTA,
    totale: { giorni: v.giorni, pv: v.pv, visite: v.visite },
    giorni: d.giorni,
  };

  const prima = leggiPubblicato();
  const uguale = prima && JSON.stringify(prima) === JSON.stringify(out);
  if (uguale) {
    console.log('feed/visite-rum.json è già allineato alla KV: nessuna scrittura');
    return;
  }

  fs.writeFileSync(FILE, JSON.stringify(out, null, 1) + '\n');
  const primaTxt = prima ? `${prima.aggiornato} · ${prima.totale && prima.totale.giorni} giorni` : 'assente';
  console.log(`scritto feed/visite-rum.json (prima: ${primaTxt})`);
  console.log(`::notice title=visite-rum::aggiornato ${out.aggiornato} · ${v.giorni} giorni · ${v.visite} visite · ${v.pv} pv`);
}

main().catch((e) => {
  console.error(`::error title=visite-rum::${e.message}`);
  process.exitCode = 1;
});
