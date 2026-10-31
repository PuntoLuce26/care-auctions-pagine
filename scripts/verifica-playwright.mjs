#!/usr/bin/env node
/**
 * verifica-playwright.mjs — Sam 5.7 · 31/10/2026
 * Verifica DAL VIVO di careauctions.co con Playwright + Chrome headless.
 * Pensato per essere usato da TUTTE le AI del branco (Sam, teammate, CI):
 * stesso comando, stesso risultato, exit code affidabile.
 *
 * Uso:
 *   node puntoluce/scripts/verifica-playwright.mjs
 *   node puntoluce/scripts/verifica-playwright.mjs --mobile
 *   node puntoluce/scripts/verifica-playwright.mjs --routes=/,/indice,/osservatorio,/dati
 *   node puntoluce/scripts/verifica-playwright.mjs --screens=/tmp/schermate --out=/tmp/verifica.json
 *   node puntoluce/scripts/verifica-playwright.mjs --strict   (anche i console error diventano KO)
 *
 * Opzioni:
 *   --base=URL        base (default https://careauctions.co)
 *   --routes=a,b,c    rotte (default: /, /indice, /osservatorio, /dati, /mappa-prezzi, /torre-di-controllo)
 *   --mobile          aggiunge il giro in emulazione iPhone 13 (390x844, touch, DPR 3)
 *   --screens=DIR     salva uno screenshot per rotta (viewport, non full page)
 *   --out=FILE        salva il JSON completo
 *   --wait=3500       ms di attesa dopo il load (default 3500)
 *   --timeout=45000   timeout per navigazione (default 45000)
 *   --strict          considera KO anche i console error (di default contano solo pageerror/HTTP/root vuota)
 *
 * KO = pageerror, documento HTTP >= 400, oppure rotta app con #root vuota.
 * Le risorse 4xx e i console error vengono stampati come WARN (servono a capire, non a bloccare).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const BASE = String(args.base || 'https://careauctions.co').replace(/\/$/, '');
const ROUTES = String(args.routes || '/,/indice,/osservatorio,/dati,/mappa-prezzi,/torre-di-controllo')
  .split(',').map((s) => s.trim()).filter(Boolean);
const WAIT = Number(args.wait || 3500);
const TIMEOUT = Number(args.timeout || 45000);
const OUT = args.out ? String(args.out) : null;
const SCREENS = args.screens ? String(args.screens) : null;
const STRICT = !!args.strict;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_ROUTES = new Set(['/indice', '/osservatorio', '/dati']);

const MOBILE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

if (SCREENS) mkdirSync(SCREENS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true }).catch(async () => {
  return chromium.launch({ headless: true });
});

async function giro(label, opts, routes) {
  const out = {};
  for (const r of routes) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errs = [], badResp = [], failed = [];
    let pageErrors = 0;
    page.on('pageerror', (e) => { pageErrors++; errs.push('PAGEERROR: ' + String(e.message).slice(0, 200)); });
    page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200)); });
    page.on('response', (r) => { try { if (r.status() >= 400) badResp.push(r.status() + ' ' + r.url().slice(0, 220)); } catch (e) {} });
    page.on('requestfailed', (r) => failed.push(r.url().slice(0, 220) + ' :: ' + ((r.failure() && r.failure().errorText) || 'failed')));
    const t0 = Date.now();
    let http = null, sw = null, caches = null, heap = null, nodes = 0, text = 0, title = '';
    try {
      const resp = await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      http = resp ? resp.status() : null;
      await page.waitForTimeout(WAIT);
      title = await page.title();
      heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
      sw = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((x) => x.length)).catch(() => null);
      caches = await page.evaluate(() => caches.keys().then((x) => x.length)).catch(() => null);
      nodes = await page.evaluate(() => document.querySelectorAll('*').length);
      text = await page.evaluate(() => (document.getElementById('root')?.innerText || document.body.innerText || '').trim().length);
      if (SCREENS) await page.screenshot({ path: `${SCREENS}/${label}${r.replace(/[^a-z0-9]+/gi, '_') || 'home'}.png` });
    } catch (e) {
      errs.push('NAV: ' + String(e.message).slice(0, 200));
    }
    out[r] = { http, ms: Date.now() - t0, heapMb: heap, sw, caches, nodes, text, title, pageErrors, errs: errs.slice(0, 6), badResp: badResp.slice(0, 6), failed: failed.slice(0, 6) };
    await ctx.close();
  }
  return out;
}

const risultato = { quando: new Date().toISOString(), base: BASE, desktop: await giro('desktop', { viewport: { width: 1280, height: 900 } }, ROUTES) };
if (args.mobile) risultato.mobile = await giro('mobile', MOBILE, ROUTES);

await browser.close();

let ko = 0;
console.log(`\nVERIFICA PLAYWRIGHT — ${risultato.quando}\nbase: ${BASE}${args.mobile ? ' · desktop + mobile' : ' · desktop'}${STRICT ? ' · strict' : ''}\n`);
for (const [label, g] of Object.entries({ desktop: risultato.desktop, mobile: risultato.mobile }).filter(([, g]) => g)) {
  for (const [r, v] of Object.entries(g)) {
    const vuota = APP_ROUTES.has(r) && v.text < 100;
    const bad = v.pageErrors > 0 || !v.http || v.http >= 400 || vuota || (STRICT && v.errs.length > 0);
    if (bad) ko++;
    console.log(`${bad ? 'KO ' : 'OK '} [${label}] ${r.padEnd(22)} http=${v.http ?? '-'} ${String(v.ms).padStart(6)}ms  nodi=${String(v.nodes).padStart(5)}  testo=${String(v.text).padStart(6)}  heap=${v.heapMb ?? '-'}MB  sw=${v.sw ?? '-'} cache=${v.caches ?? '-'}${vuota ? '  <<< VUOTA' : ''}`);
    if (v.errs.length) v.errs.forEach((e) => console.log('      WARN ' + e));
    if (v.badResp && v.badResp.length) v.badResp.forEach((e) => console.log('      WARN risorsa ' + e));
    if (v.failed && v.failed.length) v.failed.forEach((e) => console.log('      WARN failed ' + e));
  }
}
const tot = Object.keys(risultato.desktop).length + (risultato.mobile ? Object.keys(risultato.mobile).length : 0);
console.log(`\nEsito: ${tot - ko}/${tot} OK${ko ? ` — ${ko} KO` : ''}\n`);

if (OUT) { writeFileSync(OUT, JSON.stringify(risultato, null, 1)); console.log('JSON: ' + OUT); }
process.exit(ko ? 1 : 0);
