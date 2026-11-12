#!/usr/bin/env node
/**
 * quadro.js — IL QUADRO AUTOMATICO (report di stato del progetto CARe Auctions)
 *
 * Sostituisce il QUADRO che veniva scritto a mano dal Mac: gira nel cloud con la
 * GitHub Action .github/workflows/quadro.yml (cron ogni 6 ore + workflow_dispatch),
 * legge solo fonti pubbliche e scrive dossier/QUADRO-<YYYY-MM-DD-HH>.md (ora UTC).
 *
 * Fonti (nessun segreto oltre al GITHUB_TOKEN che la Action ha già):
 *   1. POST worker icare-ai  azione=stato-automazioni   → automazioni + cron
 *   2. POST worker icare-ai  azione=omi-stato           → semestre/province/comuni/zone
 *   3. POST worker icare-ai  azione=config-pubblica     → prezzi/calcolatore/paywall + aggiornato
 *   4. feed GitHub Pages: statistiche.json, indice.json, npl.json, crediti-fiscali.json,
 *      sitemap-meta.json, indexnow.json, perizie-ocr.json, ocr-stato.json
 *   5. feed/foto-procedure.json: 16 MB → NON scaricato, solo la size (API contents / HEAD)
 *   6. API GitHub: ultimi run di feed-sync, verifica-playwright, icarewall-cron,
 *      guardiano-cron, uptime
 *   7. sito careauctions.co: codice HTTP delle rotte principali + URL nel sitemap italiane
 *
 * Regola: nessun numero inventato. Se una fonte non risponde il report scrive
 * "in arrivo" e prosegue; le fonti cadute finiscono nella sezione "Cosa manca".
 * Zero dipendenze: solo fetch globale di Node 22.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dossier');

const REPO = 'PuntoLuce26/care-auctions-pagine';
const WORKER = 'https://icare-ai.misty-mode-1cbc.workers.dev';
const PAGES = 'https://puntoluce26.github.io/care-auctions-pagine/';
const SITE = 'https://careauctions.co';

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const TIMEOUT = Number(process.env.QUADRO_TIMEOUT_MS || 20000);
const FOTO_ESATTO = process.env.QUADRO_FOTO_ESATTO === '1';

const mq = []; // fonti che non hanno risposto

// ─── rete ────────────────────────────────────────────────────────────────────

async function richiesta(url, opts = {}, ms = TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function ghHeaders() {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'care-quadro' };
  if (TOKEN) h.authorization = 'Bearer ' + TOKEN;
  return h;
}

async function getJson(url, opts = {}, ms = TIMEOUT) {
  const r = await richiesta(url, opts, ms);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function postWorker(azione, ms = 25000) {
  const r = await richiesta(WORKER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ azione }),
  }, ms);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/** Esegue una lettura; se fallisce segna la fonte come caduta e torna null. */
async function sicuro(etichetta, fn) {
  try {
    return await fn();
  } catch (e) {
    const motivo = (e && (e.message || e.name)) || 'errore';
    mq.push(etichetta + ' (' + motivo + ')');
    console.log('FONTE non disponibile: ' + etichetta + ' — ' + motivo);
    return null;
  }
}

// ─── formattazione (mai "undefined", mai "NaN") ──────────────────────────────

const ARRIVO = 'in arrivo';
const valido = (v) => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !isFinite(v));

/** 2183 → "2.183": raggruppa sempre le migliaia (il report di esempio scrive 8.523, non 8523). */
const gruppo = (n) => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Numeri che arrivano dal worker come stringhe italiane: "179,00", "3,90", "799". */
const num0 = (v) => {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim().replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  return null;
};

const int = (v) => (num0(v) !== null ? gruppo(num0(v)) : ARRIVO);
/** €166.034 per gli importi tondi, €59,90 quando i centesimi contano. */
const eur = (v) => {
  const n = num0(v);
  if (n === null) return ARRIVO;
  return '€' + (Number.isInteger(n) ? gruppo(n) : grupoDecimali(n));
};
const grupoDecimali = (n) => {
  const [interi, decimali] = n.toFixed(2).split('.');
  return gruppo(interi) + ',' + decimali;
};
const pct = (v, d = 0) => (num0(v) !== null ? Number(num0(v)).toFixed(d).replace('.', ',') + '%' : ARRIVO);
/** percentuali tariffarie: 3,9% / 2,9% / 1,9% — niente zeri inutili. */
const pctP = (v) => (num0(v) !== null ? String(Number(num0(v).toFixed(2))).replace('.', ',') + '%' : ARRIVO);
const txt = (v) => (valido(v) ? String(v) : ARRIVO);

/** 2026-11-01T03:19:06.675Z → "01/11 03:19Z" (il report vive in UTC). */
function ts(iso) {
  if (!valido(iso)) return ARRIVO;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio',
  'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// ─── raccolta dati ───────────────────────────────────────────────────────────

const FEED = [['statistiche', 'statistiche.json'], ['confronto', 'confronto-mercato.json'], ['indice', 'indice.json'],
  ['npl', 'npl.json'], ['crediti', 'crediti-fiscali.json'],
  ['sitemapMeta', 'sitemap-meta.json'], ['indexnow', 'indexnow.json'],
  ['perizieOcr', 'perizie-ocr.json'], ['ocrStato', 'ocr-stato.json'],
  ['omiIndice', 'omi-indice.json'], ['mercatoIndice', 'mercato-indice.json'],
  ['asteZone', 'aste-zone.json'], ['residenzialeComune', 'residenziale-comune.json']];

const WF = [['feed-sync', 'feed-sync.yml'], ['verifica-playwright', 'verifica-playwright.yml'],
  ['icarewall-cron', 'icarewall-cron.yml'], ['guardiano-cron', 'guardiano-cron.yml'],
  ['uptime', 'uptime.yml']];

const ROTTE = [['/', 'home'], ['/ca-re-index', 'ca-re-index'], ['/osservatorio', 'osservatorio'],
  ['/dati', 'dati'], ['/icarewall', 'icarewall'], ['/sitemap.xml', 'sitemap']];

// 12/11/2026 — I FEED SI LEGGONO DAL SITO, NON DA GITHUB PAGES.
// Il mirror Pages può restare indietro di ore (o non avere il file: gsc.json dava 404),
// mentre careauctions.co/feed/ è servito dall'edge che legge PRIMA la raw dei repo.
// Quindi: prima il sito, poi Pages come ripiego. Un feed non è mai "mancante" se esiste nella raw.
async function leggiFeed(nome) {
  const dalSito = await getJson('https://careauctions.co/feed/' + nome + '?t=' + Date.now(), { headers: { accept: 'application/json' } }, 30000);
  if (dalSito) return dalSito;
  return getJson(PAGES + 'feed/' + nome, { headers: { accept: 'application/json' } }, 30000);
}

/** Ultimo run di un workflow: nome, numero, esito, quando. */
async function ultimoRun(nome, file) {
  const j = await getJson(
    `https://api.github.com/repos/${REPO}/actions/workflows/${file}/runs?per_page=1&exclude_pull_requests=true`,
    { headers: ghHeaders() });
  const r = (j.workflow_runs || [])[0];
  if (!r) return { nome, file, esito: 'nessun run', quando: null, numero: null };
  return {
    nome: r.name || nome,
    file,
    esito: r.conclusion || r.status || ARRIVO,
    quando: r.created_at || null,
    numero: r.run_number || null,
  };
}

/** Size del feed foto da 16 MB senza scaricarlo: API contents, poi HEAD su Pages. */
async function dimensioneFoto() {
  try {
    const j = await getJson(`https://api.github.com/repos/${REPO}/contents/feed/foto-procedure.json`,
      { headers: ghHeaders() });
    if (j && isFinite(Number(j.size))) return { byte: Number(j.size), via: 'API GitHub contents' };
  } catch (e) {
    console.log('contents foto-procedure: ' + e.message);
  }
  const r = await richiesta(PAGES + 'feed/foto-procedure.json', { method: 'HEAD' }, 15000);
  const len = Number(r.headers.get('content-length') || 0);
  if (r.ok && len) return { byte: len, via: 'HEAD GitHub Pages' };
  throw new Error('dimensione non leggibile');
}

/** Conteggio esatto lotti/foto/perizie: solo se QUADRO_FOTO_ESATTO=1 (scarica i 16 MB). */
async function conteggioFotoEsatto() {
  const r = await richiesta(PAGES + 'feed/foto-procedure.json', {}, 180000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const voci = JSON.parse(await r.text());
  const arr = Array.isArray(voci) ? voci : [];
  let foto = 0, perizie = 0, conPerizia = 0;
  for (const v of arr) {
    const f = Array.isArray(v.foto) ? v.foto.length : 0;
    const p = Array.isArray(v.perizia) ? v.perizia.length : 0;
    foto += f; perizie += p; if (p > 0) conPerizia++;
  }
  return { lotti: arr.length, foto, perizie, conPerizia };
}

/** URL delle sitemap italiane: root → index → pezzi, poi somma dei <loc>. */
async function sitemapItaliane() {
  const loc = (xml) => [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
  const leggiXml = async (u, ms) => {
    const r = await richiesta(u, {}, ms);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' su ' + u);
    return r.text();
  };
  const parti = (urls) => urls.filter((u) => /sitemap-aste-it-\d+\.xml$/.test(u));

  const radice = loc(await leggiXml(SITE + '/sitemap.xml', 15000));
  let pezzi = parti(radice);
  let indice = radice.find((u) => /sitemap-aste-it-index\.xml$/.test(u)) || null;
  if (!pezzi.length && indice) pezzi = parti(loc(await leggiXml(indice, 15000)));
  if (!pezzi.length) throw new Error('nessun pezzo sitemap-aste-it trovato');

  const conteggi = await Promise.all(pezzi.map(async (u) => {
    try {
      const xml = await leggiXml(u, 12000);
      return (xml.match(/<loc>/g) || []).length;
    } catch (e) {
      console.log('sitemap: ' + u + ' — ' + e.message);
      return null;
    }
  }));
  const letti = conteggi.filter((n) => n !== null);
  return {
    url: indice || pezzi[0],
    pezzi: pezzi.length,
    pezziLetti: letti.length,
    totale: letti.length ? letti.reduce((a, b) => a + b, 0) : null,
  };
}

async function statoRotta(p) {
  const r = await richiesta(SITE + p, { redirect: 'follow' }, 15000);
  return r.status;
}

// ─── report ──────────────────────────────────────────────────────────────────

function tabella(intestazioni, righe) {
  const out = ['| ' + intestazioni.join(' | ') + ' |',
    '|' + intestazioni.map(() => '---').join('|') + '|'];
  for (const r of righe) out.push('| ' + r.join(' | ') + ' |');
  return out.join('\n');
}

function costruisci(d) {
  const adesso = d.adesso;
  const p2 = (n) => String(n).padStart(2, '0');
  const oraUtc = `${p2(adesso.getUTCHours())}:${p2(adesso.getUTCMinutes())}`;
  const dataIt = `${adesso.getUTCDate()} ${MESI[adesso.getUTCMonth()]} ${adesso.getUTCFullYear()}`;

  const s = d.statistiche || {};
  const idx = d.indice || {};
  const auto = (d.automazioni && d.automazioni.automazioni) || [];
  const omi = d.omi || null;
  const cfg = d.config || null;

  const npl = d.npl && Array.isArray(d.npl.lotti) ? d.npl.lotti.length : null;
  const crediti = d.crediti && Array.isArray(d.crediti.lotti) ? d.crediti.lotti.length : null;
  const ocr = Array.isArray(d.perizieOcr) ? d.perizieOcr.length : null;
  const ocrQuando = Array.isArray(d.perizieOcr) && d.perizieOcr.length
    ? d.perizieOcr[d.perizieOcr.length - 1].quando : null;
  const ocrPdf = d.ocrStato && Array.isArray(d.ocrStato.fatti) ? d.ocrStato.fatti.length : null;

  const rotteOk = d.rotte.filter((r) => r.stato === 200).length;
  const rotteCadute = d.rotte.filter((r) => r.stato !== 200);

  const SENZA_DATO = /nessun dato|n\/a|sconosciuto/i;
  const autoConDato = auto.filter((a) => !SENZA_DATO.test(String(a.stato || '')));
  const autoOk = autoConDato.filter((a) => /success|attivo|ok/i.test(String(a.stato || ''))).length;
  const autoKo = autoConDato.filter((a) => !/success|attivo|ok/i.test(String(a.stato || '')));
  const autoSenzaDato = auto.filter((a) => SENZA_DATO.test(String(a.stato || '')));

  const wfKo = d.runs.filter((r) => r.esito !== 'success');
  const wfOk = d.runs.filter((r) => r.esito === 'success');

  const foto = d.foto || null;
  const fotoMb = foto ? (foto.byte / 1048576).toFixed(1).replace('.', ',') : null;
  const esiti = s.esiti || {};

  // ── 0. In cinque righe ──
  const r0 = [];
  r0.push(`**Aste**: **${int(s.totale)}** in archivio (${txt(s.aggiornato ? ts(s.aggiornato) : null)}), `
    + `di cui **${int(idx.immobiliari)}** immobiliari e **${int(idx.mobiliari)}** mobiliari.`);
  const omiC = (d.confronto && d.confronto.nazionale) || {};
  const omiCop = (d.confronto && d.confronto.meta && d.confronto.meta.copertura) || {};
  r0.push(`**Prezzi**: prezzo medio immobiliare **${eur(s.prezzoMedioImm)}**, sconto mediano vs OMI **${pct(omiC.scontoMedianoPct)}** su ${int(omiCop.lottiConMq)} lotti confrontabili in ${int(omiCop.comuniPubblicati)} comuni; `
    + `esiti registrati: ${int(esiti.aggiudicate)} aggiudicate · ${int(esiti.deserte)} deserte · ${int(esiti.sospese)} sospese.`);
  r0.push(`**Oltre le aste**: **${int(npl)}** NPL's, **${int(crediti)}** crediti fiscali, OMI **${int(omi && omi.comuni)} comuni / `
    + `${int(omi && omi.zone)} zone** su ${int(omi && omi.province)} province (${txt(omi && omi.semestre)}).`);
  r0.push(`**Automazioni**: **${autoOk}/${autoConDato.length || 0}** attive lato worker${autoSenzaDato.length ? ' (' + autoSenzaDato.length + ' senza dato)' : ''}, **${wfOk.length}/${d.runs.length}** workflow `
    + `GitHub con ultimo run verde${wfKo.length ? ' (rosso: ' + wfKo.map((w) => w.nome).join(', ') + ')' : ''}.`);
  r0.push(`**Sito**: **${rotteOk}/${d.rotte.length}** rotte a 200${rotteCadute.length ? ' (giù: ' + rotteCadute.map((r) => r.percorso).join(', ') + ')' : ''}, `
    + `**${int(d.sitemap && d.sitemap.totale)}** URL nelle sitemap italiane`
    + `${d.sitemap ? ' in ' + d.sitemap.pezziLetti + '/' + d.sitemap.pezzi + ' pezzi' : ''}, `
    + `IndexNow ${int(d.indexnow && d.indexnow.inviati)} URL inviati oggi.`);

  // ── 1. Numeri vivi ──
  const numeri = [
    ['Aste totali', `**${int(s.totale)}**`, `statistiche.json (${txt(s.aggiornato ? ts(s.aggiornato) : null)})`],
    ['Immobiliari', `**${int(idx.immobiliari)}**`, 'indice.json'],
    ['Mobiliari', `**${int(idx.mobiliari)}**`, 'indice.json'],
    ['Prezzo medio immobiliare', `**${eur(s.prezzoMedioImm)}**`, 'statistiche.json'],
    ['Sconto mediano vs OMI', `**${pct(omiC.scontoMedianoPct)}**`, `confronto-mercato.json (${int(omiCop.lottiConMq)} lotti · ${int(omiCop.comuniPubblicati)} comuni)`],
    ['Esiti', `${int(esiti.aggiudicate)} agg. · ${int(esiti.deserte)} des. · ${int(esiti.sospese)} sosp.`, 'statistiche.json'],
    ['NPL\'s', `**${int(npl)}**`, `npl.json (${txt(d.npl && d.npl.meta && d.npl.meta.aggiornato)})`],
    ['Crediti fiscali', `**${int(crediti)}**`, `crediti-fiscali.json (${txt(d.crediti && d.crediti.meta && d.crediti.meta.aggiornato)})`],
    ['OMI', `**${int(omi && omi.comuni)} comuni / ${int(omi && omi.zone)} zone / ${int(omi && omi.province)} province**`, `worker omi-stato · ${txt(omi && omi.semestre)}`],
    ['OCR perizie', `**${int(ocr)} perizie** · ${int(ocrPdf)} PDF passati`, `perizie-ocr.json (${txt(ts(ocrQuando))})`],
    ['Feed foto', `**${fotoMb ? fotoMb + ' MB**' : ARRIVO + '**'} (${int(foto && foto.byte)} byte)`, foto ? foto.via : ARRIVO],
  ];
  if (d.fotoEsatto) {
    numeri.push(['Lotti con foto/perizie', `**${int(d.fotoEsatto.lotti)}** lotti · ${int(d.fotoEsatto.foto)} foto · ${int(d.fotoEsatto.perizie)} perizie`, 'foto-procedure.json (conteggio esatto)']);
  }
  numeri.push(
    ['IndexNow', `**${int(d.indexnow && d.indexnow.inviati)} URL** inviati oggi`, `indexnow.json (${txt(d.indexnow && d.indexnow.quando ? ts(d.indexnow.quando) : null)})`],
    ['Sitemap italiane', `**${int(d.sitemap && d.sitemap.totale)} URL** in ${int(d.sitemap && d.sitemap.pezziLetti)}/${int(d.sitemap && d.sitemap.pezzi)} pezzi`, `sitemap-meta.json (shard ${int(d.sitemapMeta && d.sitemapMeta.shard)})`],
  );

  // ── 3. Automazioni ──
  const righeWorker = auto.map((a) => [
    txt(a.nome), txt(a.cadenza),
    SENZA_DATO.test(String(a.stato || '')) ? '· ' + txt(a.stato)
      : (/success|attivo|ok/i.test(String(a.stato || '')) ? '✅ ' + txt(a.stato) : '⚠️ ' + txt(a.stato)),
    ts(a.quando),
  ]);
  const righeGh = d.runs.map((r) => [
    txt(r.nome), r.numero ? '#' + r.numero : ARRIVO, r.esito === 'success' ? '✅ success' : '⚠️ ' + txt(r.esito), ts(r.quando),
  ]);

  // ── 4. Sito ──
  const righeRotte = d.rotte.map((r) => [r.percorso, r.stato === 200 ? '200 ✅' : txt(r.stato) + ' ⚠️']);

  // ── 5. Cosa manca ──
  const manca = [];
  if (rotteCadute.length) manca.push(`Rotte non a 200: ${rotteCadute.map((r) => r.percorso + ' (' + r.stato + ')').join(', ')}.`);
  if (wfKo.length) manca.push(`Workflow con ultimo run non verde: ${wfKo.map((r) => r.nome + ' → ' + r.esito).join(', ')}.`);
  if (autoKo.length) manca.push(`Automazioni worker non attive: ${autoKo.map((a) => a.nome + ' → ' + a.stato).join(', ')}.`);
  if (autoSenzaDato.length) manca.push(`Automazioni worker che non dichiarano uno stato: ${autoSenzaDato.map((a) => a.nome).join(', ')} — il report non ne inventa l'esito.`);
  if (mq.length) manca.push(`Fonti che non hanno risposto in questo giro (valori "in arrivo"): ${mq.join(' · ')}.`);
  if (!d.fotoEsatto) manca.push('Conteggio lotti/foto del feed da 16 MB non scaricato per scelta (si attiva con QUADRO_FOTO_ESATTO=1): il report dichiara la size, non un numero stimato.');
  if (!manca.length) manca.push('Nessun buco rilevato in questo giro: tutte le fonti hanno risposto.');

  const md = [];
  md.push(`# 👑 QUADRO GENERALE — ${dataIt}, ore ${oraUtc} UTC`);
  md.push('');
  md.push(`> generato automaticamente dalla Action quadro.yml alle ${oraUtc} UTC — fonte: worker icare-ai, feed GitHub Pages, API GitHub, sito.`);
  md.push(`> Cron ogni 6 ore (00/06/12/18 UTC): nessun Mac, nessuna sessione AI. Prossimo giro automatico alle `
    + `${p2((adesso.getUTCHours() + 6) % 24)}:00 UTC. Feed aggiornato: ${txt(s.aggiornato ? ts(s.aggiornato) : null)}.`);
  md.push('');
  md.push('## 0. In cinque righe');
  md.push('');
  r0.forEach((r, i) => md.push(`${i + 1}. ${r}`));
  md.push('');
  md.push('## 1. Numeri vivi');
  md.push('');
  md.push(tabella(['Indicatore', 'Valore', 'Fonte'], numeri));
  md.push('');
  md.push('## 2. Foto, perizie e OCR — risposta diretta');
  md.push('');
  md.push(`- **Feed foto** \`foto-procedure.json\`: ${fotoMb ? fotoMb + ' MB' : ARRIVO} (${int(foto && foto.byte)} byte, letto da ${foto ? foto.via : ARRIVO}). Non viene scaricato: a ogni giro peserebbe 16 MB per un numero che cambia lentamente.`);
  md.push(`- **OCR perizie**: **${int(ocr)} perizie** con superficie estratta, su **${int(ocrPdf)} PDF** passati dal workflow \`ocr-perizie\` (ultima estrazione ${txt(ts(ocrQuando))}).`);
  md.push(`- **Perché non "tutte"**: la fonte pubblica (PVP e aggregatori) espone documenti solo per una parte dei lotti; ${int(s.totale)} aste in archivio, la coda documenti si raccoglie a giri.`);
  md.push('- **Cosa manca**: un conteggio lotti/foto a ogni giro senza scaricare 16 MB (serve un piccolo feed di sintesi accanto a quello grande).');
  md.push('');
  md.push('## 3. Automazioni');
  md.push('');
  md.push('### Worker icare-ai (stato dichiarato dal worker)');
  md.push('');
  md.push(auto.length ? tabella(['Automazione', 'Cadenza', 'Stato', 'Ultima esecuzione'], righeWorker) : '_Nessuna automazione riportata dal worker: in arrivo._');
  md.push('');
  md.push('### Workflow GitHub — ultimo run');
  md.push('');
  md.push(d.runs.length ? tabella(['Workflow', 'Run', 'Esito', 'Quando'], righeGh) : '_Nessun run leggibile dalla API GitHub: in arrivo._');
  md.push('');
  md.push(`Stato: **${autoOk}/${autoConDato.length || 0}** automazioni worker attive${autoSenzaDato.length ? ' · ' + autoSenzaDato.map((a) => a.nome).join(', ') + ' senza dato' : ''} · **${wfOk.length}/${d.runs.length}** workflow GitHub con ultimo run verde.`);
  md.push('');
  md.push('## 4. Sito, sitemap e configurazione');
  md.push('');
  md.push(tabella(['Rotta', 'HTTP'], righeRotte));
  md.push('');
  md.push(`- **Sitemap italiane**: ${int(d.sitemap && d.sitemap.totale)} URL in ${int(d.sitemap && d.sitemap.pezziLetti)}/${int(d.sitemap && d.sitemap.pezzi)} pezzi${d.sitemap && d.sitemap.url ? ' (' + d.sitemap.url + ')' : ''}.`);
  md.push(`- **IndexNow**: ${int(d.indexnow && d.indexnow.inviati)} URL inviati (${txt(d.indexnow && d.indexnow.quando ? ts(d.indexnow.quando) : null)}), prossimo blocco ${int(d.indexnow && d.indexnow.prossimo)}.`);
  md.push(`- **Config pubblica**: aggiornata ${txt(cfg && cfg.aggiornato && cfg.aggiornato.quando ? ts(cfg.aggiornato.quando) : null)} (sezione ${txt(cfg && cfg.aggiornato && cfg.aggiornato.sezione)}); vetrina ${cfg && cfg.paywall ? (cfg.paywall.vetrinaAperta ? 'aperta' : 'chiusa') : ARRIVO}, oCARe ${cfg && cfg.paywall ? (cfg.paywall.ocarePubblico ? 'pubblica' : 'riservata') : ARRIVO}, iCAReWall ${cfg && cfg.paywall ? (cfg.paywall.icarewallAperta ? 'aperta' : 'chiusa') : ARRIVO}.`);
  if (cfg && cfg.prezzi) {
    md.push(`- **Prezzi in vigore**: iCARe ${eur(cfg.prezzi.icare)} · iShop ${eur(cfg.prezzi.ishop)} · iPartner ${eur(cfg.prezzi.ipartner)} · iGold ${eur(cfg.prezzi.gold)} · success fee ${pctP(cfg.prezzi.successFeeTier1Pct)} / ${pctP(cfg.prezzi.successFeeTier2Pct)} / ${pctP(cfg.prezzi.successFeeTier3Pct)} con minimo ${eur(cfg.prezzi.successFeeMin)} (entro ${txt(cfg.prezzi.successFeePagamentoOre)} ore dall'aggiudicazione).`);
  }
  md.push('');
  // 11/11/2026 — le statistiche nate oggi non erano nel quadro: OMI completo, mercato libero,
  // zone e lotti attivi. Se un feed manca si scrive «in arrivo», mai un numero inventato.
  const oiRaw = d.omiIndice || null;
  const oiNaz = oiRaw && Array.isArray(oiRaw.nazionale) ? oiRaw.nazionale : [];
  const oi = oiNaz.length ? oiNaz[oiNaz.length - 1] : null;
  const mi = d.mercatoIndice && d.mercatoIndice.totale ? d.mercatoIndice.totale : null;
  const az = d.asteZone && d.asteZone.meta ? d.asteZone.meta : null;
  const rc = d.residenzialeComune && d.residenzialeComune.meta ? d.residenzialeComune.meta : null;
  md.push('## 5. Mercato e OMI — le statistiche di oggi');
  md.push('');
  const oiAree = oiRaw && oiRaw.aree ? Object.keys(oiRaw.aree).length : 0;
  const oiReg = oiRaw && oiRaw.regioni ? Object.keys(oiRaw.regioni).length : 0;
  const oiProv = oiRaw && oiRaw.province ? Object.keys(oiRaw.province).length : 0;
  md.push(`- **OMI completo**: ${oi ? `${int(oi.righe)} comuni · ${int(oiAree)} aree · ${int(oiReg)} regioni · ${int(oiProv)} province · ${int(oiNaz.length)} semestri (${oiNaz[0].semestre} → ${oi.semestre})` : ARRIVO}.`);
  md.push(`- **Indice CAReIndex OMI**: ${oi ? `${oi.semestre} · mediana ${int(oi.min)}–${int(oi.max)} €/m² (${int(oi.mediano)} €/m²) · indice ${oi.indice} (base 100 nel 2004/1)` : ARRIVO}.`);
  const ult = mi ? mi[mi.length - 1] : null;
  md.push(`- **Mercato libero** (Eurostat, trimestrale): ${ult ? `${ult.periodo} · indice ${ult.indice} (2015 = 100) · ${ult.variazionePct > 0 ? '+' : ''}${ult.variazionePct}% sul trimestre prima` : ARRIVO}.`);
  md.push(`- **Aste per zona**: ${az ? `${int(az.zone)} zone in ${int(az.comuni)} comuni · ${int(az.assegnati)} lotti attivi assegnati (${int(az.senzaZona)} senza zona)` : ARRIVO}.`);
  md.push(`- **Lotti attivi per comune**: ${rc ? `${int(rc.comuni)} comuni · ${int(rc.letti)} lotti letti dal PVP` : ARRIVO}.`);
  md.push('');
  // 11/11/2026 — blocco indicizzazione: TRE righe distinte, ognuna con la sua verità.
  // La prima è un fatto (URL nella sitemap), la seconda è un invio (IndexNow), la terza
  // NON è verificabile finché Search Console non è collegata: si scrive così, non un numero.
  const sm = d.sitemapMeta || null;
  const inz = d.indexnow || null;
  md.push('## 6. Indicizzazione — tre numeri, tre nature');
  md.push('');
  md.push(`- **URL nella sitemap**: ${sm ? `${int(sm.totale)} (${int(sm.shard)} pezzi · ${(sm.lingue || []).join(', ')})` : ARRIVO}.`);
  md.push(`- **URL inviati a IndexNow**: ${inz ? `${int(inz.inviati)} il ${txt(inz.giorno)}` : ARRIVO}. Un invio è un fatto misurabile; non dimostra che il motore li abbia presi.`);
  md.push('- **URL indicizzati da Google**: non verificabile — Search Console non è collegata. Finché non lo è, questa riga resta «non verificabile» e non si sostituisce con una stima.');
  md.push('');
  md.push('## 7. Cosa manca');
  md.push('');
  manca.forEach((m, i) => md.push(`${i + 1}. ${m}`));
  md.push('');
  md.push('---');
  md.push(`_Report generato da \`scripts/quadro.js\` alle ${oraUtc} UTC del ${dataIt} — nessun numero scritto a mano, nessun dato inventato: le fonti mancanti restano "in arrivo" e vengono elencate qui sopra._`);
  md.push('');

  let testo = md.join('\n');
  const sospetti = (testo.match(/\b(undefined|NaN)\b/g) || []).length;
  if (sospetti) {
    console.log('ATTENZIONE: ' + sospetti + ' valori non risolti sostituiti con "' + ARRIVO + '"');
    testo = testo.replace(/\b(undefined|NaN)\b/g, ARRIVO);
  }
  return testo;
}

// ─── main ────────────────────────────────────────────────────────────────────

(async function main() {
  const adesso = new Date();

  const [automazioni, omi, config] = await Promise.all([
    sicuro('worker stato-automazioni', () => postWorker('stato-automazioni')),
    sicuro('worker omi-stato', () => postWorker('omi-stato')),
    sicuro('worker config-pubblica', () => postWorker('config-pubblica')),
  ]);

  const feeds = {};
  await Promise.all(FEED.map(async ([chiave, nome]) => {
    feeds[chiave] = await sicuro('feed ' + nome, () => leggiFeed(nome));
  }));

  const runs = await Promise.all(WF.map(([nome, file]) => sicuro('run ' + file, () => ultimoRun(nome, file))));

  const [foto, fotoEsatto, sitemap] = await Promise.all([
    sicuro('dimensione feed foto', dimensioneFoto),
    FOTO_ESATTO ? sicuro('conteggio esatto foto', conteggioFotoEsatto) : Promise.resolve(null),
    sicuro('sitemap italiane', sitemapItaliane),
  ]);

  const rotte = await Promise.all(ROTTE.map(async ([percorso, nome]) => {
    const stato = await sicuro('rotta ' + percorso, () => statoRotta(percorso));
    return { percorso, nome, stato: stato === null ? ARRIVO : stato };
  }));

  const dossier = {
    adesso, automazioni, omi, config,
    statistiche: feeds.statistiche, indice: feeds.indice, npl: feeds.npl,
    omiIndice: feeds.omiIndice, mercatoIndice: feeds.mercatoIndice,
    asteZone: feeds.asteZone, residenzialeComune: feeds.residenzialeComune,
    crediti: feeds.crediti, sitemapMeta: feeds.sitemapMeta, indexnow: feeds.indexnow,
    perizieOcr: feeds.perizieOcr, ocrStato: feeds.ocrStato,
    runs: runs.filter(Boolean), rotte, foto, fotoEsatto, sitemap,
  };

  const markdown = costruisci(dossier);

  const p2 = (n) => String(n).padStart(2, '0');
  const nomeFile = `QUADRO-${adesso.getUTCFullYear()}-${p2(adesso.getUTCMonth() + 1)}-${p2(adesso.getUTCDate())}-${p2(adesso.getUTCHours())}.md`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const destinazione = path.join(OUT_DIR, nomeFile);
  fs.writeFileSync(destinazione, markdown, 'utf8');

  console.log('QUADRO scritto: ' + path.relative(ROOT, destinazione));
  console.log('righe: ' + markdown.split('\n').length + ' · byte: ' + Buffer.byteLength(markdown) + ' · fonti cadute: ' + (mq.length || 'nessuna'));
  if (mq.length) console.log('fonti in arrivo: ' + mq.join(' · '));
})().catch((e) => {
  console.error('QUADRO fallito: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
