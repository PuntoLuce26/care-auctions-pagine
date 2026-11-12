#!/usr/bin/env node
/**
 * stato-pubblica.mjs — porta i file di STATO INTERNO su Cloudflare R2 (bucket `care-stato`).
 *
 * PERCHÉ ESISTE (12/11/2026)
 * I file di stato (mail/, perf/, qa/) generano decine di commit al giorno sul repo PUBBLICO
 * `care-auctions-pagine`. Ogni commit nuovo cancella la build Pages in corso (misurate 7 build
 * cancellate in mezz'ora il 12/11) e `mail/stato.json` porta soggetti di mail in un repo pubblico.
 * Lo stato non è prodotto: il suo posto è un bucket, non il git.
 *
 * CONTRATTO (stabile, lo usano i workflow e i lettori):
 *   · bucket      `care-stato`            (override: --bucket / CF_BUCKET)
 *   · prefisso    `stato/`                (override: --prefisso)
 *   · chiave      `stato/` + percorso     es. mail/stato.json → stato/mail/stato.json
 *   · account     d5d20864ee7f83c32c9eeb5fcbda6edb (override: --account / CF_ACCOUNT_ID)
 *   · token       CLOUDFLARE_API_TOKEN (oppure CF_API_TOKEN) — MAI nel repo, sempre da secret.
 *
 * NIENTE CHIAVI S3, NIENTE boto3: si usa l'API Cloudflare R2 via Bearer.
 *   PUT  /accounts/<acc>/r2/buckets/<bucket>/objects/<key>
 *   GET  /accounts/<acc>/r2/buckets/<bucket>/objects/<key>          (corpo)
 *   GET  /accounts/<acc>/r2/buckets/<bucket>/objects?prefix=<key>   (metadati: size, uploaded)
 *
 * USO (workflow)
 *   node scripts/stato-pubblica.mjs mail/stato.json --verifica
 *   node scripts/stato-pubblica.mjs perf/stato.json --chiave perf/stato.json
 * USO (lettura)
 *   node scripts/stato-pubblica.mjs --leggi qa/stato.json
 *
 * USO (modulo)
 *   import { pubblicaStato, leggiStato } from './stato-pubblica.mjs';
 *
 * ZERO DIPENDENZE: solo `node:fs` e `fetch` (Node >= 18). Nessuna scrittura locale.
 *
 * REGOLE
 *   · un JSON vuoto o illeggibile NON si pubblica (sarebbe uno stato corrotto, invisibile):
 *     si esce con codice 1 e lo si dice. `--forza` è l'unica deroga, dichiarata.
 *   · il token non viene MAI stampato, né in chiaro né nei messaggi d'errore.
 *   · `--verifica` rilegge i metadati dall'API: la prova è l'oggetto su R2, non l'HTTP 200.
 */

import fs from 'node:fs';
import path from 'node:path';

export const ACCOUNT_DEFAULT = 'd5d20864ee7f83c32c9eeb5fcbda6edb';
export const BUCKET_DEFAULT = 'care-stato';
export const PREFISSO_DEFAULT = 'stato/';
const API = 'https://api.cloudflare.com/client/v4';

const token = (o = {}) => o.token || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
const account = (o = {}) => o.account || process.env.CF_ACCOUNT_ID || ACCOUNT_DEFAULT;
const bucket = (o = {}) => o.bucket || process.env.CF_BUCKET || BUCKET_DEFAULT;
const prefisso = (o = {}) => (typeof o.prefisso === 'string' ? o.prefisso : PREFISSO_DEFAULT);

/** Percorso del repo → chiave su R2. `./qa/stato.json` e `/qa/stato.json` danno `stato/qa/stato.json`. */
export function chiaveDi(percorso, pref = PREFISSO_DEFAULT) {
  const p = String(percorso || '').replace(/^\/+/, '').replace(/^\.\//, '');
  if (!p) throw new Error('percorso vuoto: serve un file (es. mail/stato.json)');
  return pref + p;
}

/** La chiave nel percorso dell'API: si codifica segmento per segmento (le `/` restano `/`). */
const urlOggetto = (o, key) =>
  `${API}/accounts/${account(o)}/r2/buckets/${bucket(o)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;

function erroreApi(json, stato) {
  const msg = (json && Array.isArray(json.errors) && json.errors.map((e) => e && e.message).filter(Boolean).join(' · ')) || '';
  return `HTTP ${stato}${msg ? ' · ' + msg : ''}`;
}

/** Il corpo è un JSON leggibile? Non si pubblica uno stato rotto (lezione dei feed, 9/11/2026). */
function validaJson(buf, file, forza) {
  if (forza) return null;
  if (!/\.json$/i.test(file)) return null;
  const testo = buf.toString('utf8');
  if (!testo.trim()) return 'file vuoto';
  let j;
  try {
    j = JSON.parse(testo);
  } catch (e) {
    return 'JSON non valido: ' + String((e && e.message) || e).slice(0, 120);
  }
  if (j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length === 0) return 'oggetto JSON vuoto ({})';
  return null;
}

/**
 * Pubblica `file` su R2. Ritorna { ok, chiave, size, etag, uploaded, verifica } e lancia su errore.
 * @param {string} file percorso locale del file da pubblicare
 * @param {{chiave?:string, prefisso?:string, bucket?:string, account?:string, token?:string,
 *          contentType?:string, verifica?:boolean, forza?:boolean}} [opts]
 */
export async function pubblicaStato(file, opts = {}) {
  const tk = token(opts);
  if (!tk) throw new Error('CLOUDFLARE_API_TOKEN assente: la pubblicazione su R2 richiede il token nei secret');
  const buf = fs.readFileSync(file);
  const rotto = validaJson(buf, file, !!opts.forza);
  if (rotto) throw new Error(`${file}: ${rotto} — non pubblico uno stato corrotto (usa --forza solo se è voluto)`);

  const key = opts.chiave ? chiaveDi(opts.chiave, prefisso(opts)) : chiaveDi(file, prefisso(opts));
  const ct = opts.contentType || (/\.json$/i.test(file) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');

  const r = await fetch(urlOggetto(opts, key), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': ct, 'User-Agent': 'care-stato/1.0' },
    body: buf,
  });
  const testo = await r.text();
  let j = null;
  try { j = JSON.parse(testo); } catch (e) { /* corpo non JSON */ }
  if (!r.ok || !j || j.success !== true) throw new Error(`upload fallito: ${erroreApi(j, r.status)}`);

  const res = { ok: true, chiave: key, size: Number(j.result && j.result.size), etag: j.result && j.result.etag, uploaded: j.result && j.result.uploaded };
  if (opts.verifica) res.verifica = await verificaOggetto(key, { ...opts, sizeAtteso: buf.length });
  return res;
}

/** Metadati veri dall'API: { trovato, size, uploaded, etaSecondi } — la prova è l'oggetto, non l'HTTP. */
export async function verificaOggetto(key, opts = {}) {
  const tk = token(opts);
  if (!tk) throw new Error('CLOUDFLARE_API_TOKEN assente: la verifica su R2 richiede il token');
  const u = `${API}/accounts/${account(opts)}/r2/buckets/${bucket(opts)}/objects?prefix=${encodeURIComponent(key)}&per_page=100`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${tk}`, 'User-Agent': 'care-stato/1.0' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.success !== true) throw new Error(`verifica fallita: ${erroreApi(j, r.status)}`);
  const oggetti = (j.result && (j.result.objects || j.result)) || [];
  const o = (Array.isArray(oggetti) ? oggetti : []).find((x) => x.key === key);
  if (!o) return { trovato: false };
  const eta = o.last_modified ? Math.round((Date.now() - Date.parse(o.last_modified)) / 1000) : null;
  const sizeOk = opts.sizeAtteso == null || Number(o.size) === Number(opts.sizeAtteso);
  return { trovato: true, size: Number(o.size), uploaded: o.last_modified, etaSecondi: eta, sizeCoerente: sizeOk, content_type: o.http_metadata && o.http_metadata.contentType };
}

/**
 * Legge un oggetto di stato da R2.
 * Ritorna { ok, testo, json, uploaded, size, etaMinuti, fonte:'r2' } oppure
 *         { ok:false, motivo } — il chiamante decide il fallback (repo/raw), così nessun lettore
 *         resta cieco se il token non c'è (sessione locale, secret mancante).
 */
export async function leggiStato(nome, opts = {}) {
  const tk = token(opts);
  if (!tk) return { ok: false, motivo: 'CLOUDFLARE_API_TOKEN assente' };
  const key = nome.includes('/') && !nome.startsWith(prefisso(opts)) ? chiaveDi(nome, prefisso(opts)) : nome;
  try {
    const r = await fetch(urlOggetto(opts, key), { headers: { Authorization: `Bearer ${tk}`, 'User-Agent': 'care-stato/1.0' } });
    if (!r.ok) return { ok: false, motivo: `HTTP ${r.status} su ${key}` };
    const testo = await r.text();
    let json = null;
    try { json = JSON.parse(testo); } catch (e) { /* non JSON: si restituisce il testo */ }
    const lm = r.headers.get('last-modified');
    const etaMinuti = lm ? Math.round((Date.now() - Date.parse(lm)) / 60000) : null;
    return { ok: true, fonte: 'r2', chiave: key, testo, json, uploaded: lm, etaMinuti };
  } catch (e) {
    return { ok: false, motivo: 'errore rete: ' + String((e && e.message) || e).slice(0, 120) };
  }
}

/** true se l'oggetto esiste ed è più giovane di `maxMinuti` (null = non verificabile → false). */
export async function statoFresco(nome, maxMinuti, opts = {}) {
  const l = await leggiStato(nome, opts);
  if (!l.ok || l.etaMinuti == null) return false;
  return l.etaMinuti <= maxMinuti;
}

// ───────────────────────────── CLI ─────────────────────────────

function argomenti(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith('--')) { a._.push(v); continue; }
    const nome = v.slice(2);
    if (['verifica', 'forza', 'help', 'aiuto'].includes(nome)) { a[nome] = true; continue; }
    const val = argv[++i];
    a[nome] = val;
  }
  return a;
}

async function main() {
  const a = argomenti(process.argv.slice(2));
  if (a.help || a.aiuto) {
    console.log('uso: node scripts/stato-pubblica.mjs <file> [--chiave k] [--bucket b] [--prefisso p] [--verifica] [--forza]');
    console.log('     node scripts/stato-pubblica.mjs --leggi <chiave-o-percorso>');
    return 0;
  }
  const opts = { chiave: a.chiave, bucket: a.bucket, prefisso: a.prefisso, account: a.account, verifica: !!a.verifica, forza: !!a.forza };
  if (a.leggi) {
    const l = await leggiStato(String(a.leggi), opts);
    if (!l.ok) { console.error('stato-pubblica: lettura non riuscita · ' + l.motivo); return 1; }
    process.stdout.write(l.testo);
    return 0;
  }
  const file = a._[0];
  if (!file) { console.error('stato-pubblica: serve un file (es. mail/stato.json)'); return 2; }
  if (!fs.existsSync(file)) { console.error(`stato-pubblica: file inesistente · ${file}`); return 2; }

  const res = await pubblicaStato(file, opts);
  const v = res.verifica;
  console.log(
    `stato-pubblica: ${file} → r2://${bucket(opts)}/${res.chiave} · ${res.size} B · etag ${String(res.etag).slice(0, 12)}…` +
      (v ? ` · verifica ${v.trovato ? 'oggetto presente' : 'OGGETTO ASSENTE'}${v.etaSecondi != null ? ` · scritto ${v.etaSecondi}s fa` : ''}${v.sizeCoerente === false ? ' · SIZE DIVERSA' : ''}` : ''),
  );
  if (v && (!v.trovato || v.sizeCoerente === false)) { console.error('stato-pubblica: verifica fallita sull\'oggetto R2'); return 1; }
  return 0;
}

const invocatoDiretto = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invocatoDiretto) {
  main().then(
    (code) => process.exit(code || 0),
    (e) => { console.error('stato-pubblica: ' + String((e && e.message) || e)); process.exit(1); },
  );
}
