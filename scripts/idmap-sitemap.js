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
let nLotti = 0, nFile = 0;

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
      if (c) { if (!cityFiles.has(c)) cityFiles.set(c, new Set()); cityFiles.get(c).add(f); }
    }
  }
}
console.log('lotti vivi:', nLotti, 'file letti:', nFile);

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
