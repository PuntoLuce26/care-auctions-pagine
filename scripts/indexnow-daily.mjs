// 5.9 — IndexNow quotidiano: legge la sitemap, ruota 10.000 URL al giorno, invia a IndexNow.
const KEY = 'b2c9e4a7f3d15e6b8a0c4d2f6e8a1c3d';
const BASE = 'https://careauctions.co';
const giorni = Math.floor(Date.now() / 86400000);
async function get(u){ const r = await fetch(u); if(!r.ok) throw new Error(u+' '+r.status); return await r.text(); }
(async () => {
  const idx = await get(BASE + '/sitemap.xml');
  const figli = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  let urls = [];
  for (const f of figli) {
    try { const t = await get(f); const loc = [...t.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]); urls.push(...loc); } catch (e) { console.log('salto', f, e.message); }
  }
  urls = [...new Set(urls)];
  const N = 10000;
  const start = (giorni * N) % Math.max(urls.length, 1);
  const slice = urls.slice(start, start + N).concat(urls.slice(0, Math.max(0, start + N - urls.length)));
  const lotto = slice.slice(0, N);
  console.log('URL totali', urls.length, '| invio', lotto.length, '| da', start);
  const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'careauctions.co', key: KEY, keyLocation: BASE + '/' + KEY + '.txt', urlList: lotto }) });
  console.log('IndexNow', r.status);
  if (!r.ok) process.exit(1);
})();
