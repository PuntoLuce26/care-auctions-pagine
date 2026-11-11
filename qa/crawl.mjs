// QA CAReAuctions — crawler con Playwright.
// Simula un utente: apre le pagine, clicca solo elementi sicuri, compila i form senza inviarli,
// controlla immagini, link, errori JavaScript e risposte HTTP. Non compra, non paga, non invia.
import { chromium, firefox, webkit } from 'playwright';
import {
  BASE, ORIGIN, WAIT, NAV_TIMEOUT, LINK_LIMIT, FAST, FAST_ROUTES, ROUTES, SMOKE_ROUTES, MOBILE_ROUTES,
  VIEWPORTS, SAFE_CLICK, DANGER_CLICK, SAFE_FIELD, QA_TEXT, QA_EMAIL, LINK_SKIP, SEO_CHECKS
} from './config.mjs';
import { buildHash, fetchJson, fetchText, makeIssue, sameOrigin, short, ageHours } from './lib.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function launch(browserName) {
  const type = { chromium, firefox, webkit }[browserName];
  if (!type) throw new Error('browser sconosciuto: ' + browserName);
  const opts = { headless: true };
  if (browserName === 'chromium' && process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  return type.launch(opts);
}

function ctxOpts(vp) {
  return {
    viewport: { width: vp.width, height: vp.height },
    userAgent: UA,
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor || 1,
    locale: 'it-IT',
    ignoreHTTPSErrors: false
  };
}

async function safeClick(page, collected) {
  const candidates = await page.$$('button, [role="tab"], [aria-expanded="false"], details > summary');
  let tried = 0;
  for (const el of candidates) {
    if (tried >= 4) break;
    let text = '';
    try { text = ((await el.innerText()) || (await el.getAttribute('aria-label')) || (await el.getAttribute('title')) || '').trim(); } catch (e) {}
    if (!text || text.length > 60) continue;
    if (DANGER_CLICK.test(text)) continue;
    const role = (await el.getAttribute('role')) || '';
    if (!SAFE_CLICK.test(text) && !/tab/.test(role)) continue;
    try {
      if (!(await el.isVisible())) continue;
      if (await el.isDisabled().catch(() => false)) continue;
      const before = page.url();
      await el.click({ timeout: 2500 });
      await page.waitForTimeout(250);
      tried++;
      if (page.url() !== before) break;
    } catch (e) {
      const msg = String(e.message || '');
      if (/Timeout|intercepts pointer events|not visible|not enabled|element is not attached/i.test(msg)) {
        collected.clickSkipped = (collected.clickSkipped || 0) + 1;
      } else {
        collected.clickErrors.push(short(text + ' :: ' + msg, 160));
      }
    }
  }
  return tried;
}

async function fillForms(page, collected) {
  const forms = await page.$$('form');
  collected.forms = { total: forms.length, filled: 0, invalid: [] };
  for (const form of forms.slice(0, 6)) {
    try {
      if (!(await form.isVisible())) continue;
      const fields = await form.$$('input, textarea, select');
      for (const f of fields.slice(0, 14)) {
        const tag = await f.evaluate(el => el.tagName).catch(() => '');
        const type = (await f.getAttribute('type') || '').toLowerCase();
        if (tag === 'SELECT') {
          const n = await f.$$('option');
          if (n.length > 1) { await f.selectOption({ index: 1 }, { timeout: 1500 }).catch(() => {}); collected.forms.filled++; }
        } else if (type === 'checkbox' || type === 'radio' || type === 'file' || type === 'hidden') {
          continue;
        } else if (tag === 'TEXTAREA' || SAFE_FIELD.includes(type)) {
          await f.fill(type === 'email' ? QA_EMAIL : (type === 'date' ? '2026-12-01' : (type === 'number' ? '1' : QA_TEXT)), { timeout: 1500 }).catch(() => {});
          collected.forms.filled++;
        }
      }
      const bad = await form.evaluate(f => ({
        valid: f.checkValidity(),
        invalid: [...f.querySelectorAll(':invalid')].map(e => e.getAttribute('name') || e.id || e.tagName).slice(0, 8)
      })).catch(() => ({ valid: true, invalid: [] }));
      if (bad.invalid.length) collected.forms.invalid.push(...bad.invalid);
    } catch (e) {
      collected.forms.errors = (collected.forms.errors || []).concat(short(e.message, 120));
    }
  }
}

async function crawlOne(browser, route, vp) {
  const ctx = await browser.newContext(ctxOpts(vp));
  const page = await ctx.newPage();
  const errs = [], consoleErrs = [], badResp = [], failed = [], clickErrors = [];
  let http = null, loadMs = null;
  page.on('pageerror', e => errs.push(short(e.message, 200)));
  page.on('console', m => { if (m.type() === 'error' && !/cdn-cgi/i.test(m.text())) consoleErrs.push(short(m.text(), 200)); });
  page.on('response', r => { try { if (r.status() >= 400 && !/cdn-cgi/i.test(r.url())) badResp.push({ status: r.status(), url: r.url() }); } catch (e) {} });
  page.on('requestfailed', r => { if (!/cdn-cgi/i.test(r.url())) failed.push({ url: r.url(), error: (r.failure()?.errorText) || 'failed' }); });

  try {
    const t0 = Date.now();
    const resp = await page.goto(BASE + route.path, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    http = resp ? resp.status() : null;
    await page.waitForTimeout(WAIT);
    loadMs = Date.now() - t0;

    // lazy images: scorri in fondo e torna su
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    const meta = await page.evaluate(() => {
      const root = document.querySelector('#root');
      const imgs = [...document.images].map(i => ({
        src: i.currentSrc || i.src || '',
        ok: !!(i.complete && i.naturalWidth > 0),
        w: i.naturalWidth,
        alt: i.alt || ''
      }));
      return {
        title: document.title || '',
        text: (document.body?.innerText || '').length,
        rootText: root ? (root.innerText || '').length : null,
        h1: [...document.querySelectorAll('h1')].map(h => (h.innerText || '').trim()).filter(Boolean).slice(0, 3),
        canonical: document.querySelector('link[rel="canonical"]')?.href || '',
        robots: document.querySelector('meta[name="robots"]')?.content || '',
        images: { total: imgs.length, broken: imgs.filter(i => !i.ok).slice(0, 20) },
        forms: document.querySelectorAll('form').length,
        buttons: document.querySelectorAll('button').length
      };
    });

    const collected = { forms: { total: meta.forms, filled: 0, invalid: [] }, clickErrors };
    if (!FAST) await fillForms(page, collected);
    const clicked = await safeClick(page, collected);
    const links = await page.$$eval('a[href]', as => [...new Set(as.map(a => a.href))]).catch(() => []);

    return {
      route: route.path, name: route.name, viewport: vp.name, http, loadMs, clicked,
      ...meta, forms: collected.forms, consoleErrors: consoleErrs, pageErrors: errs,
      badResponses: badResp, requestFailed: failed, clickErrors, clickSkipped: collected.clickSkipped || 0,
      links: links.filter(u => sameOrigin(u, BASE)).slice(0, 80)
    };
  } catch (e) {
    return {
      route: route.path, name: route.name, viewport: vp.name, http, loadMs,
      pageErrors: errs, consoleErrors: consoleErrs, badResponses: badResp, requestFailed: failed,
      fatal: short(e.message, 220), links: []
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function smoke(browserName) {
  let browser;
  try { browser = await launch(browserName); } catch (e) { return { browser: browserName, skipped: short(e.message, 120), routes: [] }; }
  const out = { browser: browserName, routes: [] };
  for (const r of SMOKE_ROUTES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, locale: 'it-IT' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(short(e.message, 200)));
    try {
      const resp = await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
      out.routes.push({ route: r, http: resp ? resp.status() : null, text, pageErrors: errs });
    } catch (e) {
      out.routes.push({ route: r, http: null, text: 0, pageErrors: errs.concat([short(e.message, 160)]) });
    } finally { await ctx.close().catch(() => {}); }
  }
  await browser.close().catch(() => {});
  return out;
}

async function checkLinks(links) {
  const uniq = [...new Set(links)].filter(u => !LINK_SKIP.some(s => u.includes(s))).slice(0, LINK_LIMIT);
  const out = [];
  let i = 0;
  async function worker() {
    while (i < uniq.length) {
      const u = uniq[i++];
      try {
        const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA } });
        if (r.status >= 400) out.push({ url: u, status: r.status });
      } catch (e) {
        out.push({ url: u, status: 0, error: short(e.message, 100) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, uniq.length) }, worker));
  return { checked: uniq.length, broken: out };
}

async function checkImageUrls(pages) {
  const urls = [...new Set(pages.flatMap(p => (p.images?.broken || []).map(i => i.src)).filter(Boolean))].slice(0, 40);
  const out = {};
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA } });
        out[u] = r.status;
      } catch (e) { out[u] = 0; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
  return out;
}

async function checkSeo() {
  const out = {};
  const need = async (name, url, fn) => {
    try { const r = await fetchText(url); out[name] = { status: r.status, ...fn(r) }; }
    catch (e) { out[name] = { status: 0, error: short(e.message, 100) }; }
  };
  await need('llms', BASE + SEO_CHECKS.llms, r => ({ ok: r.ok, hasPages: r.text.includes('/novita') && r.text.includes('/buynow/san-pasquale'), hasCite: r.text.includes('Come citare CAReAuctions') }));
  await need('robots', BASE + SEO_CHECKS.robots, r => ({ ok: r.ok, hasAi: /Claude-SearchBot|Perplexity-User|GPTBot/.test(r.text) }));
  await need('sitemap', BASE + SEO_CHECKS.sitemap, r => ({ ok: r.ok, hasNovita: r.text.includes('sitemap-novita.xml'), hasPagine: r.text.includes('sitemap-pagine.xml') }));
  await need('sitemapNovita', BASE + SEO_CHECKS.sitemapNovita, r => {
    const urls = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    const aff = urls.filter(u => /\/affiliazione\/?$/.test(u) || /\/en\/affiliation\/?$/.test(u));
    const okAff = aff.length === 2 && r.text.includes('hreflang="x-default" href="https://careauctions.co/affiliazione"');
    return { ok: r.ok, urls: urls.length, hasAffiliationSelf: okAff };
  });
  await need('sitemapPagine', BASE + SEO_CHECKS.sitemapPagine, r => ({ ok: r.ok, hasBuynow: r.text.includes('/buynow/san-pasquale') }));

  // home umana + home bot
  try {
    const h = await fetchText(BASE + '/?qa=' + Date.now(), { ua: UA });
    out.home = { status: h.status, strip: h.text.includes('care-scopri'), linkNovita: h.text.includes('href="/novita"'), linkAffiliazione: h.text.includes('href="/affiliazione"'), linkBuynow: h.text.includes('href="/buynow/san-pasquale"'), build: buildHash(h.text) };
  } catch (e) { out.home = { status: 0, error: short(e.message, 100) }; }
  try {
    const b = await fetchText(BASE + '/?qa=' + Date.now(), { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    out.botHome = {
      status: b.status,
      links: ['/novita', '/affiliazione', '/buynow/san-pasquale', '/llms.txt'].filter(p => b.text.includes('careauctions.co' + p)),
      build: buildHash(b.text)
    };
  } catch (e) { out.botHome = { status: 0, error: short(e.message, 100) }; }

  try {
    const o = await fetchText(ORIGIN + '/', { ua: UA });
    out.origin = { status: o.status, build: buildHash(o.text) };
  } catch (e) { out.origin = { status: 0, error: short(e.message, 100) }; }
  return out;
}

async function checkFeed() {
  const out = {};
  try {
    const s = await fetchJson(BASE + '/feed/statistiche.json');
    out.statistiche = { status: s.status, aggiornato: s.json?.aggiornato || null, totale: s.json?.totale || null, ageHours: ageHours(s.json?.aggiornato) };
  } catch (e) { out.statistiche = { status: 0, error: short(e.message, 100) }; }
  try {
    const a = await fetchJson(BASE + '/feed/aggiudicazioni.json');
    out.aggiudicazioni = { status: a.status, count: Array.isArray(a.json) ? a.json.length : null };
  } catch (e) { out.aggiudicazioni = { status: 0, error: short(e.message, 100) }; }
  try { const st = await fetchText(BASE + '/stato'); out.stato = { status: st.status, ok: st.status === 200 }; }
  catch (e) { out.stato = { status: 0, error: short(e.message, 100) }; }
  return out;
}

export async function runCrawl() {
  const routes = FAST ? FAST_ROUTES.map(p => ({ path: p, name: p, critical: true })) : ROUTES;
  const browser = await launch('chromium');
  const pages = [];
  const allLinks = [];

  for (const vp of VIEWPORTS) {
    const routesVp = vp.name === 'mobile'
      ? MOBILE_ROUTES.map(p => ({ path: p, name: p, critical: true }))
      : routes;
    for (const route of routesVp) {
      const r = await crawlOne(browser, route, vp);
      pages.push(r);
      allLinks.push(...(r.links || []));
    }
  }
  await browser.close().catch(() => {});

  const links = await checkLinks(allLinks);
  const imgStatus = await checkImageUrls(pages);
  for (const p of pages) {
    const orig = p.images?.broken || [];
    const real = orig.filter(i => { const s = imgStatus[i.src]; return s === 0 || s >= 400; });
    p.images = { ...(p.images || {}), realBroken: real, notLoaded: orig.length - real.length };
  }
  const seo = await checkSeo();
  const feed = await checkFeed();
  const smokeOut = FAST ? [] : [await smoke('firefox'), await smoke('webkit')];

  const issues = [];
  const add = (x) => issues.push(makeIssue(x));

  for (const p of pages) {
    const tag = `${p.viewport} ${p.route}`;
    if (p.fatal) add({ severity: 'critical', type: 'page_fatal', route: p.route, viewport: p.viewport, message: p.fatal });
    if (p.http && p.http >= 500) add({ severity: 'critical', type: 'http_5xx', route: p.route, viewport: p.viewport, message: `HTTP ${p.http}` });
    else if (p.http && p.http >= 400) add({ severity: 'high', type: 'http_4xx', route: p.route, viewport: p.viewport, message: `HTTP ${p.http}` });
    if (!p.http) add({ severity: 'critical', type: 'http_none', route: p.route, viewport: p.viewport, message: 'nessuna risposta HTTP' });
    if ((p.text || 0) < 80) add({ severity: 'critical', type: 'pagina_vuota', route: p.route, viewport: p.viewport, message: `testo ${p.text || 0} caratteri` });
    if (p.pageErrors?.length) add({ severity: 'critical', type: 'pageerror', route: p.route, viewport: p.viewport, message: p.pageErrors[0] });
    if (p.consoleErrors?.length) add({ severity: 'high', type: 'console_error', route: p.route, viewport: p.viewport, message: p.consoleErrors[0] });
    const ownBad = (p.badResponses || []).filter(b => b.status >= 400 && sameOrigin(b.url, BASE) && !/favicon/.test(b.url));
    if (ownBad.length) add({ severity: 'high', type: 'risorsa_4xx', route: p.route, viewport: p.viewport, message: ownBad.slice(0, 3).map(b => b.status + ' ' + b.url).join(' | ') });
    if (p.images?.realBroken?.length) add({ severity: 'high', type: 'immagine_rotta', route: p.route, viewport: p.viewport, message: p.images.realBroken.slice(0, 4).map(i => i.src).join(' | '), suggestion: 'Verificare che i file esistano nel deploy e che il percorso non cambi dopo una pubblicazione.' });
    if (p.forms?.invalid?.length) add({ severity: 'low', type: 'form_invalid', route: p.route, viewport: p.viewport, message: 'campi obbligatori non compilati dal QA (atteso per consenso/date): ' + p.forms.invalid.slice(0, 6).join(', '), suggestion: 'Verificare che il form sia compilabile e che i campi obbligatori abbiano un messaggio chiaro.' });
    if (p.clickErrors?.length) add({ severity: 'high', type: 'click_error', route: p.route, viewport: p.viewport, message: p.clickErrors[0] });
    if (p.loadMs > 9000) add({ severity: 'medium', type: 'lento', route: p.route, viewport: p.viewport, message: `caricamento ${Math.round(p.loadMs / 1000)} s` });
    if (!p.canonical) add({ severity: 'medium', type: 'canonical_mancante', route: p.route, viewport: p.viewport, message: 'link canonical assente' });
  }

  for (const l of links.broken) {
    add({ severity: l.status >= 500 ? 'critical' : 'medium', type: 'link_rotto', route: 'link', viewport: '', message: `${l.status} ${l.url}`, suggestion: 'Correggere il link o aggiungere un redirect 301.' });
  }

  for (const s of smokeOut) {
    if (s.skipped) continue;
    for (const r of s.routes) {
      if (r.http !== 200) add({ severity: 'high', type: 'smoke_http', route: r.route, viewport: s.browser, message: `HTTP ${r.http}` });
      if (r.pageErrors?.length) add({ severity: 'high', type: 'smoke_js', route: r.route, viewport: s.browser, message: r.pageErrors[0] });
      if ((r.text || 0) < 80) add({ severity: 'high', type: 'smoke_vuota', route: r.route, viewport: s.browser, message: `testo ${r.text} caratteri` });
    }
  }

  const seoChecks = [
    ['llms', seo.llms?.ok && seo.llms?.hasPages && seo.llms?.hasCite],
    ['robots', seo.robots?.ok && seo.robots?.hasAi],
    ['sitemap', seo.sitemap?.ok && seo.sitemap?.hasNovita && seo.sitemap?.hasPagine],
    ['sitemapNovita', seo.sitemapNovita?.ok && seo.sitemapNovita?.hasAffiliationSelf],
    ['sitemapPagine', seo.sitemapPagine?.ok && seo.sitemapPagine?.hasBuynow],
    ['home_links', seo.home?.linkNovita && seo.home?.linkAffiliazione && seo.home?.linkBuynow],
    ['bot_links', seo.botHome?.links?.length === 4],
    ['build_allineata', seo.home?.build && seo.origin?.build && seo.home.build === seo.origin.build]
  ];
  for (const [name, ok] of seoChecks) {
    if (!ok) add({ severity: name === 'build_allineata' ? 'critical' : 'high', type: 'seo_' + name, route: 'seo', viewport: '', message: `controllo ${name} fallito` });
  }

  if (!feed.statistiche?.totale) add({ severity: 'critical', type: 'feed_statistiche', route: 'feed', viewport: '', message: 'statistiche.json vuoto o non leggibile' });
  else if ((feed.statistiche.ageHours ?? 0) > 2) add({ severity: 'critical', type: 'feed_fermo', route: 'feed', viewport: '', message: `statistiche ferme da ${feed.statistiche.ageHours} ore` });
  if (!feed.aggiudicazioni?.count) add({ severity: 'high', type: 'feed_aggiudicazioni', route: 'feed', viewport: '', message: 'aggiudicazioni.json vuoto' });

  const summary = { critical: 0, high: 0, medium: 0, low: 0, total: issues.length };
  for (const i of issues) summary[i.severity] = (summary[i.severity] || 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    base: BASE,
    fast: FAST,
    routes: pages,
    smoke: smokeOut,
    links,
    seo,
    feed,
    issues,
    summary
  };
}
