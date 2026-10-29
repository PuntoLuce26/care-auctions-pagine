#!/usr/bin/env node
/**
 * ivg-aggiudicazioni.js — Sam 5.1 · raccolta PREZZI DI AGGIUDICAZIONE dal circuito IVG
 * Fonte: astagiudiziaria.com (+ gemelli ivgroma.com, ivgtreviso.it) — HTML statico, niente login.
 * Scoperta: sitemap.xml → /inserzioni/* ; parse di "Stato dell'inserzione: Venduto — Prezzo aggiudicazione: € X".
 * Gentile e ripetibile: salva /tmp/aggiudicazioni-ivg/{id}.json e il totale in /tmp/aggiudicazioni-ivg.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = '/tmp/aggiudicazioni-ivg';
fs.mkdirSync(OUT, { recursive: true });
const TEST = process.argv.includes('--test');
const LIMIT = TEST ? 20 : 99999;

function get(url) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'Accept': 'text/html' } }, (x) => {
      let t = ''; x.on('data', c => { if (t.length < 500000) t += c; });
      x.on('end', () => res({ s: x.statusCode, t }));
    });
    r.on('error', () => res({ s: 0, t: '' }));
    r.setTimeout(20000, () => { r.destroy(); res({ s: 0, t: '' }); });
    r.end();
  });
}

function parse(html, url) {
  const testo = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&euro;|&#8364;/gi, '€').replace(/\s+/g, ' ');
  const id = (url.match(/-(\d+)$/) || [])[1] || '';
  const venduto = /Venduto/i.test(testo);
  let prezzo = null;
  const m = testo.match(/Prezzo\s+aggiudicazione[^€]{0,60}€\s*([\d.,]+)/i) || testo.match(/Prezzo\s+di\s+aggiudicazione[^€]{0,60}€\s*([\d.,]+)/i);
  if (m) prezzo = m[1].replace(/\./g, '').replace(',', '.');
  const titolo = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  return { id, url, venduto, prezzo: prezzo ? Number(prezzo) : null, titolo: titolo.slice(0, 160) };
}

(async () => {
  const sm = await get('https://www.astagiudiziaria.com/sitemap.xml');
  const urls = [...sm.t.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(u => /\/inserzioni\//.test(u));
  console.log('URL inserzioni nel sitemap:', urls.length);
  const fatti = new Set(fs.readdirSync(OUT).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')));
  const coda = urls.filter(u => !fatti.has((u.match(/-(\d+)$/) || [])[1])).slice(0, LIMIT);
  console.log('da processare (questo giro):', coda.length);
  const risultati = [];
  const LAVORATORI = 4;
  let fattiNow = 0;
  async function lavoratore(idW) {
    while (true) {
      const u = coda.shift();
      if (u === undefined) return;
      const r = await get(u);
      const e = r.s === 200 ? parse(r.t, u) : { id: (u.match(/-(\d+)$/) || [])[1], url: u, venduto: false, prezzo: null, stato: r.s };
      fs.writeFileSync(path.join(OUT, e.id + '.json'), JSON.stringify(e));
      risultati.push(e);
      if (e.venduto && e.prezzo) console.log('VENDUTO', e.prezzo, '€ —', e.titolo.slice(0, 60));
      fattiNow++;
      if (fattiNow % 100 === 0) console.log('progresso:', fattiNow, '/', coda.length + fattiNow);
      await new Promise(s => setTimeout(s, 300));
    }
  }
  await Promise.all(Array.from({ length: LAVORATORI }, (_, i) => lavoratore(i)));
  fs.writeFileSync('/tmp/aggiudicazioni-ivg.json', JSON.stringify(risultati));
  const venduti = risultati.filter(r => r.venduto);
  console.log('FINE: processati', risultati.length, '| venduti con prezzo:', venduti.length);
})();
