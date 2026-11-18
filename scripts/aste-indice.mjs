#!/usr/bin/env node
/**
 * aste-indice.mjs — indice dei lotti COMPATTO per l'edge (shard da 64).
 *
 * PERCHÉ ESISTE (18/11/2026): l'API item dell'app sbaglia (/api/aste/item/4647423 → 404 con il
 * lotto che esiste) e Googlebot riceve il titolo della home. L'edge ha bisogno di un indice NOSTRO,
 * piccolo, che dica «questo id esiste, ecco titolo/città/tribunale/prezzo/data» senza chiamare
 * l'app e senza scaricare i 106 file regionali (~370 MB).
 *
 * FONTE: `feed/indice.json` elenca i file regionali (filesImm + filesMob). Ogni file è un array di
 * lotti {id, tipo, titolo, prezzoBase, minima, dataAsta, regione, citta, tribunale, link}.
 * NON esiste `provincia`: non si inventa — si usano città + tribunale.
 *
 * USCITA: `feed/aste-indice/<NN>.json` con NN = (Number(id) % 64) in esadecimale minuscolo a 2 cifre,
 * forma {"generato","n","lotti":{"<id>":{"t","c","tr","pb","d"}}}, più `feed/aste-indice/_meta.json`.
 *
 * REGOLE
 *   · `completo` è true SOLO se tutti i file elencati sono stati letti senza errori: è la condizione
 *     che autorizza l'edge a dare 404 veri. Un file che manca o è troncato → completo:false nel log.
 *   · nessun file viene cancellato: si riscrive solo dentro `feed/aste-indice/`.
 *   · exit 0 solo se completo && totale >= 300.000 (guardia anti-troncamento); 2 altrimenti.
 *   · shard sotto 1,5 MB: se la misura sfora lo si dice e si passa a 128 (ASTE_INDICE_SHARD).
 */

import fs from 'node:fs';
import path from 'node:path';

const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/feed/';
const SHARD = Number(process.env.ASTE_INDICE_SHARD || 64);
const MAX_SHARD_BYTES = 1.5 * 1024 * 1024;
const MIN_TOTALE = 300000;
const CONCORRENZA = 6;
const OUT = 'feed/aste-indice';
const LIMITE = Number(process.env.ASTE_INDICE_LIMIT || 0); // collaudo locale: primi N file

const iso = () => new Date().toISOString();
const hh = (n) => n.toString(16).padStart(2, '0');

async function scarica(nome) {
  const r = await fetch(RAW + nome + '?ts=' + Date.now(), { headers: { 'User-Agent': 'care-aste-indice/1.0 (+https://careauctions.co)' } });
  if (!r.ok) throw new Error(`${nome}: HTTP ${r.status}`);
  const testo = await r.text();
  let j;
  try {
    j = JSON.parse(testo);
  } catch {
    throw new Error(`${nome}: JSON non valido (${testo.length} byte)`);
  }
  const a = Array.isArray(j) ? j : j.aste || j.lotti || Object.values(j).find(Array.isArray);
  if (!Array.isArray(a)) throw new Error(`${nome}: nessun array di lotti`);
  return a;
}

function elencoFile(indice) {
  const out = [];
  for (const [regione, v] of Object.entries(indice.regioni || {})) {
    for (const f of [...(v.filesImm || []), ...(v.filesMob || [])]) out.push({ f, regione });
  }
  return out;
}

function data(x) {
  const s = String(x || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function main() {
  const indice = JSON.parse(fs.readFileSync('feed/indice.json', 'utf8'));
  let file = elencoFile(indice);
  if (LIMITE > 0) file = file.slice(0, LIMITE);
  console.log(`fonte: feed/indice.json · ${file.length} file regionali · ${SHARD} shard`);

  const shards = new Map();
  const errori = [];
  let letti = 0;
  let minAsta = null;
  let maxAsta = null;

  for (let i = 0; i < file.length; i += CONCORRENZA) {
    const blocco = file.slice(i, i + CONCORRENZA);
    const esiti = await Promise.all(
      blocco.map(async ({ f }) => {
        try {
          return { f, lotti: await scarica(f) };
        } catch (e) {
          return { f, errore: String((e && e.message) || e) };
        }
      }),
    );
    for (const e of esiti) {
      if (e.errore) {
        errori.push(e.errore);
        continue;
      }
      letti += 1;
      for (const lotto of e.lotti) {
        const id = String((lotto && lotto.id) || '').trim();
        if (!id || !Number.isFinite(Number(id))) continue;
        const chiave = hh(Number(id) % SHARD);
        let s = shards.get(chiave);
        if (!s) {
          s = {};
          shards.set(chiave, s);
        }
        const d = data(lotto.dataAsta);
        if (d) {
          if (!minAsta || d < minAsta) minAsta = d;
          if (!maxAsta || d > maxAsta) maxAsta = d;
        }
        s[id] = {
          t: String(lotto.titolo || '').replace(/\s+/g, ' ').trim(),
          c: String(lotto.citta || '').trim(),
          tr: String(lotto.tribunale || '').trim(),
          pb: Number(lotto.prezzoBase) || 0,
          d,
        };
      }
    }
    process.stdout.write(`\rletti ${letti}/${file.length} file · ${[...shards.values()].reduce((n, s) => n + Object.keys(s).length, 0)} lotti`);
  }
  process.stdout.write('\n');

  fs.mkdirSync(OUT, { recursive: true });
  const generato = iso();
  let totale = 0;
  let shardBytesMax = 0;
  let cambiati = 0;
  for (let n = 0; n < SHARD; n++) {
    const chiave = hh(n);
    const lotti = shards.get(chiave) || {};
    const conteggio = Object.keys(lotti).length;
    const file = path.join(OUT, chiave + '.json');
    totale += conteggio;

    // 18/11/2026 — UN GIRO SENZA NOVITÀ NON DEVE COSTARE 40 MB DI COMMIT.
    // Se il contenuto (i lotti) di questo shard è identico a quello già su disco, il file NON si
    // riscrive: resta la `generato` del giorno in cui è cambiato davvero. Così git vede solo i file
    // che cambiano e `_meta.json` (che invece si scrive sempre, per tenere fresca la freschezza).
    let scrivi = true;
    let byte = 0;
    try {
      const vecchio = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (vecchio && JSON.stringify(vecchio.lotti) === JSON.stringify(lotti)) {
        scrivi = false;
        byte = Buffer.byteLength(JSON.stringify(vecchio));
      }
    } catch {
      /* file assente o illeggibile: si riscrive */
    }
    if (scrivi) {
      const testo = JSON.stringify({ generato, n: conteggio, lotti });
      fs.writeFileSync(file, testo + '\n');
      byte = Buffer.byteLength(testo);
      cambiati += 1;
    } else {
      // garantisce lo schema anche su un file vecchio senza `n` (non riscritto)
      try {
        const vecchio = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (vecchio.n !== conteggio) {
          const testo = JSON.stringify({ generato: vecchio.generato || generato, n: conteggio, lotti });
          fs.writeFileSync(file, testo + '\n');
          byte = Buffer.byteLength(testo);
          cambiati += 1;
        }
      } catch {
        /* niente */
      }
    }
    shardBytesMax = Math.max(shardBytesMax, byte);
  }

  const completo = errori.length === 0 && letti === file.length;
  const meta = {
    generato,
    totale,
    // "hex2" = gli shard sono (Number(id) % 64) scritti in esadecimale minuscolo a 2 cifre
    shard: 'hex2',
    shardCount: SHARD,
    fonte: 'feed/*-imm-*.json',
    completo,
    minAsta,
    maxAsta,
    shardBytesMax,
  };
  fs.writeFileSync(path.join(OUT, '_meta.json'), JSON.stringify(meta, null, 1) + '\n');

  console.log(`shard riscritti ${cambiati}/${SHARD} (gli altri sono identici: non si toccano) · totale ${totale} · shardBytesMax ${(shardBytesMax / 1048576).toFixed(2)} MB · minAsta ${minAsta} · maxAsta ${maxAsta}`);
  if (errori.length) {
    console.error(`completo:false — ${errori.length} file non letti:`);
    for (const e of errori.slice(0, 10)) console.error('  - ' + e);
  }
  if (shardBytesMax > MAX_SHARD_BYTES) console.error(`::warning title=aste-indice::shardBytesMax ${(shardBytesMax / 1048576).toFixed(2)} MB sopra 1,5 MB: passare a 128 shard`);

  if (!completo) {
    console.error('::error title=aste-indice::indice INCOMPLETO (completo:false): non si committa');
    process.exitCode = 2;
    return;
  }
  if (totale < MIN_TOTALE) {
    console.error(`::error title=aste-indice::totale ${totale} < ${MIN_TOTALE}: guardia anti-troncamento, non si committa`);
    process.exitCode = 2;
    return;
  }
  console.log('::notice title=aste-indice::indice completo e pubblicabile');
}

main().catch((e) => {
  console.error('[fatal] ' + String((e && e.stack) || e));
  process.exitCode = 1;
});
