#!/usr/bin/env node
/**
 * fallco-aggiudicazioni.js — Raccoglitore dei prezzi di aggiudicazione FallcoAste (Zucchetti)
 * Progetto CARe Auctions / PuntoLuce — regia Sam 5.1
 *
 * COSA FA
 *  1. Fase 1 (aggregatore): scorre TUTTE le pagine di
 *     https://www.fallcoaste.it/vendite-aggiudicate.html  (rete IVG completa)
 *  2. Fase 2 (sottodomini): scandisce OGNI sottodominio IVG attivo
 *     (ivgverona, ivgroma, ivgnapoli, asteivg, ...) sullo stesso endpoint
 *  3. Fase 3 (discovery): prova i candidati extra e i nuovi host visti nei link
 *  4. Deduplica per id lotto (uno stesso lotto compare su più host),
 *     salva TUTTO in /tmp/aggiudicazioni-fallco.json e stampa il totale.
 *
 * MECCANISMO PAGINAZIONE (scoperto e verificato):
 *  - Paginazione GET server-rendered: vendite-aggiudicate.html?page=N
 *    (il JS front (jquery.helper.js setup_pagination, total_elements + per_page=15)
 *    fa semplicemente window.location = url + "?page=N": niente AJAX/POST).
 *  - ~15 lotti per pagina; la pagina 1 dichiara il totale ("N Risultati").
 *
 * VINCOLI: solo dati pubblici, nessun login, nessun pagamento.
 * CORTESIA: 300 ms tra richieste, max 5 tentativi con backoff, timeout 25 s.
 */
'use strict';

const fs = require('fs');

const OUT_FILE = '/tmp/aggiudicazioni-fallco.json';
const DELAY_MS = 300;            // pausa minima tra richieste (cortesia)
const MAX_RETRIES = 5;           // max tentativi per pagina
const TIMEOUT_MS = 25000;
const PER_PAGE = 15;             // lotti per pagina (verificato sul server)
const MAX_PAGES_PER_SITE = 600;  // tetto di sicurezza
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Sottodomini IVG attivi verificati (probe DNS+HTTP del 2026-10-29) + candidati da riprovare.
const BASE_SITES = [
  'www.fallcoaste.it',
  'asteivg.fallcoaste.it',       // I.V.G. di Venezia (piattaforma gruppo)
  'ivgverona.fallcoaste.it',
  'ivgroma.fallcoaste.it',
  'ivgnapoli.fallcoaste.it',
  'ivgpadova.fallcoaste.it',
  'ivgvicenza.fallcoaste.it',
  'ivgbrescia.fallcoaste.it',
  'ivgbergamo.fallcoaste.it',
  'ivgtrento.fallcoaste.it',
  'ivgudine.fallcoaste.it',
  'ivggenova.fallcoaste.it',
  'ivgmodena.fallcoaste.it',
  'ivgparma.fallcoaste.it',
  'ivgpisa.fallcoaste.it',
  'ivgsalerno.fallcoaste.it',
  'ivgforli.fallcoaste.it',
  'ivgravenna.fallcoaste.it',
  'ivgimperia.fallcoaste.it',
  'ivgmantova.fallcoaste.it',
  'ivgcremona.fallcoaste.it',
  'ivgcrema.fallcoaste.it',
  'ivgcosenza.fallcoaste.it',    // attivo ma 0 risultati
  'ivgreggioemilia.fallcoaste.it',
  'ivgrovigo.fallcoaste.it',     // IS.VE.GI. Rovigo
  'sivag.fallcoaste.it',         // Sivag spa
];

// Candidati da tentare in fase discovery (in parte NXDOMAIN/offline).
const EXTRA_CANDIDATES = [
  'ivgbologna.fallcoaste.it', 'ivgfirenze.fallcoaste.it', 'ivgtorino.fallcoaste.it',
  'ivgmilano.fallcoaste.it', 'ivgvenezia.fallcoaste.it', 'ivgbolzano.fallcoaste.it',
  'ivgtrieste.fallcoaste.it', 'ivgancona.fallcoaste.it', 'ivgperugia.fallcoaste.it',
  'ivgbari.fallcoaste.it', 'ivglecce.fallcoaste.it', 'ivgcatania.fallcoaste.it',
  'ivgpalermo.fallcoaste.it', 'ivgcagliari.fallcoaste.it', 'ivgrimini.fallcoaste.it',
  'ivgpavia.fallcoaste.it', 'ivglodi.fallcoaste.it', 'ivgpavialodi.fallcoaste.it',
  'isvegi.fallcoaste.it', 'ivgtreviso.fallcoaste.it', 'ivgbelluno.fallcoaste.it',
  'ivgpiacenza.fallcoaste.it', 'ivgferrara.fallcoaste.it', 'ivgmonza.fallcoaste.it',
  'ivgcomo.fallcoaste.it', 'ivgnovara.fallcoaste.it', 'ivgsondrio.fallcoaste.it',
  'ivgsavona.fallcoaste.it', 'ivgaosta.fallcoaste.it', 'ivgcuneo.fallcoaste.it',
  'ivgasti.fallcoaste.it', 'ivgvarese.fallcoaste.it', 'ivglecco.fallcoaste.it',
  'ivgspezia.fallcoaste.it', 'ivgmassa.fallcoaste.it', 'ivglucca.fallcoaste.it',
  'ivglivorno.fallcoaste.it', 'ivgarezzo.fallcoaste.it', 'ivgsiena.fallcoaste.it',
  'ivggrosseto.fallcoaste.it', 'ivgviterbo.fallcoaste.it', 'ivglatina.fallcoaste.it',
  'ivgfrosinone.fallcoaste.it', 'ivgterni.fallcoaste.it', 'ivgmacerata.fallcoaste.it',
  'ivgpesaro.fallcoaste.it', 'ivgchieti.fallcoaste.it', 'ivgteramo.fallcoaste.it',
  'ivglaquila.fallcoaste.it', 'ivgpotenza.fallcoaste.it', 'ivgcatanzaro.fallcoaste.it',
  'ivgreggiocalabria.fallcoaste.it', 'ivgtaranto.fallcoaste.it', 'ivgfoggia.fallcoaste.it',
  'ivgcampobasso.fallcoaste.it', 'ivgtrapani.fallcoaste.it', 'ivgagrigento.fallcoaste.it',
  'ivgmessina.fallcoaste.it', 'ivgsiracusa.fallcoaste.it', 'ivgsassari.fallcoaste.it',
  'ivgnuoro.fallcoaste.it', 'ivgoristano.fallcoaste.it', 'ivgbrindisi.fallcoaste.it',
  'ivgmatera.fallcoaste.it', 'ivgprato.fallcoaste.it', 'ivgfaenza.fallcoaste.it',
  'ivgcesena.fallcoaste.it', 'ivgalessandria.fallcoaste.it', 'ivgvercelli.fallcoaste.it',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/** GET con retry (max 5) + backoff; ritorna {ok, html, status, error, attempts}. */
async function getHtml(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      return { ok: true, html, status: res.status, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(DELAY_MS + attempt * 800); // backoff crescente
      }
    }
  }
  return { ok: false, html: null, status: null, error: String(lastErr && lastErr.message || lastErr), attempts: MAX_RETRIES };
}

const unescapeHtml = (s) =>
  s
    .replace(/&#x3A;/gi, ':')
    .replace(/&#x2F;/gi, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** Estrae le righe (lotti) da una pagina HTML del listato aggiudicazioni. */
function parseListPage(html) {
  const totalMatch = html.match(/<strong>([\d.]+)<\/strong>\s*Risultati/);
  const totaleDichiarato = totalMatch ? parseInt(totalMatch[1].replace(/\./g, ''), 10) : null;

  const rows = [];
  const artRe = /<article\b[\s\S]*?<\/article>/gi;
  let m;
  while ((m = artRe.exec(html)) !== null) {
    const a = m[0];

    const idM = a.match(/data-auction-id="(\d+)"/);
    if (!idM) continue;
    const id = idM[1];

    let url = null;
    const urlM = a.match(/data-auction-url="([^"]+)"/);
    if (urlM) url = unescapeHtml(urlM[1]);

    const dataInizio = (a.match(/data-auction-data-inizio="([^"]*)"/) || [])[1] || null;
    const dataTermine = (a.match(/data-auction-data-termine="([^"]*)"/) || [])[1] || null;

    // Descrizione completa dall'attributo title del link foto (non troncato)
    let descrizione = null;
    const descM = a.match(/class="single-photo"\s+title="([^"]*)"/);
    if (descM) descrizione = unescapeHtml(descM[1]).trim();
    if (!descrizione) {
      const h3M = a.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      if (h3M) descrizione = stripTags(h3M[1]);
    }

    // Prezzo: etichetta + valore
    let prezzoLabel = null;
    let prezzo = null;
    const pbM = a.match(/<span\s+class="price-block"[\s\S]*?<\/span>/i);
    if (pbM) {
      const lblM = pbM[0].match(/<div class="label-desc">([^<]*)<\/div>/);
      if (lblM) prezzoLabel = lblM[1].trim();
      const prM = pbM[0].match(/class="price-element[^"]*">\s*([^<]+)/);
      if (prM) prezzo = prM[1].trim();
    }

    // Termine mostrato ("28/10/26 17:40") — subito dopo l'etichetta "Termine :"
    let termine = null;
    const cdM = a.match(/Termine\s*:<\/div>\s*<strong[^>]*>\s*([^<]+?)\s*<\/strong>/i);
    if (cdM) termine = cdM[1].trim();
    if (!termine && dataTermine) termine = dataTermine;

    // Tribunale / procedura (blocco name_type)
    let tribunale = null;
    const ntM = a.match(/<div class="infos[^"]*name_type"[\s\S]*?<\/div>\s*<\/div>\s*<\/article>/i);
    if (ntM) {
      const block = ntM[0];
      const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
      let pm;
      while ((pm = pRe.exec(block)) !== null) {
        const txt = stripTags(pm[1]);
        if (/tribunale|procedura/i.test(txt)) { tribunale = txt; break; }
      }
    }
    if (!tribunale) {
      const tbM = a.match(/Tribunale\s+di\s+[^<]{0,150}/i);
      if (tbM) tribunale = tbM[0].replace(/\s+/g, ' ').trim();
    }

    // "In vendita presso" (presente solo sull'aggregatore www e su asteivg)
    let presso = null;
    const pvM = a.match(/In vendita presso:<\/span>\s*<a[^>]*>\s*([^<]*?)\s*<\/a>/i);
    if (pvM) presso = pvM[1].trim();

    rows.push({
      id,
      url,
      descrizione,
      prezzo,
      prezzo_label: prezzoLabel,
      termine,
      termine_completa: dataTermine,
      inizio_completa: dataInizio,
      ivg: presso || null,   // compilato in fase merge se assente
      tribunale,
      host: null,            // compilato dal chiamante
    });
  }
  return { totaleDichiarato, rows };
}

/** Scorre tutte le pagine di un host; ritorna {totaleDichiarato, pagine, rows}. */
async function crawlSite(host) {
  const rowsAll = [];
  const seenIds = new Set();
  let totaleDichiarato = null;
  let pages = 0;
  let maxPages = MAX_PAGES_PER_SITE;

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://${host}/vendite-aggiudicate.html?page=${page}`;
    const res = await getHtml(url);
    await sleep(DELAY_MS); // cortesia tra richieste

    if (!res.ok) {
      log(`  ${host} p.${page}: ERRORE dopo ${res.attempts} tentativi (${res.error}) — stop sito`);
      break;
    }

    const { totaleDichiarato: t, rows } = parseListPage(res.html);
    if (totaleDichiarato === null && t !== null) {
      totaleDichiarato = t;
      maxPages = Math.ceil(t / PER_PAGE) + 3;
      if (maxPages > MAX_PAGES_PER_SITE) maxPages = MAX_PAGES_PER_SITE;
    }
    pages = page;

    if (rows.length === 0) {
      log(`  ${host} p.${page}: 0 lotti — fine sito`);
      break;
    }

    // Se la pagina restituisce solo lotti già visti, siamo oltre l'ultima pagina reale.
    const newRows = rows.filter((r) => !seenIds.has(r.id));
    if (page > 1 && newRows.length === 0) {
      log(`  ${host} p.${page}: pagina ripetuta (${rows.length} lotti già visti) — fine sito`);
      break;
    }

    for (const r of rows) {
      r.host = host;
      seenIds.add(r.id);
      rowsAll.push(r);
    }
    if (rows.length < PER_PAGE && page >= maxPages - 3) break;

    if (page % 20 === 0) log(`  ${host}: pagina ${page}/${maxPages} (lotti visti: ${seenIds.size})`);
  }

  return { totaleDichiarato, pagine: pages, rows: rowsAll };
}

async function main() {
  const t0 = Date.now();
  log(`Avvio raccolta. Output: ${OUT_FILE}`);

  // ---------- FASE 1: aggregatore www (rete completa) ----------
  log('FASE 1 — aggregatore www.fallcoaste.it');
  const www = await crawlSite('www.fallcoaste.it');
  log(`  www: ${www.rows.length} lotti su ${www.pagine} pagine (dichiarati: ${www.totaleDichiarato})`);

  // Host visti nei link dei lotti (discovery in-band)
  const discovered = new Set();
  for (const r of www.rows) {
    if (r.url) {
      const h = r.url.replace(/^https?:\/\//, '').split('/')[0];
      if (h && h.endsWith('fallcoaste.it')) discovered.add(h);
    }
  }
  log(`Host scoperti dai link: ${[...discovered].join(', ') || '(nessuno)'}`);

  // ---------- FASE 2: ogni sottodominio IVG ----------
  log('FASE 2 — sottodomini IVG');
  const siteSet = new Set([...BASE_SITES, ...discovered]);
  const siteStats = {};
  const allRows = [...www.rows];

  for (const host of [...siteSet].sort()) {
    if (host === 'www.fallcoaste.it') continue; // già fatto in fase 1
    const r = await crawlSite(host);
    siteStats[host] = {
      totale_dichiarato: r.totaleDichiarato,
      pagine_lette: r.pagine,
      righe_estratte: r.rows.length,
    };
    allRows.push(...r.rows);
    log(`  ${host}: ${r.rows.length} lotti su ${r.pagine} pagine (dichiarati: ${r.totaleDichiarato ?? 'n/d'})`);
  }

  // ---------- FASE 3: candidati extra non ancora in lista ----------
  log('FASE 3 — candidati extra');
  const inactive = [];
  for (const host of EXTRA_CANDIDATES) {
    if (siteSet.has(host)) continue;
    const res = await getHtml(`https://${host}/vendite-aggiudicate.html?page=1`);
    await sleep(DELAY_MS);
    if (!res.ok) {
      inactive.push({ host, motivo: res.error });
      continue;
    }
    const { totaleDichiarato: t, rows } = parseListPage(res.html);
    if (t === null && rows.length === 0) {
      inactive.push({ host, motivo: 'pagina senza listato aggiudicazioni' });
      continue;
    }
    // host attivo: crawl completo
    const r = await crawlSite(host);
    siteStats[host] = {
      totale_dichiarato: r.totaleDichiarato,
      pagine_lette: r.pagine,
      righe_estratte: r.rows.length,
    };
    allRows.push(...r.rows);
    log(`  ${host} (scoperto in fase 3): ${r.rows.length} lotti (dichiarati: ${r.totaleDichiarato ?? 'n/d'})`);
  }
  if (inactive.length) log(`Candidati inattivi/irraggiungibili: ${inactive.map((x) => x.host).join(', ')}`);

  // ---------- MERGE + dedup per id ----------
  log('Merge e deduplica per id lotto...');
  const byId = new Map();
  for (const r of allRows) {
    const ex = byId.get(r.id);
    if (ex) {
      if (!ex.hosts.includes(r.host)) ex.hosts.push(r.host);
      // Preferisci la riga con etichetta "In vendita presso" (www/asteivg) per il campo ivg
      if (!ex.ivg && r.ivg) ex.ivg = r.ivg;
      if (!ex.tribunale && r.tribunale) ex.tribunale = r.tribunale;
      if (!ex.prezzo && r.prezzo) { ex.prezzo = r.prezzo; ex.prezzo_label = r.prezzo_label; }
      continue;
    }
    const hosts = [r.host];
    byId.set(r.id, { ...r, hosts });
  }

  const voci = [];
  for (const [id, r] of byId) {
    const prezzoNum = r.prezzo ? parseFloat(r.prezzo.replace(/\./g, '').replace(',', '.')) : null;
    const ivg = r.ivg || r.hosts[0] || null; // fallback: host del lotto
    voci.push({
      id,
      descrizione: r.descrizione,
      prezzo: r.prezzo,
      prezzo_numero: Number.isFinite(prezzoNum) ? prezzoNum : null,
      prezzo_label: r.prezzo_label,
      termine: r.termine,
      termine_completa: r.termine_completa,
      inizio_completa: r.inizio_completa,
      ivg,
      tribunale: r.tribunale,
      url: r.url,
      hosts: r.hosts,
    });
  }
  voci.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const out = {
    raccolto_il: new Date().toISOString(),
    fonte: 'FallcoAste (Zucchetti) — https://www.fallcoaste.it/vendite-aggiudicate.html e sottodomini IVG',
    meccanismo_paginazione:
      'GET server-rendered: ?page=N (setup_pagination del front fa window.location con parametro "page"; ~15 lotti/pagina)',
    totale_voci_uniche: voci.length,
    siti: siteStats,
    siti_inattivi: inactive,
    voci,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf-8');
  log(`Salvato ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2)} MB)`);

  // ---------- RIEPILOGO ----------
  console.log('\n=== RIEPILOGO RACCOLTA FALLCOASTE ===');
  console.log(`Totale voci UNICHE: ${voci.length}`);
  console.log('Per sito (dichiarato / pagine lette / righe estratte):');
  console.log(`  www.fallcoaste.it: ${www.totaleDichiarato} / ${www.pagine} / ${www.rows.length}`);
  for (const [h, s] of Object.entries(siteStats).sort()) {
    console.log(`  ${h}: ${s.totale_dichiarato ?? 'n/d'} / ${s.pagine_lette} / ${s.righe_estratte}`);
  }
  if (inactive.length) console.log(`  [inattivi: ${inactive.map((x) => x.host).join(', ')}]`);
  const conPrezzo = voci.filter((v) => v.prezzo !== null).length;
  const conMigliorOfferta = voci.filter((v) => v.prezzo_label && v.prezzo_label.includes('Miglior offerta')).length;
  console.log(`Con prezzo: ${conPrezzo} | con "Miglior offerta €": ${conMigliorOfferta}`);
  console.log(`Durata: ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  console.log(`TOTALE: ${voci.length}`);
}

// Smoke-test del parser: FALLCO_TEST_FILE=/path/file.html node fallco-aggiudicazioni.js
if (process.env.FALLCO_TEST_FILE) {
  const html = fs.readFileSync(process.env.FALLCO_TEST_FILE, 'utf-8');
  const { totaleDichiarato, rows } = parseListPage(html);
  console.log(`TEST ${process.env.FALLCO_TEST_FILE}: dichiarati=${totaleDichiarato} righe=${rows.length}`);
  for (const r of rows.slice(0, 4)) {
    console.log(JSON.stringify({ id: r.id, presso: r.ivg, prezzo: r.prezzo, label: r.prezzo_label, termine: r.termine, trib: r.tribunale, desc: (r.descrizione || '').slice(0, 50) }));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('ERRORE FATALE:', e);
  process.exit(1);
});
