#!/usr/bin/env node
// indexnow-priorita.mjs — spintex ESPLICITO delle ~200 URL che contano su IndexNow (Bing & co.).
//
// Perche': scripts/indexnow-daily.mjs spinge 10.000 URL al giorno a ROTAZIONE (dispersione).
// Qui invece si costruisce la lista corta delle pagine che devono stare nell'indice di Bing
// (ChatGPT search e Perplexity si appoggiano in larga parte a Bing), si VERIFICA ognuna
// (200 + non noindex + canonica coerente) e si spedisce solo quello che passa.
//
// Regola: una URL che non risponde 200 o che e' noindex NON si spedisce — si dichiara scartata.
//
// Node 22, zero dipendenze. Uso:
//   node scripts/indexnow-priorita.mjs            # verifica + POST + scrive stato/indexnow-priorita.json
//   node scripts/indexnow-priorita.mjs --dry      # verifica soltanto, nessun POST (per provare)
//   node scripts/indexnow-priorita.mjs --max=50   # limita il numero di URL spedite (debug)
//
// Output: stato/indexnow-priorita.json
//   eseguito, totale, verificate, inviate, httpStatus, scartate[], perGiorno{}

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'https://careauctions.co';
const HOST = 'careauctions.co';
const KEY = 'b2c9e4a7f3d15e6b8a0c4d2f6e8a1c3d';
const KEY_LOCATION = `${BASE}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const STATO_FILE = path.join(process.cwd(), 'stato', 'indexnow-priorita.json');

const UA = 'Mozilla/5.0 (compatible; CAReAuctions-IndexNow/1.0; +https://careauctions.co/metodo)';
const TIMEOUT_MS = 30000;
const TENTATIVI = 2;          // una pagina lenta (ne esistono da 15-17 s) non deve diventare uno scarto
const CONCORRENZA = 6;        // il sito regge, ma non lo martelliamo
const MAX_PER_RICHIESTA = 100; // batch: cosi' il codice HTTP e' granulare per gruppo
const GIORNI_STORICO = 7;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const maxArg = args.find((a) => a.startsWith('--max='));
const MAX_URL = maxArg ? Number(maxArg.split('=')[1]) : 0;

// ---------------------------------------------------------------------------
// I 20 hub regionali. Pattern REALE scoperto il 15/11/2026: /aste-<regione>
// (NON /aste-regione-<x>, che risponde 301, e NON /regione/<x>, che e' un'altra cosa).
// Le regioni italiane sono 20 e tutte e 20 rispondono 200 con <title> corretto:
// il brief ne prevedeva 12, la verifica dice 20 — si spediscono tutte e 20.
// ---------------------------------------------------------------------------
const REGIONI = [
  'abruzzo', 'basilicata', 'calabria', 'campania', 'emilia-romagna',
  'friuli-venezia-giulia', 'lazio', 'liguria', 'lombardia', 'marche',
  'molise', 'piemonte', 'puglia', 'sardegna', 'sicilia', 'toscana',
  'trentino-alto-adige', 'umbria', 'valle-d-aosta', 'veneto',
];

// Pagine fisse che contano (istituzionali + dati + risposte).
const PAGINE_FISSE = [
  '/', '/metodo', '/dati', '/fatti', '/risposte', '/sconto-reale-certificato',
  '/guida-definitiva-asta', '/glossario-aste', '/osservatorio', '/idati',
  '/aggiudicazioni', '/ca-re-index',
];

// Le 12 pagine-risposta: pattern reale /risposte/<slug>.
const RISPOSTE = [
  'come-si-compra-casa-allasta',
  'quante-aste-immobiliari-in-italia',
  'conviene-comprare-allasta-o-da-privato',
  'quanto-costa-partecipare-a-unasta',
  'cosa-controllare-nella-perizia',
  'cosa-succede-se-limmobile-e-occupato',
  'quanto-dura-unasta-giudiziaria',
  'cos-e-lofferta-minima',
  'asta-giudiziaria-o-buy-now',
  'meglio-asta-nord-o-sud',
  'quanto-si-risparmia-comprare-allasta',
  'asta-con-incanto-o-senza-incanto',
];

// ---------------------------------------------------------------------------
// utilita'
// ---------------------------------------------------------------------------
function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchTesto(url, { method = 'GET', body = null, headers = {} } = {}) {
  let ultimoErrore = null;
  for (let tentativo = 1; tentativo <= TENTATIVI; tentativo++) {
    try {
      const r = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const testo = method === 'HEAD' ? '' : await r.text();
      return { ok: true, status: r.status, testo, intestazioni: r.headers };
    } catch (e) {
      ultimoErrore = e;
      if (tentativo < TENTATIVI) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { ok: false, status: 0, testo: '', errore: String(ultimoErrore?.message || ultimoErrore).slice(0, 120) };
}

function canonicaDi(html) {
  const m = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  return m ? m[1] : null;
}

function eNoindex(html, intestazioni) {
  const xr = (intestazioni?.get('x-robots-tag') || '').toLowerCase();
  if (xr.includes('noindex')) return 'header x-robots-tag: noindex';
  const meta = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i);
  if (meta && /noindex/i.test(meta[0])) return 'meta robots noindex';
  if (/<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["']/i.test(html)) return 'meta robots noindex';
  return null;
}

async function verifica(url) {
  const r = await fetchTesto(url);
  if (!r.ok) return { esito: 'ko', motivo: `errore di rete dopo ${TENTATIVI} tentativi (${r.errore || 'timeout'})` };
  if (r.status !== 200) return { esito: 'ko', motivo: `HTTP ${r.status}` };
  if (r.testo.length < 200) return { esito: 'ko', motivo: `risposta troppo corta (${r.testo.length} byte)` };
  const ni = eNoindex(r.testo, r.intestazioni);
  if (ni) return { esito: 'ko', motivo: ni };
  const canon = canonicaDi(r.testo);
  const canonPulita = canon ? canon.split('#')[0].replace(/\/$/, '') : null;
  const attesa = url.replace(/\/$/, '');
  if (canonPulita && canonPulita !== attesa) {
    return { esito: 'ko', motivo: `canonica diversa (${canon})` };
  }
  return { esito: 'ok', byte: r.testo.length, canonica: canon };
}

async function inSequenza(elementi, concorrenza, funzione) {
  const risultati = new Array(elementi.length);
  let indice = 0;
  async function operaio() {
    while (indice < elementi.length) {
      const i = indice++;
      risultati[i] = await funzione(elementi[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concorrenza, elementi.length) }, operaio));
  return risultati;
}

function oggiUTC() {
  return new Date().toISOString().slice(0, 10);
}

function leggiStatoPrecedente(percorso) {
  if (!existsSync(percorso)) return { perGiorno: {}, storicoInvii: [] };
  try {
    const j = JSON.parse(readFileSync(percorso, 'utf8'));
    return {
      perGiorno: j && typeof j.perGiorno === 'object' && j.perGiorno ? j.perGiorno : {},
      storicoInvii: Array.isArray(j && j.storicoInvii) ? j.storicoInvii : [],
    };
  } catch {
    return { perGiorno: {}, storicoInvii: [] };
  }
}

// ---------------------------------------------------------------------------
// 1. lista candidata
// ---------------------------------------------------------------------------
async function costruisciLista() {
  const voci = [];
  let fonteCittaMuta = false;
  const aggiungi = (url, gruppo, nota) => voci.push({ url, gruppo, nota });

  for (const r of REGIONI) aggiungi(`${BASE}/aste-${r}`, 'hub-regionale');

  // Le 20 citta' con piu' lotti attivi: si calcolano dal feed vivo, non a memoria.
  let candidatiCitta = [];
  try {
    const r = await fetchTesto(`${BASE}/feed/aste-zone.json`);
    if (r.ok && r.status === 200) {
      const feed = JSON.parse(r.testo);
      const conta = new Map();
      for (const z of feed.zone || []) {
        if (!z.comune) continue;
        conta.set(z.comune, (conta.get(z.comune) || 0) + (Number(z.lottiAttivi) || 0));
      }
      // 32 candidati: se uno dei primi 20 non passa la verifica si sostituisce senza
      // scendere sotto le 20 citta' (la sostituzione finisce comunque in "scartate").
      candidatiCitta = [...conta.entries()]
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 32)
        .map(([comune, lotti]) => ({ comune, lotti, slug: slug(comune) }));
    } else {
      fonteCittaMuta = true;
    }
  } catch (e) {
    console.error('feed aste-zone.json non leggibile:', String(e.message).slice(0, 120));
    fonteCittaMuta = true;
  }
  for (const c of candidatiCitta) aggiungi(`${BASE}/aste-${c.slug}`, 'citta', c.comune);

  // I 148 tribunali: si leggono dalla sitemap vera, non da una lista inventata.
  let tribunali = 0;
  try {
    const r = await fetchTesto(`${BASE}/sitemap-tribunali.xml`);
    if (r.ok && r.status === 200) {
      for (const m of r.testo.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        aggiungi(m[1].trim(), 'tribunale');
        tribunali++;
      }
    }
  } catch (e) {
    console.error('sitemap-tribunali.xml non leggibile:', String(e.message).slice(0, 120));
  }

  for (const p of PAGINE_FISSE) aggiungi(`${BASE}${p}`, 'pagina-fissa');
  for (const s of RISPOSTE) aggiungi(`${BASE}/risposte/${s}`, 'pagina-risposta');

  return { voci, candidatiCitta, tribunali, fonteCittaMuta };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  const eseguito = new Date().toISOString();
  const giorno = oggiUTC();
  const scartate = [];

  // 2. la chiave deve essere servita: se il keyLocation non e' 200, IndexNow rifiuta tutto.
  const chiave = await verificaChiave();
  console.log(`chiave ${KEY_LOCATION} -> HTTP ${chiave.status} ${chiave.ok ? '(ok)' : '(GUASTO)'}`);
  if (!chiave.ok) {
    await scriviStato({
      eseguito, totale: 0, verificate: 0, inviate: 0, httpStatus: null,
      scartate: [{ url: KEY_LOCATION, gruppo: 'chiave', motivo: `keyLocation HTTP ${chiave.status}` }],
      perGiorno: {},
      errore: 'chiave IndexNow non servita: nessuna URL spedita',
    });
    process.exit(1);
  }

  // 3. lista candidata
  const { voci, candidatiCitta, tribunali, fonteCittaMuta } = await costruisciLista();
  const uniche = [...new Map(voci.map((v) => [v.url, v])).values()];
  console.log(`candidati: ${uniche.length} (regioni ${REGIONI.length}, citta' candidati ${candidatiCitta.length}, tribunali ${tribunali}, pagine fisse ${PAGINE_FISSE.length}, risposte ${RISPOSTE.length})`);

  // 4. verifica di ogni URL (200 + non noindex + canonica coerente)
  const verifiche = await inSequenza(uniche, CONCORRENZA, async (v) => ({ ...v, ...(await verifica(v.url)) }));
  const buone = verifiche.filter((v) => v.esito === 'ok');
  for (const v of verifiche.filter((x) => x.esito !== 'ok')) {
    scartate.push({ url: v.url, gruppo: v.gruppo, motivo: v.motivo });
  }
  console.log(`verificate 200 e indicizzabili: ${buone.length} / ${verifiche.length}`);

  // 5. tenere al massimo 20 citta': le prime 20 in ordine di lotti attivi.
  const cittaBuone = buone.filter((v) => v.gruppo === 'citta');
  const cittaScelte = new Set(cittaBuone.slice(0, 20).map((v) => v.url));
  const listaFinale = buone.filter((v) => v.gruppo !== 'citta' || cittaScelte.has(v.url));
  const cittaEscluse = cittaBuone.filter((v) => !cittaScelte.has(v.url)).length;
  if (cittaEscluse) console.log(`citta' verificate ma oltre le 20: ${cittaEscluse} (non spedite: il brief ne chiede 20)`);

  // 6. dedupe giornaliero: la stessa URL non si rispedisce nello stesso giorno
  const precedente = leggiStatoPrecedente(STATO_FILE);
  const giaOggi = new Set(precedente.perGiorno[giorno] || []);
  let daInviare = listaFinale.filter((v) => !giaOggi.has(v.url));
  const giaInviateOggi = listaFinale.length - daInviare.length;
  if (MAX_URL > 0 && daInviare.length > MAX_URL) daInviare = daInviare.slice(0, MAX_URL);

  console.log(`da spedire: ${daInviare.length} (gia' spedite oggi: ${giaInviateOggi})`);

  // 7. POST a IndexNow, a blocchi da 100
  const risposte = [];
  let httpStatus = null;
  let inviate = 0;
  if (DRY) {
    console.log('--dry: nessun POST eseguito');
  } else {
    for (let i = 0; i < daInviare.length; i += MAX_PER_RICHIESTA) {
      const blocco = daInviare.slice(i, i + MAX_PER_RICHIESTA).map((v) => v.url);
      const corpo = JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: blocco });
      const r = await fetchTesto(ENDPOINT, { method: 'POST', body: corpo, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      const statoBlocco = r.ok ? r.status : 0;
      if (httpStatus === null && r.ok) httpStatus = statoBlocco;
      risposte.push({ da: i + 1, a: i + blocco.length, url: blocco.length, status: statoBlocco, risposta: (r.testo || '').slice(0, 200) });
      console.log(`IndexNow blocco ${i + 1}-${i + blocco.length}: HTTP ${statoBlocco}${r.ok ? '' : ' (errore: ' + (r.errore || '') + ')'}`);
      if (statoBlocco === 200 || statoBlocco === 202) {
        inviate += blocco.length;
        for (const u of blocco) giaOggi.add(u);
      } else {
        for (const u of blocco) scartate.push({ url: u, gruppo: 'invio', motivo: `IndexNow HTTP ${statoBlocco}` });
      }
    }
  }

  // 8. storico per giorno, ultimi GIORNI_STORICO giorni
  const perGiorno = { ...precedente.perGiorno, [giorno]: [...giaOggi] };
  const giorni = Object.keys(perGiorno).sort().slice(-GIORNI_STORICO);
  const perGiornoPulito = Object.fromEntries(giorni.map((g) => [g, perGiorno[g]]));

  // storico degli invii: si aggiunge una voce SOLO se questo giro ha spedito davvero.
  // Serve perche' il giro di dedupe successivo scrive inviate: 0 — senza storico la prova
  // dell'invio vero (quante URL, con che codice) si perderebbe nel file.
  const storicoInvii = Array.isArray(precedente.storicoInvii) ? [...precedente.storicoInvii] : [];
  if (!DRY && inviate > 0) {
    storicoInvii.push({ eseguito, giorno, inviate, httpStatus, verificate: buone.length, scartate: scartate.length });
  }
  const storicoPulito = storicoInvii.slice(-GIORNI_STORICO);

  const stato = {
    eseguito,
    host: HOST,
    endpoint: ENDPOINT,
    keyLocation: KEY_LOCATION,
    totale: uniche.length,
    verificate: buone.length,
    selezionate: listaFinale.length,
    inviate: DRY ? 0 : inviate,
    inviateOggi: (perGiornoPulito[giorno] || []).length,
    giaInviateOggi,
    storicoInvii: storicoPulito,
    httpStatus: DRY ? null : httpStatus,
    risposte,
    scartate,
    perGiorno: perGiornoPulito,
    nota:
      'IndexNow accetta le URL (200 = accettate, 202 = accettate con chiave in verifica). ' +
      "L'INDICIZZAZIONE su Bing NON e' misurabile da qui: serve una API key di Bing Webmaster Tools, che nel repo non c'e'.",
  };
  if (fonteCittaMuta) stato.avviso = 'feed/aste-zone.json non leggibile: nessuna citta\' in lista a questo giro';
  if (cittaEscluse) stato.cittaOltreLeVenti = cittaEscluse;

  await scriviStato(stato);

  console.log('');
  console.log(`esito: totale ${stato.totale} · verificate ${stato.verificate} · inviate ${stato.inviate} · httpStatus ${stato.httpStatus} · scartate ${stato.scartate.length}`);
  if (!DRY && inviate === 0 && daInviare.length > 0) process.exit(1);
})().catch(async (e) => {
  console.error('ERRORE:', e && e.stack ? e.stack : e);
  process.exit(1);
});

async function verificaChiave() {
  const r = await fetchTesto(KEY_LOCATION);
  const contenuto = (r.testo || '').trim();
  if (!r.ok) return { ok: false, status: 0 };
  // il file deve contenere la chiave: un 200 su una pagina HTML non vale come chiave servita
  if (r.status !== 200 || !contenuto.includes(KEY)) return { ok: false, status: r.status };
  return { ok: true, status: r.status };
}

async function scriviStato(stato) {
  await mkdir(path.dirname(STATO_FILE), { recursive: true });
  await writeFile(STATO_FILE, JSON.stringify(stato, null, 2) + '\n', 'utf8');
  console.log(`stato scritto: ${STATO_FILE}`);
}
