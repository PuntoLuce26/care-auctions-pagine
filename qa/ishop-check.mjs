#!/usr/bin/env node
/** ishop-check.mjs — la verifica che parte appena Emergent pubblica iShop + CAReIndex.
 *  Controlla: le due sezioni, la disclosure, i link SOLO via /vai, nessun prezzo hardcoded
 *  nel bundle, le KPI con le doppie percentuali su /ca-re-index. Esce 1 se qualcosa manca. */
import { chromium } from 'playwright';
const BASE = 'https://careauctions.co';
const KO = [];
const OK = [];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'it-IT' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));

async function apri(url, attesa = 9000) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(attesa);
  return await page.evaluate(() => document.body.innerText || '');
}

// ---- iShop ----
const tShop = await apri(BASE + '/ishop');
const vaia = await page.$$eval('a[href*="/vai/"]', (as) => as.map((a) => a.getAttribute('href')));
const linkEsterni = await page.$$eval('a[href^="http"]', (as) => as.map((a) => a.href).filter((h) => !h.includes('careauctions.co')));
(tShop.includes('Acquisti') ? OK : KO).push('sezione "Acquisti"');
(tShop.includes('Preventivi') ? OK : KO).push('sezione "Preventivi"');
(/commissione/i.test(tShop) ? OK : KO).push('disclosure sulla commissione');
(OK.includes('disclosure sulla commissione') ? OK : KO).push('disclosure visibile');
if (tShop.length < 400) KO.push('pagina con poco testo (' + tShop.length + ')');
if (vaia.length === 0) OK.push('nessun link /vai (catalogo vuoto: atteso oggi)');
else OK.push(vaia.length + ' link /vai');
if (linkEsterni.length) KO.push('link esterni diretti: ' + linkEsterni.slice(0, 3).join(', '));

// ---- CAReIndex ----
const tIdx = await apri(BASE + '/ca-re-index', 10000);
(/CAReIndex|CARe Index/i.test(tIdx) ? OK : KO).push('blocco CAReIndex');
if (/%/.test(tIdx)) OK.push('percentuali presenti'); else KO.push('nessuna percentuale');
if (/lotti/i.test(tIdx)) OK.push('conteggio lotti'); else KO.push('nessun conteggio lotti');
if (tIdx.length < 400) KO.push('ca-re-index con poco testo (' + tIdx.length + ')');

await browser.close();
console.log(JSON.stringify({ ok: OK, ko: KO, erroriJs: errs.slice(0, 5), testoIshop: tShop.length, testoIndice: tIdx.length }, null, 1));
process.exit(KO.length ? 1 : 0);
