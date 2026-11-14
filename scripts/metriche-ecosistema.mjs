#!/usr/bin/env node
/**
 * metriche-ecosistema.mjs — il cruscotto unico di CAReAuctions.
 *
 * REGOLA: un dato che non esiste si dichiara `non_misurato`, mai stimato.
 * Fonti lette davvero:
 *  - traffico: KV STATS (edge) chiavi `pv:` e `bt:` (le pageview; il feed RUM risponde 403)
 *  - ricavi: KV TRAFFICO `torre:cassa` (cassa aggiornata dal registro privato)
 *  - QA: R2 `stato/qa/stato.json` (summary + storico7g)
 *  - SLI/TTFB: R2 `stato/perf/stato.json` + probe HTTP del sito
 *  - copertura tribunale: feed `esiti-monitor.json` / `tribunali.json`
 *  - conversione, churn, NPS, CAC: nessuna fonte => `non_misurato` (da strumentare)
 *
 * Scrive:
 *  - metriche/stato.json            (COMPLETO, va su R2 privato `stato/metriche/stato.json`)
 *  - feed/metriche-ecosistema.json  (PUBBLICO, senza importi di cassa)
 */
import fs from 'node:fs';
import path from 'node:path';

const ACCOUNT = process.env.CF_ACCOUNT_ID || 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const R2_BUCKET = 'care-stato';
const KV_STATS = '574ed566e8ac4515bfed1e500845b567';
const KV_TRAFFICO = '432827253eed4b6a97eef2977f096ce9';
const CF = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
const UA = 'Mozilla/5.0 (compatible; CARe-metriche/1.0; +https://careauctions.co)';
const BASE = 'https://careauctions.co';
const OUT = process.env.OUT_DIR || '.';
const ora = new Date().toISOString();

async function kv(ns, key) {
  if (!CF) return null;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${CF}` },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function kvKeys(ns, prefix) {
  if (!CF) return [];
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${ns}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000`, {
      headers: { Authorization: `Bearer ${CF}` },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.result || []).map(x => x.name);
  } catch { return []; }
}

async function r2(key) {
  if (!CF) return null;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${R2_BUCKET}/objects/${key}`, {
      headers: { Authorization: `Bearer ${CF}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function jsonFeed(file) {
  try {
    const r = await fetch(`${BASE}/feed/${file}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function sommaGiorni(mappa, giorni) {
  const oggi = new Date();
  let somma = 0, trovati = 0;
  for (let i = 0; i < giorni; i++) {
    const d = new Date(oggi.getTime() - i * 86400000).toISOString().slice(0, 10);
    if (Object.prototype.hasOwnProperty.call(mappa, d)) { somma += Number(mappa[d]) || 0; trovati++; }
  }
  return { somma, giorniConDato: trovati };
}

const metriche = {};
const nonMisurate = [];

/* ---------- TRAFFICO (KV STATS) ---------- */
try {
  const chiaviPv = await kvKeys(KV_STATS, 'pv:');
  const chiaviBt = await kvKeys(KV_STATS, 'bt:');
  const pv = {}, bt = {};
  for (const k of chiaviPv) { const v = await kv(KV_STATS, k); if (v != null) pv[k.slice(3)] = Number(v) || 0; }
  for (const k of chiaviBt) { const v = await kv(KV_STATS, k); if (v != null) bt[k.slice(3)] = Number(v) || 0; }
  const oggi = new Date().toISOString().slice(0, 10);
  if (Object.keys(pv).length) {
    const s7 = sommaGiorni(pv, 7), s30 = sommaGiorni(pv, 30);
    const b7 = sommaGiorni(bt, 7), b30 = sommaGiorni(bt, 30);
    metriche.traffico = {
      valore: { oggi: pv[oggi] ?? null, ultimi7g: s7.somma, ultimi30g: s30.giorniConDato >= 15 ? s30.somma : null, bot7g: b7.somma, bot30g: b30.giorniConDato >= 15 ? b30.somma : null },
      unita: 'visualizzazioni (pageview)',
      stato: s7.giorniConDato >= 5 ? 'parziale' : 'non_misurato',
      fonte: 'KV STATS — chiavi pv: e bt: (edge)',
      aggiornato: ora,
      copertura: `${s7.giorniConDato}/7 giorni con dato; ${s30.giorniConDato}/30`,
      nota: 'Pageview, non utenti unici. Il feed visite-rum risponde 403: la fonte vera è il KV dell\'edge. Bot contati a parte.',
    };
  } else {
    metriche.traffico = { valore: null, unita: 'visualizzazioni', stato: 'non_misurato', fonte: 'KV STATS', aggiornato: ora, nota: 'nessuna chiave pv: leggibile' };
    nonMisurate.push('traffico');
  }
} catch (e) {
  metriche.traffico = { valore: null, stato: 'non_misurato', fonte: 'KV STATS', nota: String(e.message || e) };
  nonMisurate.push('traffico');
}

/* ---------- RICAVI (cassa KV) ---------- */
try {
  const raw = await kv(KV_TRAFFICO, 'torre:cassa');
  const cassa = raw ? JSON.parse(raw) : null;
  if (cassa && Number.isFinite(Number(cassa.saldo))) {
    const aggiornato = cassa.aggiornato || null;
    const giorni = aggiornato ? Math.floor((Date.now() - new Date(aggiornato + 'T00:00:00Z').getTime()) / 86400000) : null;
    metriche.ricavi = {
      valore: { cassa_eur: Number(cassa.saldo), inArrivo_eur: Number(cassa.inArrivo) || null, aggiornato },
      unita: 'EUR',
      stato: 'parziale',
      fonte: 'KV TRAFFICO — torre:cassa (registro cassa privato)',
      aggiornato: ora,
      copertura: 'cassa sì; ricorrenti/abbonamenti no',
      nota: `Cassa al ${aggiornato || '?'}${giorni != null ? ` (${giorni} giorni fa)` : ''}. I ricavi ricorrenti non sono strumentati.`,
    };
  } else {
    metriche.ricavi = { valore: null, stato: 'non_misurato', fonte: 'KV TRAFFICO torre:cassa', nota: 'chiave assente o illeggibile' };
    nonMisurate.push('ricavi');
  }
} catch (e) {
  metriche.ricavi = { valore: null, stato: 'non_misurato', fonte: 'KV TRAFFICO torre:cassa', nota: String(e.message || e) };
  nonMisurate.push('ricavi');
}

/* ---------- QA + UPTIME/SLI ---------- */
try {
  const qa = await r2('stato/qa/stato.json');
  const perf = await r2('stato/perf/stato.json');
  const t0 = Date.now();
  let http = null;
  try { const rs = await fetch(BASE + '/?metriche=' + Date.now(), { headers: { 'User-Agent': UA } }); http = rs.status; } catch {}
  const ms = Date.now() - t0;
  const q7 = qa?.storico7g || null;
  metriche.uptime_sli = {
    valore: {
      sito_http: http,
      ttfb_sito_ms: perf?.sito_ttfb_ultimo ?? ms,
      ttfb_origine_ms: perf?.origine_ttfb_ultimo ?? null,
      qa_7g_eseguiti_pct: q7?.tassoSuccessoEseguiti ?? null,
      qa_7g_grezzo_pct: q7?.tassoSuccessoGrezzo ?? null,
      qa_7g_success: q7?.success ?? null,
      qa_7g_failure: q7?.failure ?? null,
      qa_7g_cancelled: q7?.cancelled ?? null,
      qa_summary: qa?.summary ?? null,
      qa_generated_at: qa?.generatedAt ?? null,
    },
    unita: 'stato / ms / %',
    stato: (http === 200 && q7) ? 'parziale' : 'non_misurato',
    fonte: 'R2 stato/qa + stato/perf + probe HTTP',
    aggiornato: ora,
    copertura: 'QA 7 giorni + probe singolo; uptime continuo non misurato',
    nota: 'Il tasso QA buono è quello sui run eseguiti (cancellati esclusi). Uptime/SLI continuo non è strumentato.',
  };
} catch (e) {
  metriche.uptime_sli = { valore: null, stato: 'non_misurato', fonte: 'R2 QA/perf', nota: String(e.message || e) };
  nonMisurate.push('uptime_sli');
}

/* ---------- COPERTURA TRIBUNALE ---------- */
try {
  const esiti = await jsonFeed('esiti-monitor.json');
  const trib = await jsonFeed('tribunali.json');
  const conEsiti = esiti?.tribunali?.length || esiti?.copertura?.tribunali || 0;
  const totali = trib?.tribunali?.length || 0;
  if (conEsiti && totali) {
    metriche.copertura_tribunale = {
      valore: { con_esiti: conEsiti, totali, pct: +(100 * conEsiti / totali).toFixed(1) },
      unita: 'tribunali',
      stato: 'parziale',
      fonte: 'feed esiti-monitor.json + tribunali.json',
      aggiornato: ora,
      copertura: `${conEsiti}/${totali}`,
      nota: 'Copertura dei tribunali con almeno un esito pubblicato; non è copertura di tutti i lotti.',
    };
  } else {
    metriche.copertura_tribunale = { valore: null, stato: 'non_misurato', fonte: 'feed esiti/tribunali', nota: 'feed non leggibile' };
    nonMisurate.push('copertura_tribunale');
  }
} catch (e) {
  metriche.copertura_tribunale = { valore: null, stato: 'non_misurato', fonte: 'feed esiti/tribunali', nota: String(e.message || e) };
  nonMisurate.push('copertura_tribunale');
}

/* ---------- NON MISURATE (dichiarate, mai stimate) ---------- */
metriche.conversione = { valore: null, unita: '%', stato: 'non_misurato', fonte: 'pratiche / signup', aggiornato: ora, nota: 'Nessun evento di conversione tracciato: da strumentare.' };
metriche.churn = { valore: null, unita: '%', stato: 'non_misurato', fonte: 'abbonamenti', aggiornato: ora, nota: 'Nessun dato abbonamenti: da strumentare.' };
metriche.nps = { valore: null, unita: 'punti', stato: 'non_misurato', fonte: 'survey', aggiornato: ora, nota: 'Nessun survey: da creare.' };
metriche.cac = { valore: null, unita: 'EUR', stato: 'non_misurato', fonte: 'spesa / lead', aggiornato: ora, nota: 'Spesa e lead non collegati: da strumentare.' };
for (const k of ['conversione', 'churn', 'nps', 'cac']) nonMisurate.push(k);

const stato = {
  generatoIl: ora,
  workflow: 'metriche-ecosistema.yml',
  regola: 'un dato assente è non_misurato, mai stimato',
  metriche,
  non_misurate: [...new Set(nonMisurate)],
};

const pubblico = JSON.parse(JSON.stringify(stato));
// La cassa è interna: nel pubblico si dichiara che è misurata ma il valore resta riservato.
if (pubblico.metriche.ricavi) {
  pubblico.metriche.ricavi = {
    valore: null,
    unita: 'EUR',
    stato: pubblico.metriche.ricavi.stato === 'non_misurato' ? 'non_misurato' : 'misurato_riservato',
    fonte: 'KV TRAFFICO torre:cassa',
    aggiornato: ora,
    nota: 'Valore disponibile nel cruscotto interno (R2 privato), non pubblicato.',
  };
}

fs.mkdirSync(path.join(OUT, 'metriche'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'feed'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'metriche/stato.json'), JSON.stringify(stato, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'feed/metriche-ecosistema.json'), JSON.stringify(pubblico, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, non_misurate: stato.non_misurate, metriche: Object.fromEntries(Object.entries(metriche).map(([k, v]) => [k, v.stato])) }, null, 2));
