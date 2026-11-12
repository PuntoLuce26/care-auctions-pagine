#!/usr/bin/env node
/** bing-sync.mjs — Bing Webmaster: leggere E spingere. Non solo IndexNow.
 *  Perché: la chiave API esisteva già in careauctions/.tools/bing-apikey.txt (verificata: sito
 *  careauctions.co approvato). Con questa si vede cosa Bing ha scansionato/indicizzato e si
 *  possono inviare URL nuove direttamente, senza aspettare la rotazione di IndexNow.
 *  Uscita: feed/bing.json · invio: SubmitUrlBatch per le URL passate come argomento.
 *  Uso: node puntoluce/scripts/bing-sync.mjs [--invia url1 url2 ...]
 */
import fs from 'node:fs';

const KEY = fs.readFileSync('careauctions/.tools/bing-apikey.txt', 'utf8').trim();
const SITE = 'https://careauctions.co/';
const S = encodeURIComponent(SITE);
const BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const OUT = 'feed/bing.json';

async function api(nome, extra = '') {
  const r = await fetch(`${BASE}/${nome}?apikey=${KEY}&siteUrl=${S}${extra}`, { headers: { 'User-Agent': 'CARe-bing-sync' } });
  if (!r.ok) throw new Error(nome + ' HTTP ' + r.status);
  const j = await r.json();
  return j.d ?? null;
}
const dataBing = (v) => {
  const m = String(v || '').match(/\/Date\((\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null;
};

const out = { meta: { titolo: 'Bing Webmaster — indicizzazione verificata', fonte: 'Bing Webmaster API', generatoIl: new Date().toISOString(), sito: SITE } };

try {
  const t = (await api('GetRankAndTrafficStats')) || [];
  const ultimi = t.slice(-30);
  out.traffico = {
    giorni: ultimi.length,
    clic: ultimi.reduce((s, x) => s + (x.Clicks || 0), 0),
    impressioni: ultimi.reduce((s, x) => s + (x.Impressions || 0), 0),
    ultimoGiorno: ultimi.length ? dataBing(ultimi[ultimi.length - 1].Date) : null
  };
} catch (e) { out.traffico = { errore: e.message }; }

try {
  const c = (await api('GetCrawlStats')) || [];
  const ultimi = c.slice(-30);
  out.scansione = {
    giorni: ultimi.length,
    pagineScansionate: ultimi.reduce((s, x) => s + (x.CrawledPages || 0), 0),
    errori: ultimi.reduce((s, x) => s + (x.CrawlErrors || 0), 0),
    inCoda: ultimi.length ? (ultimi[ultimi.length - 1].PagesInCrawlQueue ?? null) : null,
    ultimoGiorno: ultimi.length ? dataBing(ultimi[ultimi.length - 1].Date) : null
  };
} catch (e) { out.scansione = { errore: e.message }; }

try {
  const q = (await api('GetQueryStats')) || [];
  out.query = {
    totale: q.length,
    top: q.slice(0, 8).map((x) => ({ query: x.Query, clic: x.Clicks, impressioni: x.Impressions }))
  };
} catch (e) { out.query = { errore: e.message }; }

const DA_CONTROLLARE = ['/', '/buynow/san-pasquale', '/mercato', '/case-in-vendita/santa-teresa-di-gallura', '/en/buynow/san-pasquale'];
out.url = [];
for (const p of DA_CONTROLLARE) {
  try {
    const d = await api('GetUrlInfo', '&url=' + encodeURIComponent('https://careauctions.co' + p));
    out.url.push({ pagina: p, indicizzata: d ? !!(d.IsIndexed ?? d.Indexed) : null, http: d ? d.HttpStatus : null, ultimaScansione: d ? dataBing(d.LastCrawledDate) : null });
  } catch (e) { out.url.push({ pagina: p, errore: e.message.slice(0, 60) }); }
}

// invio diretto di URL nuove (opzionale, da riga di comando)
const i = process.argv.indexOf('--invia');
if (i > 0) {
  const urls = process.argv.slice(i + 1).filter((u) => /^https:\/\/careauctions\.co\//.test(u));
  try {
    const r = await fetch(`${BASE}/SubmitUrlBatch?apikey=${KEY}&siteUrl=${S}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CARe-bing-sync' },
      body: JSON.stringify({ siteUrl: SITE, urlList: urls })
    });
    const j = await r.json().catch(() => ({}));
    out.invio = { richieste: urls.length, http: r.status, risposta: j.d ?? j };
    console.log('invio Bing:', r.status, '· URL:', urls.length);
  } catch (e) { out.invio = { errore: e.message }; }
}

fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('Bing — clic:', out.traffico.clic ?? '?', '· impressioni:', out.traffico.impressioni ?? '?');
console.log('Bing — pagine scansionate:', out.scansione.pagineScansionate ?? '?', '· errori:', out.scansione.errori ?? '?');
for (const u of out.url) console.log('  ', String(u.indicizzata).padEnd(5), u.pagina, '·', u.ultimaScansione || u.errore || '');
console.log('feed:', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');
