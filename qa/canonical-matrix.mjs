#!/usr/bin/env node
/**
 * qa/canonical-matrix.mjs — matrice canonical × locale su careauctions.co
 *
 * PERCHÉ ESISTE (15/11/2026)
 * L'app riscrive <link rel="canonical"> nel DOM aggiungendo ?lang=<lingua-ui> quando la
 * lingua del browser non è italiano. L'HTML server-side è corretto: il difetto nasce solo
 * dopo il mount dell'app, quindi va misurato con un browser vero (Playwright) e non con curl.
 * Emergent pubblica spesso: la matrice va rifatta a OGNI publish. Questo script è quello che
 * esegue il workflow `.github/workflows/verifica-canonical.yml` (che lo committa in
 * qa/canonical.json e fallisce se il verdetto è FAIL).
 *
 * COME MISURA
 * - Chromium headless, viewport 1366x768, una browser-context per locale (it-IT, en-US).
 * - Una rotta per riga, 800 ms fra una e l'altra.
 * - `waitUntil: 'networkidle'` + 2000 ms di attesa: senza l'attesa si misura l'HTML
 *   server-side (corretto) e non il DOM dopo il mount (dove il canonical viene riscritto).
 * - Per ogni render legge `document.querySelector('link[rel="canonical"]')` → href e
 *   presenza dell'attributo data-lp, e l'hash della build dal primo
 *   `script[src*="/static/js/main."]`.
 *
 * REGOLA DI GIUDIZIO
 * Una riga è OK solo se il canonical esiste e NON contiene '?' e NON contiene 'lang='.
 * Una riga non misurata non è mai "buona": canonical assente → OK:false motivo
 * 'canonical assente'; pagina non caricata (timeout / HTTP >= 400 / errore browser) →
 * OK:false con il motivo dell'errore.
 *
 * USCITA
 * Codice 1 se almeno una riga è KO, 0 se il verdetto è PASS.
 *
 * USO
 *   node qa/canonical-matrix.mjs
 *   QA_BASE_URL=http://127.0.0.1:8099 node qa/canonical-matrix.mjs   (prove locali)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE_URL = (process.env.QA_BASE_URL || 'https://careauctions.co').replace(/\/+$/, '');
const ROTTE = [
  '/',
  '/chi-siamo',
  '/contatti',
  '/metodo',
  '/dati',
  '/sconto-reale-certificato',
  '/guida-definitiva-asta',
  '/glossario-aste',
  '/guide/it/comprare-casa-allasta',
  '/aste/1822566',
];
const LOCALI = ['it-IT', 'en-US'];
const VIEWPORT = { width: 1366, height: 768 };
const NAV_TIMEOUT_MS = 45000;
const ATTESA_POST_MOUNT_MS = 2000;
const ATTESA_CANONICAL_MS = 15000; // attesa mirata del canonical dopo il mount (sostituisce networkidle)
const PAUSA_TRA_ROTTE_MS = 800;
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'canonical.json');

const righe = [];
const buildVisti = [];

function motivoErrore(e) {
  return String((e && e.message) || e || 'errore sconosciuto')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/** Giudica il canonical di una riga. Ritorna { ok, motivo }. */
function giudica(canonical) {
  if (!canonical) return { ok: false, motivo: 'canonical assente' };
  if (canonical.includes('lang=')) return { ok: false, motivo: 'canonical con lang=' };
  if (canonical.includes('?')) return { ok: false, motivo: 'canonical con query' };
  return { ok: true, motivo: '' };
}

/**
 * Apre una pagina, aspetta il mount, legge canonical/dataLp/build.
 * Ritorna l'oggetto letto oppure { errore: '<motivo>' }: mai una riga "buona" per sbaglio.
 */
async function render(context, rotta) {
  const url = BASE_URL + rotta;
  const pagina = await context.newPage();
  try {
    // 18/11/2026 — NON si aspetta 'networkidle': la pagina del lotto (shell ~240 KB + polling dell'app)
    // non ci arriva MAI e il goto andava in timeout (2 KO su /aste/1822566, misurati il 18/11). Si aspettano
    // gli eventi DOM e poi il canonical con un'attesa MIRATA: il controllo resta severo (canonical
    // obbligatorio), ma non dipende più da una condizione che quella pagina non soddisfa.
    const risposta = await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    if (risposta && risposta.status() >= 400) {
      return { errore: `HTTP ${risposta.status()} su ${url}` };
    }
    // L'app riscrive il canonical dopo il mount: senza questa attesa si misura l'HTML
    // server-side, che è corretto, e il difetto diventa invisibile.
    await pagina
      .waitForFunction(() => !!document.querySelector('link[rel="canonical"]'), { timeout: ATTESA_CANONICAL_MS })
      .catch(() => {
        /* niente canonical entro il tempo: la riga dirà «nessun canonical», che è il KO vero */
      });
    await pagina.waitForTimeout(ATTESA_POST_MOUNT_MS);
    return await pagina.evaluate(() => {
      const link = document.querySelector('link[rel="canonical"]');
      const script = document.querySelector('script[src*="/static/js/main."]');
      let build = null;
      if (script) {
        const m = (script.getAttribute('src') || '').match(/main\.([A-Za-z0-9_-]+)\.js/);
        if (m) build = m[1];
      }
      return {
        canonical: link ? link.getAttribute('href') || link.href || null : null,
        dataLp: link ? link.hasAttribute('data-lp') : false,
        build,
      };
    });
  } catch (e) {
    return { errore: motivoErrore(e) };
  } finally {
    await pagina.close().catch(() => {});
  }
}

function aggiungiRiga(rotta, locale, esito) {
  const riga = { rotta, locale, canonical: null, dataLp: false, ok: false, motivo: '' };
  if (esito.errore) {
    riga.motivo = esito.errore;
  } else {
    riga.canonical = esito.canonical;
    riga.dataLp = Boolean(esito.dataLp);
    const giudizio = giudica(esito.canonical);
    riga.ok = giudizio.ok;
    riga.motivo = giudizio.motivo;
    if (esito.build) buildVisti.push(esito.build);
  }
  righe.push(riga);
  const stato = riga.ok ? 'OK' : 'KO';
  console.log(
    `[${stato}] ${locale.padEnd(5)} ${rotta} → ${riga.canonical ?? '(nessun canonical)'}` +
      `${riga.motivo ? ' · ' + riga.motivo : ''}` +
      `${esito.build ? ' · build ' + esito.build : ''}`
  );
  return riga;
}

function buildDominante() {
  if (!buildVisti.length) return null;
  const conta = new Map();
  for (const b of buildVisti) conta.set(b, (conta.get(b) || 0) + 1);
  return [...conta.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function scriviRisultato(extra = {}) {
  const attese = ROTTE.length * LOCALI.length;
  const ko = righe.filter((r) => !r.ok).length;
  // Una matrice incompleta NON può essere PASS: le righe mancanti non sono state misurate.
  const incompleta = righe.length < attese;
  const risultato = {
    generatoIl: new Date().toISOString(),
    build: buildDominante(),
    righe,
    ko,
    totale: righe.length,
    verdetto: !incompleta && ko === 0 ? 'PASS' : 'FAIL',
    ...(incompleta ? { erroreMatrice: `matrice incompleta: ${righe.length} righe su ${attese}` } : {}),
    ...extra,
  };
  // Se durante il giro è cambiata la build servita (Emergent pubblica mentre si misura),
  // le righe appartengono a build diverse: va dichiarato, non nascosto.
  const distinte = [...new Set(buildVisti)].sort();
  if (distinte.length > 1) risultato.buildVisti = distinte;
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(risultato, null, 2) + '\n');
  console.log(
    `\nqa/canonical.json → ${risultato.verdetto}: ${ko} KO su ${risultato.totale} righe · build ${risultato.build ?? 'non letta'} · generato ${risultato.generatoIl}`
  );
  return risultato;
}

async function main() {
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    const motivo = `browser non avviato: ${motivoErrore(e)}`;
    for (const locale of LOCALI) for (const rotta of ROTTE) aggiungiRiga(rotta, locale, { errore: motivo });
    return;
  }
  try {
    for (const locale of LOCALI) {
      let context = null;
      try {
        context = await browser.newContext({ viewport: VIEWPORT, locale });
      } catch (e) {
        const motivo = `contesto ${locale} non creato: ${motivoErrore(e)}`;
        for (const rotta of ROTTE) aggiungiRiga(rotta, locale, { errore: motivo });
        continue;
      }
      for (const rotta of ROTTE) {
        aggiungiRiga(rotta, locale, await render(context, rotta));
        await new Promise((r) => setTimeout(r, PAUSA_TRA_ROTTE_MS));
      }
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

try {
  await main();
  const risultato = scriviRisultato();
  process.exitCode = risultato.verdetto === 'PASS' ? 0 : 1;
} catch (e) {
  // Errore fatale (non una singola rotta): nessuna riga resta "non misurata e promossa".
  console.error('ERRORE FATALE:', motivoErrore(e));
  scriviRisultato({ errore: motivoErrore(e) });
  process.exitCode = 1;
}
