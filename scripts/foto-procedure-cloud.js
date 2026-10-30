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
  // 5.877: TUTTI i siti della famiglia astagiudiziaria (le perizie pubbliche degli IVG) — mai portali che vietano il prelievo (5.872)
  const siti = ['https://www.fallcoaste.it/sitemap.xml', 'https://www.astagiudiziaria.com/sitemap.xml', 'https://www.ivgtreviso.it/sitemap.xml', 'https://www.ivgudine.it/sitemap.xml', 'https://www.ivgvicenza.it/sitemap.xml', 'https://www.ivgverona.it/sitemap.xml', 'https://www.ivgbrescia.it/sitemap.xml', 'https://www.ivgbergamo.it/sitemap.xml', 'https://www.ivgcomo.it/sitemap.xml', 'https://www.ivgpadova.it/sitemap.xml', 'https://www.ivgvenezia.it/sitemap.xml'];
  const sitiR = siti.map(s => s.replace('https://www.','https://'));
  const urls = new Set();
  for (const s of sitiR) {
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

// PVP-PERIZIE-5.879: le perizie ufficiali del PVP per ogni lotto (ve-ms + resource-pvp)
async function raccogliPeriziePVP() {
  const FEED2 = path.join(process.cwd(), 'feed');
  const indice = JSON.parse(fs.readFileSync(path.join(FEED2, 'indice.json'), 'utf8'));
  const ids = new Set();
  for (const r of Object.keys(indice.regioni || {})) {
    for (const f of [...(indice.regioni[r].filesImm || []), ...(indice.regioni[r].filesMob || [])]) {
      try { for (const x of JSON.parse(fs.readFileSync(path.join(FEED2, f), 'utf8'))) { if (x && x.id) ids.add(String(x.id)); } } catch (e) {}
    }
  }
  let catalogo = [];
  try { catalogo = JSON.parse(fs.readFileSync(path.join(FEED2, 'foto-procedure.json'), 'utf8')); } catch (e) {}
  const mappa = {}; for (const x of catalogo) mappa[String(x.id)] = x;
  const daFare = [...ids].filter(id => { const c = mappa[id]; return !c || !c.perizia || c.perizia.length === 0; }).slice(0, 120);
  console.log('PVP perizie da raccogliere questo giro:', daFare.length);
  let aggiunte = 0;
  for (let i = 0; i < daFare.length; i += 5) {
    await Promise.all(daFare.slice(i, i + 5).map(async (id) => {
      try {
        const d = await get('https://pvp.giustizia.it/ve-3f723b85-986a1b71/ve-ms/vendite/' + id);
        if (d.s !== 200) return;
        const j = JSON.parse(d.t);
        const allegati = (j.body && j.body.allegati) || [];
        const per = allegati.filter(a => String(a.codiceTipoAllegato || '').match(/PERIZ|FOTO|IMGBE/));
        if (!per.length) return;
        const urls = per.map(a => 'https://resource-pvp.giustizia.it' + (a.linkAllegato || ''));
        const rec = mappa[id] || { id, url: 'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=' + id, foto: [] };
        rec.perizia = urls.slice(0, 3);
        mappa[id] = rec; aggiunte++;
      } catch (e) {}
    }));
    if ((i + 5) % 50 === 0) console.log('perizie:', i + 5, '/', daFare.length, '| con perizia:', aggiunte);
    await new Promise(s => setTimeout(s, 200));
  }
  fs.writeFileSync(path.join(FEED2, 'foto-procedure.json'), JSON.stringify(Object.values(mappa)));
  console.log('FINE perizie PVP: aggiunte', aggiunte, '| catalogo totale', Object.keys(mappa).length);
}
raccogliPeriziePVP();
})();
