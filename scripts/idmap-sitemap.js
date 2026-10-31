// idmap-sitemap.js — rigenera dal FEED VIVO (feed/indice.json + file regionali):
//   feed/idmap/idmap-0..6.json      mappa id lotto -> file regionale (shard = id % 7)
//                                   letta da ai-proxy/worker.js:1568 (azione asta-page)
//   feed/citymap/citymap-0..12.json mappa citta -> file regionali (shard = hash(citta) % 13)
//                                   letta da ai-proxy/worker.js:1588 (ricerca per citta)
//   sitemap-aste-{it,en}-N.xml      URL asta-procedura, solo lotti LIVE, 10.000 per file
//   sitemap-aste-index.xml          indice con il numero REALE di shard per lingua
// Cadenza: ogni 15 min dal workflow feed-sync.yml, dopo sync-feed.js.
// Nota: il numero di shard dichiarato in edge/worker.js (/sitemap.xml, "i <= 32")
//       deve essere >= shard reali: oggi 322.806 lotti / 10.000 = 33 file per lingua.
// uso: node scripts/idmap-sitemap.js [--dry]   (--dry = solo conteggi, non scrive)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FEED = path.join(ROOT, 'feed');
const DRY = process.argv.includes('--dry');

const indice = JSON.parse(fs.readFileSync(path.join(FEED, 'indice.json'), 'utf8'));
const live = new Map();      // id -> file
const cityFiles = new Map(); // citta(lower) -> Set(file)
const cityCount = new Map(); // slug citta -> numero lotti
const cityNome = new Map();  // slug citta -> nome leggibile
const provCount = new Map(); // slug provincia -> numero lotti (provincia letta da titolo "(Provincia)" finale)
const provNome = new Map();
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
let nLotti = 0, nFile = 0, nProvTitolo = 0;

for (const meta of Object.values(indice.regioni || {})) {
  for (const f of [...(meta.filesImm || []), ...(meta.filesMob || [])]) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(FEED, f), 'utf8')); } catch (e) { console.error('skip', f, e.message); continue; }
    if (!Array.isArray(arr)) continue;
    nFile++;
    for (const x of arr) {
      if (!x || x.id == null) continue;
      const id = String(x.id);
      if (!live.has(id)) { live.set(id, f); nLotti++; }
      const c = String(x.citta || '').toLowerCase().trim();
      if (c) {
        if (!cityFiles.has(c)) cityFiles.set(c, new Set());
        cityFiles.get(c).add(f);
        const cs = slugify(c);
        if (cs) { cityCount.set(cs, (cityCount.get(cs) || 0) + 1); if (!cityNome.has(cs)) cityNome.set(cs, String(x.citta).trim()); }
      }
      const mp = /\(([^()]+)\)\s*$/.exec(String(x.titolo || ''));
      if (mp && mp[1] && slugify(mp[1])) {
        nProvTitolo++;
        const ps = slugify(mp[1]);
        provCount.set(ps, (provCount.get(ps) || 0) + 1);
        if (!provNome.has(ps)) provNome.set(ps, mp[1].trim());
      }
    }
  }
}
console.log('lotti vivi:', nLotti, 'file letti:', nFile, '| provincia dal titolo:', nProvTitolo);

// sitemap attuali: quanti id, quanti fuori dal feed
const smIds = new Set();
for (const lang of ['it', 'en']) for (let i = 0; i <= 40; i++) {
  const p = path.join(ROOT, 'sitemap-aste-' + lang + '-' + i + '.xml');
  if (!fs.existsSync(p)) continue;
  const txt = fs.readFileSync(p, 'utf8');
  const re = /asta-(\d+)\.html/g; let m;
  while ((m = re.exec(txt))) smIds.add(m[1]);
}
let stale = 0; for (const id of smIds) if (!live.has(id)) stale++;
let manca = 0; for (const id of live.keys()) if (!smIds.has(id)) manca++;
console.log('sitemap: id unici', smIds.size, '| stale (non nel feed)', stale, '| vivi mancanti', manca);
if (DRY) process.exit(0);

// --- idmap 7 shard
const shard = Array.from({ length: 7 }, () => ({}));
for (const [id, f] of live) shard[Number(id) % 7][id] = f;
const idmapDir = path.join(FEED, 'idmap');
fs.mkdirSync(idmapDir, { recursive: true });
let idTot = 0;
shard.forEach((m, n) => { fs.writeFileSync(path.join(idmapDir, 'idmap-' + n + '.json'), JSON.stringify(m)); idTot += Object.keys(m).length; });
console.log('idmap: 7 shard,', idTot, 'id');

// --- citymap 13 shard (chiave = citta minuscola)
const cshard = Array.from({ length: 13 }, () => ({}));
for (const [c, set] of cityFiles) {
  let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  cshard[h % 13][c] = [...set].sort();
}
const cmDir = path.join(FEED, 'citymap');
fs.mkdirSync(cmDir, { recursive: true });
cshard.forEach((m, n) => fs.writeFileSync(path.join(cmDir, 'citymap-' + n + '.json'), JSON.stringify(m)));
console.log('citymap: 13 shard,', cityFiles.size, 'citta');

// --- seo-slugs.json: whitelist + numeri veri per le pagine SEO dinamiche dell'edge
// (edge/worker.js: /case-asta-<slug> = citta, /aste-<slug> = provincia o regione; slug sconosciuto = 404)
const regioni = {};
for (const [r, meta] of Object.entries(indice.regioni || {})) { const s = slugify(r); if (s) regioni[s] = { n: meta.totale || 0, nome: r }; }
const seo = { generato: new Date().toISOString(), citta: {}, province: {}, regioni };
for (const [s, n] of cityCount) seo.citta[s] = { n, nome: cityNome.get(s) };
for (const [s, n] of provCount) seo.province[s] = { n, nome: provNome.get(s) };
fs.writeFileSync(path.join(FEED, 'seo-slugs.json'), JSON.stringify(seo));
console.log('seo-slugs.json:', Object.keys(seo.citta).length, 'citta,', Object.keys(seo.province).length, 'province,', Object.keys(seo.regioni).length, 'regioni');

// --- sitemap 10000 per file
const ids = [...live.keys()].sort((a, b) => Number(a) - Number(b));
const CH = 10000, nCh = Math.max(1, Math.ceil(ids.length / CH));
for (const lang of ['it', 'en']) {
  for (let i = 0; i < Math.max(nCh, 33); i++) {
    const p = path.join(ROOT, 'sitemap-aste-' + lang + '-' + i + '.xml');
    let body;
    if (i < nCh) {
      const part = ids.slice(i * CH, (i + 1) * CH);
      body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        part.map(id => '  <url><loc>https://careauctions.co/asta-procedura/' + lang + '/asta-' + id + '.html</loc></url>').join('\n') + '\n</urlset>\n';
    } else {
      if (!fs.existsSync(p)) continue;
      body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n';
    }
    fs.writeFileSync(p, body);
  }
}
let idx = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
for (const lang of ['it', 'en']) for (let i = 0; i < nCh; i++) idx += '  <sitemap><loc>https://careauctions.co/sitemap-aste-' + lang + '-' + i + '.xml</loc></sitemap>\n';
idx += '</sitemapindex>\n';
fs.writeFileSync(path.join(ROOT, 'sitemap-aste-index.xml'), idx);
console.log('sitemap:', nCh, 'file per lingua,', ids.length, 'URL per lingua');
