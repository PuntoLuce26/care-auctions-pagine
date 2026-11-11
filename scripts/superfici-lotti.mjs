#!/usr/bin/env node
/** superfici-lotti.mjs — il job che unisce i lotti ATTIVI alle superfici delle perizie (OCR).
 *  Obiettivo: calcolare lo SCONTO sulla stessa popolazione della QUOTA (lotti attivi residenziali),
 *  invece di mescolare lotti venduti con lotti in asta.
 *  Sorgenti: PVP (lotti attivi) + feed/perizie-ocr.json (mq estratti dalle perizie, workflow o OCR).
 *  Uscita: feed/superfici-lotti.json (id → mq, comune, zona) + copertura dichiarata.
 *  Regola: dove il mq manca, lo sconto NON si calcola. Mai stimare una superficie. */
import fs from 'node:fs';

const UA = { 'User-Agent': 'CARe-superfici', 'Content-Type': 'application/json' };
const BASE = 'https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite';
const RESID = /^(ABITAZIONE|APPARTAMENTO|VILLA|VILLINO|CASALE|RUSTICO|ALLOGGIO|CASCINA|STALLA|IMMOBILE_RESIDENZIALE)/i;
const oggi = new Date();
const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) superfici note (dalle perizie OCR)
let mqPerId = new Map();
try {
  // in CI il file è nel checkout; sul Mac non c'è → si prende dalla raw del repo
  let testo;
  try { testo = fs.readFileSync('feed/perizie-ocr.json', 'utf8'); }
  catch (_) { testo = await (await fetch('https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/feed/perizie-ocr.json', { headers: { 'User-Agent': 'CARe-superfici' } })).text(); }
  const ocr = JSON.parse(testo);
  for (const r of (Array.isArray(ocr) ? ocr : (ocr.perizie || []))) {
    const id = String(r.id || ''); const mq = Number(r.mq);
    if (id && isFinite(mq) && mq >= 20 && mq <= 5000) mqPerId.set(id, mq);
  }
} catch (e) { console.log('perizie-ocr non leggibile:', e.message); }
console.log('superfici note dalle perizie:', mqPerId.size);

// 2) lotti attivi residenziali
async function pagina(p) {
  const r = await fetch(`${BASE}?page=${p}&size=100&language=it&sort=dataOraVendita%2Cdesc`, { method: 'POST', headers: UA, body: '{}' });
  if (!r.ok) throw new Error('pagina ' + p + ' ' + r.status);
  return (await r.json()).body || {};
}
const primo = await pagina(0);
const tot = primo.totalElements || 0;
console.log('lotti totali PVP:', tot);

const zoneIdx = JSON.parse(fs.readFileSync('feed/omi-zone-centroidi.json', 'utf8'));
const codPerNome = new Map();
for (const [cod, v] of Object.entries(zoneIdx.comuni)) codPerNome.set(String(v.n || '').toUpperCase(), cod);
function zonaPiuVicina(cod, lat, lon) {
  const c = zoneIdx.comuni[cod]; if (!c) return null;
  let best = null, bestD = Infinity; const k = Math.cos((lat * Math.PI) / 180);
  for (const z of c.z) { const [, zona, , , zlon, zlat] = z; if (zlon == null) continue; const d = (zlat - lat) ** 2 + ((zlon - lon) * k) ** 2; if (d < bestD) { bestD = d; best = { linkZona: z[0], zona }; } }
  return best;
}
const confronto = JSON.parse(fs.readFileSync('feed/confronto-aste-mercato.json', 'utf8'));
const interesse = new Set((confronto.comuni || []).map((c) => String(c.comune).toUpperCase()));

const righe = [];
let attiviRes = 0, conMq = 0, letti = 0;
for (let p = 0; p < Math.ceil(tot / 100); p++) {
  const b = p === 0 ? primo : await pagina(p);
  const lst = b.content || []; if (!lst.length) break;
  let vecchi = 0;
  for (const x of lst) {
    letti++;
    const d = String(x.dataVendita || x.dataOraVendita || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (d && new Date(d[1] + '-' + d[2] + '-' + d[3]) < oggi) { vecchi++; continue; }
    if (String(x.tipoLotto || '').indexOf('IMMOBIL') < 0) continue;
    const ind = x.indirizzo || {}; const nome = String(ind.citta || '').toUpperCase();
    if (!interesse.has(nome)) continue;
    const cats = (Array.isArray(x.categoriaBene) ? x.categoriaBene : [x.categoriaBene]).filter(Boolean).map(String);
    if (!cats.some((c) => RESID.test(c))) continue;
    attiviRes++;
    const id = String(x.id || '');
    const mq = mqPerId.get(id);
    const co = ind.coordinate || {}; const la = Number(co.latitudine), lo = Number(co.longitudine);
    const cod = codPerNome.get(nome);
    const z = cod && isFinite(la) && la ? zonaPiuVicina(cod, la, lo) : null;
    const prezzo = Number(x.prezzoBaseAsta) || null;
    if (mq) conMq++;
    righe.push({ id, comune: ind.citta, prov: ind.provincia, mq: mq || null, prezzoBase: prezzo,
      prezzoMq: mq && prezzo ? Math.round(prezzo / mq) : null, zona: z ? z.zona : null, linkZona: z ? z.linkZona : null, tribunale: x.tribunale || null });
  }
  if (vecchi >= 95) break;
}
const feed = {
  meta: {
    titolo: 'Superfici dei lotti attivi (dalle perizie OCR)',
    fonte: 'PVP — Portale delle Vendite Pubbliche (lotti) · perizie PVP (OCR, workflow ocr-perizie)',
    generatoIl: new Date().toISOString(),
    metodo: 'Per ogni lotto attivo residenziale si cerca la superficie già estratta dalle perizie (feed/perizie-ocr.json). prezzoMq = prezzo base ÷ superficie. Dove la superficie manca, prezzoMq resta null: NON si stima.',
    copertura: { lottiAttiviResidenziali: attiviRes, conSuperficie: conMq, senzaSuperficie: attiviRes - conMq, percentuale: attiviRes ? Math.round((conMq / attiviRes) * 1000) / 10 : 0 },
    nota: 'La copertura cresce da sola: il workflow ocr-perizie estrae 800 perizie ogni 30 minuti e questo job le riusa. Quando la copertura sarà alta, lo sconto si calcolerà sulla stessa popolazione della quota e il campo "popolazioni" sparirà da confronto-aste-mercato.json.'
  },
  lotti: righe
};
fs.writeFileSync('feed/superfici-lotti.json', JSON.stringify(feed));
// lista di priorità per il workflow OCR: i lotti attivi residenziali SENZA superficie
const senza = righe.filter((r) => !r.mq).map((r) => r.id);
fs.writeFileSync('feed/ocr-priorita.json', JSON.stringify({ meta: { generatoIl: new Date().toISOString(), motivo: 'lotti attivi residenziali senza superficie: le loro perizie vanno fatte per prime', totale: senza.length }, ids: senza }));
console.log('ocr-priorita.json:', senza.length, 'lotti senza superficie');
const conPm = righe.filter((r) => r.prezzoMq);
console.log(`lotti attivi residenziali: ${attiviRes} · con superficie: ${conMq} (${feed.meta.copertura.percentuale}%) · con prezzo/mq: ${conPm.length}`);
console.log('feed:', (fs.statSync('feed/superfici-lotti.json').size / 1024).toFixed(0), 'KB');
if (conPm.length) console.log('esempi:', conPm.slice(0, 3).map((r) => `${r.comune} ${r.mq}mq → ${r.prezzoMq} €/mq`).join(' · '));
