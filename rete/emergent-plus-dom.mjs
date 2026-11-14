#!/usr/bin/env node
/** EMERGENT+ DOM — gate sul DOM renderizzato (Playwright). */
const BASE = process.env.BASE || 'https://careauctions.co';
const checks = [];
let browser;
try {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'it-IT' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0, 120)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 120)); });
  await p.goto(BASE + '/?dom=' + Date.now(), { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(500);
  const b4 = p.locator('button[aria-label="Banner 4"]');
  let attivato = false;
  for (let i = 0; i < await b4.count(); i++) { if (await b4.nth(i).isVisible().catch(() => false)) { await b4.nth(i).click(); attivato = true; break; } }
  await p.waitForTimeout(900);
  const cta = p.locator('a').filter({ hasText: /^Vai al negozio$/ }).first();
  checks.push({ nome: 'home: Banner 4 attivabile', ok: attivato });
  checks.push({ nome: 'home: CTA «Vai al negozio» visibile', ok: await cta.isVisible().catch(() => false) });
  checks.push({ nome: 'home: link /buynow visibile', ok: await p.locator('a[href="/buynow"]').first().isVisible().catch(() => false) });
  checks.push({ nome: 'home: nessun errore JS/console', ok: errs.length === 0, errori: errs.slice(0, 3) });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  checks.push({ nome: 'home 1440: nessun overflow orizzontale', ok: !overflow });

  const m = await ctx.newPage();
  await m.setViewportSize({ width: 390, height: 844 });
  await m.goto(BASE + '/?domm=' + Date.now(), { waitUntil: 'networkidle', timeout: 60000 });
  await m.waitForTimeout(600);
  checks.push({ nome: 'home 390: nessun overflow orizzontale', ok: !(await m.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) });

  const i = await ctx.newPage();
  await i.goto(BASE + '/ishop?dom=' + Date.now(), { waitUntil: 'networkidle', timeout: 60000 });
  await i.waitForTimeout(700);
  checks.push({ nome: '/ishop: CTA «Vai al negozio» visibile', ok: await i.locator('a').filter({ hasText: /^Vai al negozio$/ }).first().isVisible().catch(() => false) });

  const b = await ctx.newPage();
  await b.goto(BASE + '/buynow?dom=' + Date.now(), { waitUntil: 'networkidle', timeout: 60000 });
  await b.waitForTimeout(500);
  checks.push({ nome: '/buynow: H1 BuyNow', ok: /^BuyNow/i.test((await b.locator('h1').first().innerText().catch(() => '')) || '') });
  checks.push({ nome: '/buynow: link /buynow visibile', ok: await b.locator('a[href="/buynow"]').first().isVisible().catch(() => false) });

  const s = await ctx.newPage();
  await s.goto(BASE + '/buynow/san-pasquale?dom=' + Date.now(), { waitUntil: 'networkidle', timeout: 60000 });
  await s.waitForTimeout(1200);
  const n = await s.locator('button[aria-label^="Apri la foto"]').count();
  checks.push({ nome: 'San Pasquale: 37 bottoni foto', ok: n === 37, trovati: n });
  const fonte = await s.evaluate(() => (document.body.innerText.match(/Foto: sopralluogo CAReAuctions/g) || []).length);
  checks.push({ nome: 'San Pasquale: una riga fonte', ok: fonte === 1, trovate: fonte });
  await s.locator('button[aria-label^="Apri la foto"]').first().click({ timeout: 8000 }).catch(() => {});
  await s.waitForTimeout(500);
  checks.push({ nome: 'San Pasquale: viewer si apre', ok: await s.locator('#care-gallery-overlay').isVisible().catch(() => false) });
  await s.locator('#care-gallery-close').click().catch(() => {});
} catch (e) {
  checks.push({ nome: 'esecuzione DOM', ok: false, errore: String(e.message || e).slice(0, 160) });
} finally {
  if (browser) await browser.close();
}
const verdetto = checks.every(c => c.ok) ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ gate: 'EMERGENT+ DOM', checks, verdetto }, null, 2));
process.exit(verdetto === 'PASS' ? 0 : 2);
