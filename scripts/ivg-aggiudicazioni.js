#!/usr/bin/env node
/**
 * ivg-aggiudicazioni.js — Sam 5.1 · raccolta PREZZI DI AGGIUDICAZIONE dal circuito IVG
 * Fonte: astagiudiziaria.com (+ gemelli ivgroma.com, ivgtreviso.it) — HTML statico, niente login.
 * Scoperta: sitemap.xml → /inserzioni/* ; parse di "Stato dell'inserzione: Venduto — Prezzo aggiudicazione: € X".
 * Gentile e ripetibile: salva <AGG_IVG_DIR>/{id}.json e il totale in <AGG_IVG_OUT>.
 *
 * 10/11/2026 (turno posta/allarmi) — tre correzioni dopo che il run delle 20:21Z è
 * rimasto appeso 50+ minuti sul passo AstaGiudiziaria/IVG:
 *  1) la cartella dei risultati è davvero incrementale: il runner GitHub è effimero e
 *     /tmp spariva a ogni giro, quindi ogni run ricrawlava tutte le 7.315 inserzioni.
 *     Ora la cartella si può mettere in cache (actions/cache) e il giro costa pochi
 *     minuti invece di un'ora.
 *  2) budget di tempo (AGG_IVG_BUDGET_MIN, default 20): a budget finito i lavoratori si
 *     fermano e il giro chiude con quello che ha, invece di correre fino al timeout del job.
 *  3) il file di uscita contiene SEMPRE il totale cumulativo (tutte le schede salvate),
 *     non solo quelle nuove di questo giro: con la cache un file "solo nuove" avrebbe
 *     fatto sparire i prezzi dai feed.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = process.env.AGG_IVG_DIR || '/tmp/aggiudicazioni-ivg';
const OUTJSON = process.env.AGG_IVG_OUT || '/tmp/aggiudicazioni-ivg.json';
const BUDGET_MIN = Number(process.env.AGG_IVG_BUDGET_MIN || 20);
fs.mkdirSync(OUT, { recursive: true });
const TEST = process.argv.includes('--test');
const LIMIT = TEST ? 20 : 99999;
const FINE = Date.now() + BUDGET_MIN * 60000;

function get(url) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'Accept': 'text/html' }, timeout: 20000 }, (x) => {
      let t = ''; x.on('data', c => { if (t.length < 500000) t += c; });
      x.on('end', () => res({ s: x.statusCode, t }));
    });
    r.on('error', () => res({ s: 0, t: '' }));
    r.on('timeout', () => { r.destroy(); res({ s: 0, t: '' }); });
    r.end();
  });
}

function parse(html, url) {
  const testo = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&euro;|&#8364;/gi, '€').replace(/\s+/g, ' ');
  const id = (url.match(/-(\d+)$/) || [])[1] || '';
  const venduto = /Stato\s+dell\u0027?inserzione[^.]{0,50}Venduto/i.test(testo) || /Stato[^.:]{0,30}:\s*Venduto/i.test(testo);
  let prezzo = null;
  const m = testo.match(/Prezzo\s+aggiudicazione[^€]{0,60}€\s*([\d.,]+)/i) || testo.match(/Prezzo\s+di\s+aggiudicazione[^€]{0,60}€\s*([\d.,]+)/i);
  if (m) prezzo = m[1].replace(/\./g, '').replace(',', '.');
  const titolo = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  return { id, url, venduto, prezzo: prezzo ? Number(prezzo) : null, titolo: titolo.slice(0, 160) };
}

function leggiCache() {
  const out = [];
  for (const f of fs.readdirSync(OUT)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'))); } catch (e) { /* file rotto: si riproverà */ }
  }
  return out;
}

(async () => {
  const sm = await get('https://www.astagiudiziaria.com/sitemap.xml');
  const urls = [...sm.t.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(u => /\/inserzioni\//.test(u));
  console.log('URL inserzioni nel sitemap:', urls.length);
  const fatti = new Set(fs.readdirSync(OUT).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')));
  console.log('gia in cache (cartella persistente):', fatti.size);
  const coda = urls.filter(u => !fatti.has((u.match(/-(\d+)$/) || [])[1])).slice(0, LIMIT);
  console.log('da processare (questo giro):', coda.length, '| budget', BUDGET_MIN, 'min');
  const totale = coda.length;
  let fattiNow = 0;
  let scaduto = false;
  async function lavoratore(idW) {
    while (true) {
      if (Date.now() > FINE) { scaduto = true; return; }
      const u = coda.shift();
      if (u === undefined) return;
      const r = await get(u);
      const e = r.s === 200 ? parse(r.t, u) : { id: (u.match(/-(\d+)$/) || [])[1], url: u, venduto: false, prezzo: null, stato: r.s };
      fs.writeFileSync(path.join(OUT, e.id + '.json'), JSON.stringify(e));
      fattiNow++;
      if (e.venduto && e.prezzo) console.log('VENDUTO', e.prezzo, '€ —', e.titolo.slice(0, 60));
      if (fattiNow % 100 === 0) console.log('progresso:', fattiNow, '/', totale);
      await new Promise(s => setTimeout(s, 300));
    }
  }
  await Promise.all(Array.from({ length: 4 }, (_, i) => lavoratore(i)));
  const risultati = leggiCache();
  fs.writeFileSync(OUTJSON, JSON.stringify(risultati));
  const venduti = risultati.filter(r => r.venduto);
  console.log('FINE: processati in questo giro', fattiNow, '| cumulativo in cache', risultati.length, '| venduti con prezzo:', venduti.length, scaduto ? '| BUDGET ESAURITO (giro chiuso, si continua al prossimo)' : '');
})().catch(e => { console.log('ERR', e && e.message); process.exit(0); });
