// 11/11/2026 — A + B: lotti ATTIVI per comune e categoria, e mappa comune→tribunale.
// Serve perché `confronto-mercato.json` conta solo i lotti con superficie (3,8%): la
// "quota aste sul mercato" era sottostimata. Qui si contano TUTTI i lotti immobiliari
// attivi per categoria, e si ricava la mappa comune→tribunale che manca per attribuire
// gli esiti (che il PVP pubblica per tribunale, non per comune).
// Fonte: API pubblica del PVP, stessa di sync-feed.js.
const fs = require('fs');
const https = require('https');

const SIZE = 100;
const RESIDENZIALI = /^(ABITAZIONE|APPARTAMENTO|VILLA|VILLINO|CASALE|RUSTICO|ALLOGGIO|STALLA|CASCINA|IMMOBILE_RESIDENZIALE)/i;
const OUT = { categorie: 'feed/residenziale-comune.json', tribunali: 'feed/comune-tribunale.json' };
const oggi = new Date();

// l'API del PVP vuole POST con body '{}': con GET restituisce totalElements 0
function get1(url) {
  return new Promise((res) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'User-Agent': 'CARe-sync', Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': 2 } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ s: r.statusCode, t: d }));
    });
    req.on('error', () => res({ s: 0, t: '' }));
    req.setTimeout(30000, () => { req.destroy(); res({ s: 0, t: '' }); });
    req.write('{}'); req.end();
  });
}
const dormi = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) { for (let k = 0; k < 4; k++) { const r = await get1(url); if (r && r.s === 200) return r; await dormi(400 * (k + 1)); } return { s: 0, t: '' }; }

const dataDa = (x) => {
  const d = String(x.dataVendita || x.dataOraVendita || '');
  const m = d.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(m[1] + '-' + m[2] + '-' + m[3]) : null;
};

(async () => {
  const base = 'https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite?page=';
  const primo = await get(base + '0&size=' + SIZE + '&language=it&sort=dataOraVendita%2Cdesc');
  let tot = 0;
  try { tot = JSON.parse(primo.t).body.totalElements || 0; } catch (e) {}
  console.log('lotti totali nel PVP:', tot);
  const pagine = Math.ceil(tot / SIZE);

  const perComune = new Map();   // citta|prov -> { residenziali, totImmobiliari, perCat }
  const comuniTrib = new Map();  // citta|prov -> Set(tribunale)
  let lette = 0, fermatoA = null;

  for (let p = 0; p < pagine; p++) {
    const r = await get(base + p + '&size=' + SIZE + '&language=it&sort=dataOraVendita%2Cdesc');
    if (r.s !== 200) { console.log('pagina', p, 'KO'); break; }
    let lst = [];
    try { lst = JSON.parse(r.t).body.content || []; } catch (e) { break; }
    if (!lst.length) break;

    let vecchi = 0;
    for (const x of lst) {
      lette++;
      const d = dataDa(x);
      if (d && d < oggi) { vecchi++; continue; }              // solo aste non ancora svolte
      if (String(x.tipoLotto || '').indexOf('IMMOBIL') < 0) continue;
      const ind = x.indirizzo || {};
      const citta = String(ind.citta || '').trim();
      if (!citta) continue;
      const prov = String(ind.provincia || '').trim();
      const k = citta + '|' + prov;
      const cats = (Array.isArray(x.categoriaBene) ? x.categoriaBene : [x.categoriaBene]).filter(Boolean).map(String);
      const res = cats.some((c) => RESIDENZIALI.test(c));
      const c = perComune.get(k) || { comune: citta, prov, residenziali: 0, totImmobiliari: 0, perCat: {} };
      c.totImmobiliari++;
      if (res) c.residenziali++;
      for (const cat of cats) c.perCat[cat] = (c.perCat[cat] || 0) + 1;
      perComune.set(k, c);
      const tr = String(x.tribunale || '').trim().replace(/^Tribunale di\s*/i, '');
      if (tr) { if (!comuniTrib.has(k)) comuniTrib.set(k, new Set()); comuniTrib.get(k).add(tr); }
    }
    // ordinati per dataOraVendita desc: quando una pagina è quasi tutta passata, si smette
    if (vecchi >= SIZE - 5) { fermatoA = p; break; }
    if (p % 25 === 0) console.log('pagina', p, '· letti', lette, '· comuni', perComune.size);
  }
  console.log('lette', lette, 'righe · fermato alla pagina', fermatoA, '· comuni', perComune.size);

  const comuni = [...perComune.values()].sort((a, b) => b.residenziali - a.residenziali);
  const meta = {
    titolo: 'Lotti immobiliari attivi per comune e categoria',
    fonte: 'PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia), API pubblica',
    generatoIl: new Date().toISOString(),
    nota: 'Solo lotti con asta non ancora svolta. residenziali = categorie ABITAZIONE/APPARTAMENTO/VILLA/…; totImmobiliari = tutti gli immobiliari. Serve a calcolare la quota aste sul mercato senza sottostimarla.',
    letti: lette, comuni: comuni.length
  };
  fs.mkdirSync('feed', { recursive: true });
  fs.writeFileSync(OUT.categorie, JSON.stringify({ meta, comuni }));
  const trib = {}; for (const [k, s] of comuniTrib) trib[k] = [...s];
  fs.writeFileSync(OUT.tribunali, JSON.stringify({ meta: { titolo: 'Mappa comune → tribunale', fonte: 'PVP, dedotta dai lotti', generatoIl: new Date().toISOString(), comuni: Object.keys(trib).length }, comuni: trib }));
  console.log('residenziale-comune.json:', comuni.length, 'comuni ·', (fs.statSync(OUT.categorie).size / 1024).toFixed(0), 'KB');
  console.log('comune-tribunale.json:', Object.keys(trib).length, 'comuni ·', (fs.statSync(OUT.tribunali).size / 1024).toFixed(0), 'KB');
  console.log('primi 3:', comuni.slice(0, 3).map((c) => c.comune + ' ' + c.residenziali).join(' · '));
})().catch((e) => { console.error('ERRORE:', e.message); process.exit(1); });
