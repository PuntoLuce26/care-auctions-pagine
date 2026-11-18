#!/usr/bin/env node
/**
 * WATCHDOG DI FRESCHEZZA DEL PRESIDIO QA — qa/audit-interno.json
 *
 * Perché esiste (18/11/2026): un payload che dice «0 critici» può essere vecchio di 5 ore e su una
 * build che non è più quella servita. Uno stato fermo che SEMBRA fresco è peggio di uno assente:
 * chi lo legge decide su un fatto vecchio. Questo watchdog guarda l'ETÀ e la PROVENIENZA.
 *
 * Regola delle soglie (cadenza dichiarata del presidio = 3 h, campo `cadenzaOre` del payload):
 *   · età > 6 h  (2 × cadenza) → attenzione: «presidio fermo da Xh: lo stato QA non è più affidabile»
 *   · età > 9 h  (3 × cadenza) → ALLARME + exit 1: «stato QA FERMO: qualunque numero letto da qui non vale»
 *   · payload assente/illeggibile → «non verificabile» (exit 0): mai un rosso senza prova
 *   · sitoBuild ≠ build servita adesso → attenzione (stato misurato su un'altra build)
 * Scrive l'allarme in R2 `stato/allarmi/qa-freschezza.json` (ultimi 20, forma degli altri allarmi).
 * Niente issue. Prova in locale: QA_FRESCHEZZA_FILE=<payload.json> per simulare un payload finto.
 */
import { readFileSync } from 'node:fs';

const GH = String(process.env.GITHUB_TOKEN || process.env.PAT_GITHUB || '').trim();
const CF = String(process.env.CLOUDFLARE_API_TOKEN || process.env.CF_TOKEN || '').trim();
const ACC = 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const BUCKET = 'care-stato';
const CHIAVE = 'stato/allarmi/qa-freschezza.json';
const PAYLOAD = 'qa/audit-interno.json';
const CADENZA_H = 3;
const SOGLIA_ATTENZIONE_H = 2 * CADENZA_H;  // 6 h
const SOGLIA_ALLARME_H = 3 * CADENZA_H;     // 9 h
const RAFFICA = 20;
const RUN_ID = process.env.GITHUB_RUN_ID || null;
const RUN_URL = RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY || 'PuntoLuce26/care-auctions-pagine'}/actions/runs/${RUN_ID}` : null;
const ora = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const h = (ms) => Math.round((ms / 3600000) * 10) / 10;

// ── 1 · leggo il payload dalla Contents API (NON dalla raw: resta indietro ~5 min) ──
async function leggiPayload() {
  if (process.env.QA_FRESCHEZZA_FILE) {
    try { return { ok: true, json: JSON.parse(readFileSync(process.env.QA_FRESCHEZZA_FILE, 'utf8')), fonte: 'file locale (QA_FRESCHEZZA_FILE)' }; }
    catch (e) { return { ok: false, errore: 'file locale illeggibile: ' + e.message }; }
  }
  if (!GH) return { ok: false, errore: 'GITHUB_TOKEN assente' };
  try {
    const r = await fetch('https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/contents/' + PAYLOAD, {
      headers: { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json', 'User-Agent': 'QA-Freschezza/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { ok: false, errore: 'Contents API HTTP ' + r.status };
    const j = await r.json();
    if (!j || !j.content) return { ok: false, errore: 'contents vuoto (file > 1 MB? qui non dovrebbe)' };
    return { ok: true, json: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), fonte: 'Contents API' };
  } catch (e) { return { ok: false, errore: String(e.message).slice(0, 120) }; }
}

// ── 2 · build servita adesso (per la coerenza con sitoBuild) ──────────────────
async function buildServita() {
  try {
    const r = await fetch('https://careauctions.co/?audit=' + Date.now(), { headers: { 'User-Agent': 'CARe-Audit/1.0' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;
    const t = await r.text();
    const m = t.match(/main\.[a-f0-9]{8}\.js/);
    return m ? m[0] : null;
  } catch (e) { return null; }
}

// ── 3 · R2: leggo la raffica, aggiungo in testa, taglio a 20 ────────────────
const r2Url = () => `https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/${BUCKET}/objects/${CHIAVE.split('/').map(encodeURIComponent).join('/')}`;
async function r2leggi() {
  if (!CF) return null;
  try {
    const r = await fetch(r2Url(), { headers: { Authorization: 'Bearer ' + CF, 'User-Agent': 'QA-Freschezza/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return null; }
  } catch (e) { return null; }
}
async function r2scrivi(obj) {
  if (!CF) return { ok: false, errore: 'CLOUDFLARE_API_TOKEN assente' };
  try {
    const r = await fetch(r2Url(), {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + CF, 'Content-Type': 'application/json', 'User-Agent': 'QA-Freschezza/1.0' },
      body: Buffer.from(JSON.stringify(obj, null, 1) + '\n', 'utf8'),
      signal: AbortSignal.timeout(20000),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { ok: r.ok && !!j && j.success === true, status: r.status, errore: j && j.errors ? JSON.stringify(j.errors).slice(0, 120) : String(t).slice(0, 120) };
  } catch (e) { return { ok: false, errore: String(e.message).slice(0, 120) }; }
}

// ── 4 · verdetto ───────────────────────────────────────────────────────────
const letto = await leggiPayload();
let livello = 'ok', messaggio = '', eta = null, sitob = null, servita = null, esito = 0;

if (!letto.ok || !letto.json || !letto.json.generato) {
  // NIENTE prove, niente rosso: si dichiara non verificabile.
  livello = 'non verificabile';
  messaggio = 'non verificabile: ' + (letto.errore || 'payload senza campo generato');
  console.log('::warning::' + messaggio);
} else {
  const t = Date.parse(letto.json.generato);
  eta = Number.isFinite(t) ? h(Date.now() - t) : null;
  sitob = letto.json.sitoBuild || null;
  servita = await buildServita();
  const cadenze = Number(letto.json.cadenzaOre) > 0 ? Number(letto.json.cadenzaOre) : CADENZA_H;

  if (eta === null) {
    livello = 'non verificabile';
    messaggio = 'non verificabile: campo generato non interpretabile (' + letto.json.generato + ')';
    console.log('::warning::' + messaggio);
  } else if (eta > SOGLIA_ALLARME_H) {
    livello = 'allarme';
    messaggio = 'stato QA FERMO: qualunque numero letto da qui non vale (payload di ' + eta + ' h fa, cadenza ' + cadenze + ' h, soglia ' + SOGLIA_ALLARME_H + ' h)';
    esito = 1;
    console.log('::error::' + messaggio);
  } else if (eta > SOGLIA_ATTENZIONE_H) {
    livello = 'attenzione';
    messaggio = 'presidio fermo da ' + eta + ' h: lo stato QA non è più affidabile (cadenza ' + cadenze + ' h, soglia attenzione ' + SOGLIA_ATTENZIONE_H + ' h)';
    console.log('::warning::' + messaggio);
  } else {
    livello = 'ok';
    messaggio = 'presidio fresco: ' + eta + ' h su cadenza ' + cadenze + ' h · build ' + (sitob || '?');
    console.log(messaggio);
  }

  // coerenza con il sito: la build su cui è stato misurato è ancora quella servita?
  if (sitob && servita && sitob !== servita) {
    const msg = 'stato misurato su una build diversa (' + sitob + ' vs ' + servita + ')';
    if (livello === 'ok') livello = 'attenzione';
    messaggio = messaggio + ' · ' + msg;
    console.log('::warning::' + msg);
  }
}

// ── 5 · scrivo l'allarme in R2 (ultimi 20) ────────────────────────────────
const voce = { generato: ora(), workflow: 'qa-freschezza', livello, messaggio, runId: RUN_ID, runUrl: RUN_URL };
const precedente = await r2leggi();
const raffica = [voce, ...((precedente && Array.isArray(precedente.allarmi)) ? precedente.allarmi : [])].slice(0, RAFFICA);
const uscita = await r2scrivi({ ...voce, payloadFile: PAYLOAD, etaOre: eta, sitoBuild: sitob, buildServita: servita, allarmi: raffica });
if (!uscita.ok) console.log('::warning::allarme non scritto in R2: ' + (uscita.errore || uscita.status));
else console.log('allarme scritto in R2: ' + CHIAVE + ' · ' + raffica.length + ' voci');

console.log('verdetto: ' + livello + ' · età ' + (eta === null ? '?' : eta + ' h') + ' · ' + (sitob || '?') + ' vs ' + (servita || '?'));
process.exit(esito);
