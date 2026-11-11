#!/usr/bin/env node
/** aste-zone.mjs — ogni lotto attivo alla sua zona OMI, e per ogni zona i valori OMI.
 *  Perché: il comune è troppo grosso. A Roma il centro e la periferia sono due mercati.
 *  COSA SI PUÒ FARE OGGI: conteggio dei lotti attivi per zona + prezzo base mediano + valori OMI della zona.
 *  COSA NON SI PUÒ FARE: lo sconto per zona, perché la superficie (mq) dei lotti attivi non è
 *  disponibile nell'API PVP (verificato: né campo dedicato né nel testo). Va dichiarato, non inventato.
 *  Ingresso: feed/omi-zone-centroidi.json (indice zone) + puntoluce/dati/omi/omi-dataset.json (valori)
 *            + API pubblica PVP per i lotti attivi.
 */
import fs from 'node:fs';

const UA = { 'User-Agent': 'CARe-aste-zone', 'Content-Type': 'application/json' };
const BASE = 'https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite';
const RESID = /^(ABITAZIONE|APPARTAMENTO|VILLA|VILLINO|CASALE|RUSTICO|ALLOGGIO|CASCINA|STALLA|IMMOBILE_RESIDENZIALE)/i;
const oggi = new Date();

// comuni che ci interessano: quelli con zone e con lotti nel nostro confronto
const zoneIdx = JSON.parse(fs.readFileSync('feed/omi-zone-centroidi.json', 'utf8'));
const confronto = JSON.parse(fs.readFileSync('feed/confronto-aste-mercato.json', 'utf8'));
const nomiInteresse = new Set((confronto.comuni || []).map((c) => String(c.comune).toUpperCase()));
// inverso: nome comune -> codcom (dall'indice zone)
const codPerNome = new Map();
for (const [cod, v] of Object.entries(zoneIdx.comuni)) codPerNome.set(String(v.n || '').toUpperCase(), cod);

// valori OMI per zona (semestre corrente) dal dataset locale
let omiZone = new Map();   // codcom -> linkZona -> {min,max,mediano,stato}
try {
  const ds = JSON.parse(fs.readFileSync('puntoluce/dati/omi/omi-dataset.json', 'utf8'));
  const sem = Object.keys(ds.meta.semestri || []).length ? ds.meta.semestri[ds.meta.semestri.length - 1] : null;
  for (const [istat, c] of Object.entries(ds.comuni || {})) {
    const s = sem ? c.semestri?.[sem] : null; if (!s) continue;
    const m = new Map();
    for (const [link, z] of Object.entries(s.zone || {})) {
      const vals = Object.entries(z.tipologie || {}).filter(([k]) => ['20', '21', '22', '23'].includes(k)).map(([, v]) => v);
      if (!vals.length) continue;
      const mins = vals.map((v) => v.min), maxs = vals.map((v) => v.max);
      const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
      m.set(link, { min: Math.round(med(mins)), max: Math.round(med(maxs)), stato: vals[0].stato || '' });
    }
    if (m.size) omiZone.set(istat, m);
  }
  console.log('valori OMI per zona: comuni', omiZone.size, '· semestre', sem);
} catch (e) { console.log('dataset OMI non leggibile:', e.message); }

// lotto -> zona: centroide più vicino (distanza euclidea sui gradi, corretta in latitudine)
function zonaPiuVicina(cod, lat, lon) {
  const c = zoneIdx.comuni[cod]; if (!c) return null;
  let best = null, bestD = Infinity;
  const kLat = Math.cos((lat * Math.PI) / 180);
  for (const z of c.z) {
    const [, zona, fascia, micro, zlon, zlat, area] = z;
    if (zlon === null || zlat === null) continue;
    const dLat = (zlat - lat), dLon = (zlon - lon) * kLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = { linkZona: z[0], zona, fascia, micro, area }; }
  }
  return best;
}

const dormi = (ms) => new Promise((r) => setTimeout(r, ms));
async function pagina(p) {
  const r = await fetch(`${BASE}?page=${p}&size=100&language=it&sort=dataOraVendita%2Cdesc`, { method: 'POST', headers: UA, body: '{}' });
  if (!r.ok) throw new Error('pagina ' + p + ' ' + r.status);
  return (await r.json()).body || {};
}

const perZona = new Map();  // "CODCOM|linkZona" -> { codcom, comune, zona, fascia, micro, nLotti, prezzi:[] }
let letti = 0, assegnati = 0, senzaZona = 0;

const primo = await pagina(0);
const tot = primo.totalElements || 0;
console.log('lotti totali PVP:', tot);
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
    if (!nomiInteresse.has(nome)) continue;
    const cod = codPerNome.get(nome); if (!cod) continue;
    const co = ind.coordinate || {};
    const la = Number(co.latitudine), lo = Number(co.longitudine);
    if (!isFinite(la) || !isFinite(lo) || la === 0) continue;
    const z = zonaPiuVicina(cod, la, lo);
    if (!z) { senzaZona++; continue; }
    const cats = (Array.isArray(x.categoriaBene) ? x.categoriaBene : [x.categoriaBene]).filter(Boolean).map(String);
    const res = cats.some((c) => RESID.test(c));
    const prezzo = Number(x.prezzoBaseAsta) || 0;
    const k = cod + '|' + z.linkZona;
    const rec = perZona.get(k) || { codcom: cod, comune: zoneIdx.comuni[cod].n, zona: z.zona, fascia: z.fascia, microzona: z.micro, area_kmq: z.area, linkZona: z.linkZona, nLotti: 0, nResidenziali: 0, prezzi: [] };
    rec.nLotti++; if (res) { rec.nResidenziali++; if (prezzo > 0) rec.prezzi.push(prezzo); }
    perZona.set(k, rec);
    assegnati++;
  }
  if (vecchi >= 95) break;
  if (p % 40 === 0) console.log(' pagine', p, '· letti', letti, '· assegnati', assegnati);
}

const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b.length % 2 ? b[Math.floor(b.length / 2)] : Math.round((b[b.length / 2 - 1] + b[b.length / 2]) / 2); };
const zone = [...perZona.values()].map((r) => {
  const o = omiZone.get(r.codcom)?.get(r.linkZona) || null;
  return {
    comune: r.comune, codcom: r.codcom, zona: r.zona, fascia: r.fascia, microzona: r.microzona, areaKmq: r.area_kmq,
    lottiAttivi: r.nLotti, lottiAttiviResidenziali: r.nResidenziali,
    prezzoBaseMediano: med(r.prezzi),
    omiMinMq: o ? o.min : null, omiMaxMq: o ? o.max : null, omiMedianoMq: o ? Math.round((o.min + o.max) / 2) : null
  };
}).sort((a, b) => (b.lottiAttivi - a.lottiAttivi) || a.comune.localeCompare(b.comune));

const feed = {
  meta: {
    titolo: 'Aste per zona OMI',
    fonte: 'PVP — Portale delle Vendite Pubbliche (lotti attivi) · Agenzia delle Entrate – OMI (valori di zona e perimetri)',
    licenza: 'dati pubblici · CC-BY 4.0 (OMI)',
    generatoIl: new Date().toISOString(),
    metodo: 'Ogni lotto attivo è assegnato alla zona OMI il cui centroide è più vicino (distanza corretta in latitudine). Valori OMI: mediana delle tipologie residenziali della zona nel semestre corrente.',
    nonDisponibile: 'Lo SCONTO per zona richiede la superficie del lotto: l\'API PVP non la espone (verificato anche nel testo della descrizione). Senza mq non si calcola uno sconto per zona: si pubblica il prezzo base mediano e i valori OMI, e lo sconto resta per comune dove esiste.',
    nota_ntn: 'Le compravendite (NTN) esistono solo per comune: nessun tempo di assorbimento per zona. Da decidere quando saranno scaricati tutti gli ZIP.',
    comuni: new Set(zone.map((z) => z.comune)).size, zone: zone.length, letti, assegnati, senzaZona
  },
  zone
};
fs.writeFileSync('feed/aste-zone.json', JSON.stringify(feed));
console.log('zone:', zone.length, '· comuni', feed.meta.comuni, '· letti', letti, '· assegnati', assegnati, '· senza zona', senzaZona);
console.log('feed:', (fs.statSync('feed/aste-zone.json').size / 1024).toFixed(0), 'KB');
console.log('prime 3:', zone.slice(0, 3).map((z) => `${z.comune} ${z.zona} (${z.lottiAttivi} lotti)`).join(' · '));
