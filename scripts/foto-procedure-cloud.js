#!/usr/bin/env node
/**
 * foto-procedure-cloud.js — 5.850: le foto delle procedure in CLOUD (GitHub Actions)
 * Funziona anche a Mac spento: scopre le URL dei lotti dai sitemap IVG, scarica i dettagli,
 * estrae le foto (imgr.astagiudiziaria.com) e le perizie (library) e le FONDE nel feed.
 * Incrementale: riparte dal feed/foto-procedure.json esistente.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const FEED = path.join(process.cwd(), 'feed');
const OUT = path.join(FEED, 'foto-procedure.json');
const MAX_DETTAGLI = 400; // per giro: il runner resta sano

function get(url) {
  return new Promise(res => {
    let u; try { u = new URL(url); } catch (e) { return res({ s: 0, t: '' }); }
    const r = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CAReAuctions/1.0)' } }, x => {
      let t = ''; x.on('data', c => { if (t.length < 3000000) t += c; });
      x.on('end', () => res({ s: x.statusCode, t }));
    });
    r.on('error', () => res({ s: 0, t: '' }));
    r.setTimeout(25000, () => { r.destroy(); res({ s: 0, t: '' }); });
    r.end();
  });
}

(async () => {
  // 1) stato attuale del catalogo
  let esistenti = {};
  try { const j = JSON.parse(fs.readFileSync(OUT, 'utf8')); for (const x of j) esistenti[String(x.id)] = x; } catch (e) {}
  console.log('catalogo attuale:', Object.keys(esistenti).length, 'lotti');

  // 2) le URL dei lotti dai sitemap degli aggregatori (fallcoaste + astagiudiziaria + ivg regionali)
  const siti = ['https://www.fallcoaste.it/sitemap.xml', 'https://www.astagiudiziaria.com/sitemap.xml'];
  const urls = new Set();
  for (const s of siti) {
    try {
      const r = await get(s);
      const uu = [...new Set([...r.t.matchAll(/<loc>([^<]+\/inserzioni\/[^<]+)<\/loc>/g)].map(m => m[1]))];
      for (const u of uu) urls.add(u);
      console.log(s, '→', uu.length, 'URL inserzioni');
    } catch (e) {}
  }
  // sitemap index: se il sitemap è un indice, leggiamo i figli
  if (urls.size < 50) {
    for (const s of siti) {
      const r = await get(s);
      for (const m of r.t.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)) {
        try {
          const rr = await get(m[1]);
          for (const m2 of rr.t.matchAll(/<loc>([^<]+\/inserzioni\/[^<]+)<\/loc>/g)) urls.add(m2[1]);
        } catch (e) {}
      }
    }
  }
  console.log('URL totali:', urls.size);

  // 3) le URL nuove da processare (quelle non ancora nel catalogo)
  const daFare = [...urls].filter(u => !esistenti[String(u.split('/').pop().split('-').pop() || u)]).slice(0, MAX_DETTAGLI);
  console.log('da processare questo giro:', daFare.length);

  // 4) scarica i dettagli + estrai foto e perizie
  const nuovi = [];
  let fatto = 0;
  for (let i = 0; i < daFare.length; i += 6) {
    const batch = daFare.slice(i, i + 6);
    await Promise.all(batch.map(async (u) => {
      const id = String(u.split('/').pop() || 'x');
      const r = await get(u);
      if (r.s !== 200 || !r.t) return;
      let raw = r.t.replace(/\\u002F/g, '/');
      const hits = [...new Set([...raw.matchAll(/imgr\.astagiudiziaria\.com[^"'\s,}]*/gi)].map(m => m[0]))];
      const foto = hits.filter(x => /\.(jpg|jpeg|png|webp)/i.test(x)).map(x => x.startsWith('http') ? x : 'https://' + x);
      const uniche = [...new Map(foto.map(x => [x.split('/').pop(), x])).values()].sort((a, b) => (b.includes('/1024/') ? 1 : 0) - (a.includes('/1024/') ? 1 : 0)).slice(0, 24);
      const perizia = [...new Set([...raw.matchAll(/(?:href|src)="(https:\/\/library\.[^"]+\.pdf[^"]*)"/gi)].map(m => m[1]))].filter(x => !/informativa|privacy|modulo/i.test(x)).slice(0, 3);
      if (uniche.length || perizia.length) { nuovi.push({ id, url: u, foto: uniche, perizia }); esistenti[id] = { id, url: u, foto: uniche, perizia }; }
    }));
    fatto += batch.length;
    if (fatto % 60 === 0) console.log('progresso:', fatto, '/', daFare.length, '| nuovi con foto:', nuovi.length);
    await new Promise(s => setTimeout(s, 300));
  }

  // 5) fondi e salva
  const tutti = Object.values(esistenti);
  fs.writeFileSync(OUT, JSON.stringify(tutti));
  console.log('FINE giro cloud: catalogo totale', tutti.length, 'lotti | nuovi con foto:', nuovi.length);
})();
