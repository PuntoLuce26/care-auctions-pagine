#!/usr/bin/env node
/** gsc-sync.mjs — Search Console: finalmente il "quanti sono indicizzati" è un numero.
 *  Perché: fino al 12/11 il QUADRO sapeva cosa INVIAVAMO (sitemap, IndexNow) ma non cosa
 *  Google avesse ASSORBITO. Ora legge dalla fonte: sitemaps, search analytics e URL Inspection.
 *  Credenziali: careauctions/.tools/gsc-client.json (client OAuth Desktop) +
 *  ~/care-secrets/gsc-token.json (refresh token con scope webmasters.readonly).
 *  Uscita: feed/gsc.json (sitemap, indicizzate su campione, clic/impressioni, per-URL).
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const CLIENT = 'careauctions/.tools/gsc-client.json';
const TOKEN = path.join(HOME, 'care-secrets/gsc-token.json');
const OUT = 'feed/gsc.json';
const SITE = 'sc-domain:careauctions.co';
const UA = 'CARe-gsc-sync/1.0';

const cred = JSON.parse(fs.readFileSync(CLIENT, 'utf8'));
const c = cred.installed || cred.web || cred;
const tok = JSON.parse(fs.readFileSync(TOKEN, 'utf8'));

const r = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' })
});
const t = await r.json();
if (!t.access_token) { console.error('refresh fallito:', JSON.stringify(t).slice(0, 200)); process.exit(1); }
const H = { Authorization: 'Bearer ' + t.access_token, 'User-Agent': UA };
const S = encodeURIComponent(SITE);

// 1) sitemap
let sitemaps = [];
try {
  const j = await (await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${S}/sitemaps`, { headers: H })).json();
  sitemaps = (j.sitemap || []).map((s) => ({ path: s.path, inviata: s.lastSubmitted || null, letta: s.lastDownloaded || null, errori: s.errors || 0, avvisi: s.warnings || 0, urlDichiarate: ((s.contents || [])[0] || {}).submitted || null }));
} catch (e) { console.error('sitemap:', e.message); }

// 2) analytics ultimi 28 giorni
let analytics = {};
try {
  const oggi = new Date();
  const dal = new Date(oggi.getTime() - 28 * 86400000);
  const j = await (await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${S}/searchAnalytics/query`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: dal.toISOString().slice(0, 10), endDate: oggi.toISOString().slice(0, 10), dimensions: ['page'], rowLimit: 25 })
  })).json();
  const righe = j.rows || [];
  analytics = {
    clic: righe.reduce((s, x) => s + x.clicks, 0),
    impressioni: righe.reduce((s, x) => s + x.impressions, 0),
    pagineConImpressioni: righe.length,
    top: righe.slice(0, 10).map((x) => ({ pagina: x.keys[0], clic: x.clicks, impressioni: x.impressions, posizione: Math.round(x.position * 10) / 10 }))
  };
} catch (e) { console.error('analytics:', e.message); }

// 3) ispezione di un campione: le pagine che contano + quelle della sitemap
const DA_ISPEZIONARE = ['/', '/mercato', '/ishop', '/ca-re-index', '/buynow/san-pasquale', '/idati', '/osservatorio', '/andamento-prezzi', '/quotazioni'];
const ispezioni = [];
for (const p of DA_ISPEZIONARE) {
  try {
    const j = await (await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: 'https://careauctions.co' + p, siteUrl: SITE, languageCode: 'it' })
    })).json();
    const r2 = (j.inspectionResult || {}).indexStatusResult || {};
    ispezioni.push({ pagina: p, verdetto: r2.verdict || 'SCONOSCIUTO', stato: r2.coverageState || '', ultimaScansione: r2.lastCrawlTime || null, canonicalGoogle: r2.googleCanonical || null, canonicalUtente: r2.userCanonical || null });
    await new Promise((res) => setTimeout(res, 250));
  } catch (e) { ispezioni.push({ pagina: p, verdetto: 'ERRORE', stato: e.message.slice(0, 80) }); }
}
const indicizzate = ispezioni.filter((x) => x.verdetto === 'PASS').length;
const sconosciute = ispezioni.filter((x) => /sconosciut/i.test(x.stato)).length;

const feed = {
  meta: {
    titolo: 'Indicizzazione verificata (Google Search Console)',
    fonte: 'Google Search Console API — sitemaps, searchAnalytics, URL Inspection',
    generatoIl: new Date().toISOString(),
    proprieta: SITE,
    metodo: 'Il "indicizzate" non è una stima: è il verdetto della URL Inspection di Google (PASS = indicizzata). Le pagine ispezionate sono un campione dichiarato, non tutto il sito.',
    quota: 'URL Inspection: 2.000 ispezioni/giorno per proprietà. Qui se ne usano poche e fisse.'
  },
  sitemap: sitemaps,
  analytics,
  campione: { ispezionate: ispezioni.length, indicizzate, sconosciute, dettaglio: ispezioni }
};
fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(feed));
console.log('sitemap:', sitemaps.length, '· clic 28gg:', analytics.clic || 0, '· impressioni:', analytics.impressioni || 0);
console.log('ispezionate:', ispezioni.length, '· indicizzate:', indicizzate, '· sconosciute:', sconosciute);
for (const i of ispezioni) console.log('  ', i.verdetto.padEnd(9), i.pagina, '·', (i.stato || '').slice(0, 50));
console.log('feed:', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');
