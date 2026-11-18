#!/usr/bin/env node
/**
 * aste-indice-watchdog.mjs — sorveglia la freschezza e la COERENZA di `feed/aste-indice/_meta.json`.
 *
 * PERCHÉ ESISTE (18/11/2026): l'edge dà il 404 vero sui lotti inesistenti **solo** se
 * `_meta.completo === true` E `_meta.generato` è più fresco di 24 h E lo shard si legge. Se la meta
 * invecchia (due giri del generatore persi), il 404 smette di funzionare e nessuno se ne accorge
 * finché qualcuno non va a guardare: questo watchdog lo dice PRIMA, con margine per intervenire.
 *
 * SOGLIE (concordate con rotte-edge, che le ha verificate nel ramo edge):
 *   · eta >= 12 h → warn    (un giro saltato: c'è ancora margine)
 *   · eta >= 18 h → allarme (due giri saltati: il 404 cade a 24 h)
 *   · eta >= 24 h → allarme (il 404 è GIÀ caduto: comportamento vecchio in atto)
 *
 * COERENZA (più importante della freschezza): `completo === true` con shard mancanti è più
 * pericoloso di una meta vecchia — la vecchia degrada in modo sicuro, un `completo` falso fa dare
 * 404 su lotti VERI. Quindi si pretende anche `totale > 0` e `shardCount === 64`, e che i 64 shard
 * elencati esistano davvero (letto via API contents, senza scaricarli).
 *
 * USCITA: 0 per ok/warn (il warn si vede nell'allarme su R2 e nel riepilogo), 1 per allarme o
 * incoerenza (un job rosso quando il 404 è in pericolo o già caduto è ciò che si vuole).
 * La meta si legge dalla RAW (la fonte dell'edge), non dalla rotta /feed/.
 */

import fs from 'node:fs';

const REPO = 'PuntoLuce26/care-auctions-pagine';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/main';
const API = 'https://api.github.com/repos/' + REPO;
const UA = 'care-aste-indice-watchdog/1.0 (+https://careauctions.co)';
const SOGLIA_WARN = 12 * 3600 * 1000;
const SOGLIA_ERR = 18 * 3600 * 1000;
const SOGLIA_MAX = 24 * 3600 * 1000;

const iso = () => new Date().toISOString();
const ore = (ms) => (ms / 3600000).toFixed(1);

async function scarica(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now(), { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${url.replace(RAW, 'raw')}`);
  return r;
}

async function main() {
  const meta = await (await scarica(RAW + '/feed/aste-indice/_meta.json')).json();
  const eta = Date.now() - Date.parse(meta.generato);
  const problemi = [];
  const avvisi = [];
  const note = [];

  if (!Number.isFinite(eta)) problemi.push('generato illeggibile: ' + String(meta.generato));
  if (meta.completo !== true) problemi.push('completo != true (l\'edge non dà 404 veri: degrado sicuro)');
  if (!(Number(meta.totale) > 0)) problemi.push('totale non positivo: ' + String(meta.totale));
  if (meta.shardCount !== 64) problemi.push('shardCount != 64: ' + String(meta.shardCount));
  if (meta.shard !== 'hex2') problemi.push('shard != "hex2": ' + String(meta.shard));

  // i 64 shard devono esistere DAVVERO. Si guardano sulla RAW, esattamente come i file che l'edge
  // scarica: una `completo:true` con uno shard mancante è il caso peggiore (404 su lotti veri), e
  // certificare l'esistenza da un'altra fonte (API contents) non proverebbe ciò che vede il consumatore.
  const nomi = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, '0') + '.json');
  const mancanti = [];
  for (let i = 0; i < nomi.length; i += 8) {
    const blocco = nomi.slice(i, i + 8);
    const esiti = await Promise.all(
      blocco.map(async (n) => {
        try {
          const r = await fetch(`${RAW}/feed/aste-indice/${n}`, { method: 'HEAD', headers: { 'User-Agent': UA } });
          return { n, ok: r.ok, stato: r.status };
        } catch (e) {
          return { n, ok: false, stato: 'errore' };
        }
      }),
    );
    for (const e of esiti) if (!e.ok) mancanti.push(e.n + ' (' + e.stato + ')');
  }
  if (mancanti.length) problemi.push(`shard mancanti sulla raw: ${mancanti.length}/64 → ${mancanti.slice(0, 5).join(', ')}${mancanti.length > 5 ? '…' : ''}`);
  note.push(`shard presenti sulla raw: ${64 - mancanti.length}/64`);

  // CAMPIONAMENTO DI ID VERI (obbligatorio, chiusura dell'ultimo buco): il «64/64 presenti» può essere
  // verde mentre l'indice è incompleto — se un id VERO non c'è, l'edge dà 404 su una scheda buona.
  // Si prendono 20 id da uno shard di sitemap (seed fisso: ordinati e presi ogni N), si legge per
  // ciascuno il suo shard `id % 64` dalla raw e si pretende la presenza. Si verifica anche che un id
  // fittizio sia assente: sarebbe indicizzazione di pagine fantasma.
  let campioneTxt = 'campione: non verificabile';
  try {
    const sm = await (await fetch('https://careauctions.co/sitemap-aste-it-0.xml?ts=' + Date.now(), { headers: { 'User-Agent': UA } })).text();
    // 18/11/2026 — gli id veri NON arrivano da URL `/aste/<id>`: lo shard di sitemap dei lotti
    // (`sitemap-aste-it-0.xml`, 10.000 <loc>) porta gli URL delle procedure → `.../asta-<id>.html`.
    // Misurato: quegli id sono id di lotto e stanno nell'indice (169043, 591541, 1136487 verificati).
    // Si accettano entrambe le forme, così se un giorno cambia il formato non si resta ciechi.
    const grezzi = [...sm.matchAll(/\/aste\/(\d+)/g), ...sm.matchAll(/asta-(\d+)\.html/g)].map((m) => m[1]);
    const tutti = [...new Set(grezzi)].sort((a, b) => Number(a) - Number(b));
    const passo = Math.max(1, Math.floor(tutti.length / 20));
    const campione = [];
    for (let i = 0; i < tutti.length && campione.length < 20; i += passo) campione.push(tutti[i]);

    const perShard = new Map();
    for (const id of campione) {
      const chiave = (Number(id) % 64).toString(16).padStart(2, '0');
      if (!perShard.has(chiave)) perShard.set(chiave, []);
      perShard.get(chiave).push(id);
    }
    const fittizio = '999999999';
    const chiaveFinta = (Number(fittizio) % 64).toString(16).padStart(2, '0');
    if (!perShard.has(chiaveFinta)) perShard.set(chiaveFinta, []);

    let presenti = 0;
    let nonVerificabili = 0;
    let falsoAssente = false;
    const assenti = [];
    let letti = 0;
    for (const [chiave, ids] of perShard) {
      let lotti = null;
      try {
        const r = await fetch(`${RAW}/feed/aste-indice/${chiave}.json`, { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        lotti = j.lotti || {};
        letti += 1;
      } catch (e) {
        nonVerificabili += ids.length;
        continue;
      }
      for (const id of ids) {
        if (lotti[id]) presenti += 1;
        else assenti.push(id);
      }
      if (chiave === chiaveFinta) falsoAssente = !lotti[fittizio];
    }
    // 18/11/2026 — CANONICAL DELLA LEGACY (decisione del Lead, non ancora deployata): ogni URL legacy
    // in sitemap deve dichiarare il canonical verso la pagina dell'app `/aste/<id>`. Se manca NON è un
    // KO: il deployment è in corso e un rosso cronico sarebbe rumore. Si dichiara e si va avanti.
    let conCanonical = 0;
    let legacyProvate = 0;
    for (const id of campione) {
      if (!id) continue;
      try {
        const r = await fetch(`https://careauctions.co/asta-procedura/it/asta-${id}.html`, { headers: { 'User-Agent': UA } });
        if (!r.ok) continue;
        const html = await r.text();
        legacyProvate += 1;
        const m = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
        const href = m ? (m[0].match(/href=["']([^"']+)["']/i) || [])[1] || '' : '';
        if (href.replace(/\/$/, '') === `https://careauctions.co/aste/${id}`) conCanonical += 1;
      } catch {
        /* pagina legacy non leggibile: non si dichiara nulla */
      }
    }
    if (legacyProvate > 0 && conCanonical < legacyProvate) {
      avvisi.push(`canonical legacy: ${conCanonical}/${legacyProvate} verso /aste/<id> (mancano ${legacyProvate - conCanonical}) — pagina legacy in sitemap senza canonical all'app`);
    }
    note.push(`canonical: ${conCanonical}/${legacyProvate} verso /aste/<id>`);

    if (assenti.length) {
      problemi.push(`id ${assenti[0]} presente in sitemap e ASSENTE dall'indice: l'edge darebbe 404 su una scheda vera${assenti.length > 1 ? ' (+' + (assenti.length - 1) + ' altri)' : ''}`);
    }
    if (perShard.has(chiaveFinta) && !falsoAssente && letti > 0) problemi.push('id fittizio 999999999 PRESENTE nell\'indice: pagine fantasma indicizzabili');
    campioneTxt = `campione: ${presenti}/${campione.length - nonVerificabili} presenti${nonVerificabili ? ' (' + nonVerificabili + ' non verificabili)' : ''} · falso ${falsoAssente ? 'assente' : 'NON verificato'} · shard letti ${letti}`;
  } catch (e) {
    campioneTxt = 'campione: non verificabile (' + String((e && e.message) || e) + ')';
  }
  note.push(campioneTxt);

  const livello = problemi.length ? 'allarme' : eta >= SOGLIA_ERR ? 'allarme' : avvisi.length ? 'warn' : eta >= SOGLIA_WARN ? 'warn' : 'ok';
  const messaggio =
    `aste-indice: eta meta ${ore(eta)} h · completo=${meta.completo} · totale=${meta.totale} · shardCount=${meta.shardCount}` +
    (problemi.length ? ' · PROBLEMI: ' + problemi.join('; ') : '') +
    (avvisi.length ? ' · AVVISI: ' + avvisi.join('; ') : '') +
    (note.length ? ' · ' + note.join('; ') : '') +
    (eta >= SOGLIA_MAX ? ' · IL 404 VERO È GIÀ CADUTO (>24 h)' : '');

  console.log(`[aste-indice] livello=${livello} · ${messaggio}`);
  if (livello !== 'ok') console.log(`::warning title=aste-indice watchdog::${messaggio}`);
  else console.log('::notice title=aste-indice watchdog::meta fresca e coerente');

  // allarme su R2 (niente issue: il repo pubblico le ha disabilitate, CL-50)
  try {
    const mod = await import('./stato-pubblica.mjs');
    const prev = await mod.leggiStato('allarmi/aste-indice.json');
    const vecchi = prev && prev.ok && prev.json && Array.isArray(prev.json.allarmi) ? prev.json.allarmi : [];
    const runId = process.env.GITHUB_RUN_ID || null;
    const voce = {
      generato: iso(),
      workflow: 'aste-indice-watchdog',
      livello,
      messaggio: messaggio.slice(0, 300),
      runId,
      runUrl: runId && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : null,
    };
    const allarmi = [voce, ...vecchi].slice(0, 20);
    fs.writeFileSync('/tmp/allarme-aste-indice.json', JSON.stringify({ ...voce, allarmi }, null, 1) + '\n');
    const pub = await mod.pubblicaStato('/tmp/allarme-aste-indice.json', { chiave: 'allarmi/aste-indice.json' });
    console.log('allarme registrato su R2:', (pub && pub.key) || 'stato/allarmi/aste-indice.json', '·', allarmi.length, 'voci');
  } catch (e) {
    console.error('R2 non aggiornato (' + String((e && e.message) || e) + '): il giudizio resta valido, la traccia no');
  }

  process.exitCode = livello === 'allarme' ? 1 : 0;
}

main().catch((e) => {
  console.error('[fatal] ' + String((e && e.stack) || e));
  process.exitCode = 1;
});
