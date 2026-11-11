#!/usr/bin/env node
/** shell-test.mjs — collaudo della SHELL VUOTA sul URL di prova (?shell=1), con il browser che
 *  poi giudica (Playwright), non con curl e non con Chrome locale.
 *  Misura: HTTP, tempo al primo testo utile (>=80 caratteri), titolo, errori console, richieste fallite.
 *  Esce 1 se una rotta non mostra contenuto entro il tempo massimo. */
import { chromium } from 'playwright';

const BASE = 'https://careauctions.co';
const ROTTE = ['/?shell=1', '/idati?shell=1', '/aggiudicazioni?shell=1', '/osservatorio?shell=1', '/ca-re-index?shell=1'];
const MAX_MS = 20000;
const SOGLIA = 80;

const risultati = [];
const browser = await chromium.launch({ headless: true });
for (const rotta of ROTTE) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'it-IT' });
  const page = await ctx.newPage();
  const consoleErrs = [], failed = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/cdn-cgi/i.test(m.text())) consoleErrs.push(m.text().slice(0, 160)); });
  page.on('requestfailed', (r) => { if (!/cdn-cgi/i.test(r.url())) failed.push(r.url().slice(0, 140)); });
  const t0 = Date.now();
  let http = null, testo = 0, titolo = '', primoTestoMs = null;
  try {
    const resp = await page.goto(BASE + rotta, { waitUntil: 'domcontentloaded', timeout: 45000 });
    http = resp ? resp.status() : null;
    titolo = await page.title();
    while (Date.now() - t0 < MAX_MS) {
      testo = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
      if (testo >= SOGLIA) { primoTestoMs = Date.now() - t0; break; }
      await page.waitForTimeout(250);
    }
  } catch (e) {
    consoleErrs.push('nav: ' + String(e.message).slice(0, 120));
  }
  risultati.push({ rotta, http, titolo, testo, primoTestoMs, consoleErrs: consoleErrs.slice(0, 5), failed: failed.slice(0, 5), ok: testo >= SOGLIA });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(risultati, null, 2));
const ko = risultati.filter((r) => !r.ok);
console.log('ESITO:', ko.length ? 'KO ' + ko.map((r) => r.rotta).join(', ') : 'TUTTE OK', '| tempi:', risultati.map((r) => r.rotta + '=' + (r.primoTestoMs || '-') + 'ms').join(' '));
process.exit(ko.length ? 1 : 0);
