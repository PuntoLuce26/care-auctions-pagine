#!/usr/bin/env node
/* CARe — traduzioni automatiche a costo zero (Workers AI m2m100, free tier).
   Fonte: _source-it.json (base app). Target: /i18n/<lang>.json servito dall'edge.
   Traduce SOLO chiavi mancanti + chiavi forzate (lb_body, d_idream) e protegge
   placeholder, brand e HTML con segmentazione: nessun placeholder può sparire. */
const fs = require('fs');
const crypto = require('crypto');
const WORKER = process.env.TRADUTTORE_URL || 'https://icare-ai.misty-mode-1cbc.workers.dev';
const KEY = process.env.REGIA_KEY || '';
const BASE = process.env.TARGET_BASE || 'https://careauctions.co';
const ONLY = String(process.env.ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
const MAX_MS = (Number(process.env.MAX_MINUTES) || 300) * 60000;
const BATCH = Number(process.env.BATCH) || 25;
const FORCED = ['lb_body', 'd_idream'];
const NO_AUTO = ['rl_intl_note', 'rl_intl_line', 'rl_cost_line'];
const RE = /(\{[^{}]+\}|\{\{[^{}]+\}\}|%[sd]|%|\+|−|CAReAuctions|CARe|iCARe|PVP|oCARe|iDati|iCAReWall|iHouse|BuyNow|iShop|CAReIndex|<[^>]+>|https?:\/\/[^\s"']+)/g;
const PROT = /^(\{|\{\{|%[sd]|%|\+|−|CAReAuctions|CARe|iCARe|PVP|oCARe|iDati|iCAReWall|iHouse|BuyNow|iShop|CAReIndex|<|https?:)/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function formula(s) { const ph = (String(s).match(/\{[^}]+\}/g) || []).length; const letters = String(s).replace(/[^A-Za-zÀ-ÿ]/g, '').length; return (ph >= 2 && letters < 24) || /^[\s\d{}%+−/().,]+$/.test(String(s)); }
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function hash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }
function code(l) {
  return { 'zh-CN': 'zh', 'zh-TW': 'zh', 'zh-Hans': 'zh', 'zh-Hant': 'zh', 'pt-PT': 'pt', 'es-419': 'es', 'es-ES': 'es', 'ca-ES': 'ca', 'az-Latn': 'az', 'sr-Latn': 'sr', 'uz-Latn': 'uz', 'fil': 'tl', 'nb': 'no', 'no': 'no', 'en-US': 'en', 'en-GB': 'en', 'he': 'he', 'yi': 'yi' }[l] || l;
}
async function traduci(testi, a) {
  const out = [];
  for (let i = 0; i < testi.length; i += BATCH) {
    const chunk = testi.slice(i, i + BATCH);
    let last = '';
    for (let tenta = 0; tenta < 3; tenta++) {
      try {
        const r = await fetch(WORKER, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CARe-Traduzioni/1.0' }, body: JSON.stringify({ azione: 'traduci', chiave: KEY, testi: chunk, da: 'it', a: code(a) }) });
        const j = await r.json();
        if (j && j.ok && Array.isArray(j.traduzioni)) { out.push(...j.traduzioni); last = ''; break; }
        last = (j && j.errore) || ('HTTP ' + r.status);
      } catch (e) { last = e.message; }
      await sleep(800 * (tenta + 1));
    }
    if (last) return null;
    await sleep(120);
  }
  return out;
}
(async () => {
  if (!KEY) { console.error('REGIA_KEY mancante'); process.exit(2); }
  const srcIt = readJSON('i18n/_source-it.json');
  const srcEn = readJSON('i18n/_source-en.json');
  const state = readJSON('i18n/_stato-traduzioni.json') || { data: null, lingue: {} };
  if (!srcIt || !srcEn) { console.error('source i18n mancanti'); process.exit(2); }
  let langs = fs.readdirSync('i18n').filter(f => /^[A-Za-z-]+\.json$/.test(f) && f !== 'it.json').map(f => f.slice(0, -5)).filter(l => l !== 'it');
  if (ONLY.length) langs = langs.filter(l => ONLY.includes(l));
  console.log('lingue da processare:', langs.length, langs.join(','));
  const t0 = Date.now();
  let fatte = 0;
  for (const lang of langs) {
    if (Date.now() - t0 > MAX_MS) { console.log('tempo esaurito, mi fermo a', lang); break; }
    let target = {};
    if (lang !== 'en') {
      try { const r = await fetch(BASE + '/i18n/' + lang + '.json?ts=' + Date.now()); if (r.ok) target = await r.json(); } catch (e) {}
    }
    if (!target || !Object.keys(target).length) { try { target = JSON.parse(fs.readFileSync('i18n/' + lang + '.json', 'utf8')); } catch (e) {} }
    const src = lang === 'en' ? srcEn : srcIt;
    const st = state.lingue[lang] || (state.lingue[lang] = { forzate: {}, tradotte: 0 });
    const missing = Object.keys(src).filter(k => typeof src[k] === 'string' && target[k] === undefined);
    const forced = FORCED.filter(k => typeof src[k] === 'string' && (!st.forzate || st.forzate[k] !== hash(src[k])));
    const chiavi = [...new Set([...missing, ...forced])];
    if (!chiavi.length) { console.log(lang, 'già completa'); continue; }
    const jobs = [];
    const piani = {};
    const saltate = [];
    for (const k of chiavi) {
      if (NO_AUTO.indexOf(k) >= 0 || formula(src[k])) { target[k] = srcEn[k] || src[k]; saltate.push(k); continue; }
      const parti = String(src[k]).split(RE).filter(Boolean);
      const piano = [];
      for (const parte of parti) {
        if (PROT.test(parte)) piano.push({ prot: true, t: parte });
        else {
          const id = jobs.length; jobs.push({ k, testo: parte });
          piano.push({ prot: false, id, t: parte, lead: /^\s/.test(parte) ? ' ' : '', trail: /\s$/.test(parte) ? ' ' : '' });
        }
      }
      piani[k] = piano;
    }
    const testi = jobs.map(j => j.testo);
    let tradotti = [];
    if (lang !== 'en' && testi.length) {
      const res = await traduci(testi, lang);
      if (!res) { console.log(lang, 'worker non disponibile, salto (riprovo al prossimo giro)'); continue; }
      tradotti = res;
    } else if (lang === 'en') tradotti = testi.slice();
    const perId = {};
    jobs.forEach((j, i) => { perId[i] = (tradotti[i] || '').trim(); });
    let fallite = 0;
    for (const k of chiavi) {
      if (saltate.indexOf(k) >= 0) continue;
      const piano = piani[k];
      let out = piano.map(p => p.prot ? p.t : ((p.lead || '') + String(perId[p.id] || '').trim() + (p.trail || ''))).join('');
      out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,])/g, '$1').replace(/\.{2,}/g, '.');
      if (!out || !out.trim() || (lang !== 'en' && out === src[k])) { out = srcEn[k] || src[k]; fallite++; }
      target[k] = out;
    }
    for (const k of forced) st.forzate[k] = hash(src[k]);
    st.tradotte = (st.tradotte || 0) + chiavi.length;
    st.ultima = new Date().toISOString();
    st.qualita = 'mt:' + (chiavi.length - fallite - saltate.length) + '/fallback:' + fallite + '/formula:' + saltate.length;
    fs.writeFileSync('i18n/' + lang + '.json', JSON.stringify(target, null, 2));
    console.log(lang, 'chiavi', chiavi.length, 'missing', missing.length, 'forzate', forced.length, 'fallback', fallite);
    fatte++;
  }
  state.data = new Date().toISOString();
  state.lingue = state.lingue || {};
  fs.writeFileSync('i18n/_stato-traduzioni.json', JSON.stringify(state, null, 2));
  console.log('fatto', fatte, 'lingue');
})();
