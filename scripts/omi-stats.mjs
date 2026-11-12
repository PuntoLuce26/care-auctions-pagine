#!/usr/bin/env node
/** omi-stats.mjs v3 — dalle cache per semestre alle statistiche CAReIndex.
 *  Rispetta la suddivisione OMI: Area territoriale → Regione → Provincia → Comune → Zona.
 *  Ingresso: cartella cache (agg/<AAAA-S>.json). Uscita: feed/omi-*.json. Veloce: niente CSV. */
import fs from 'node:fs';
import path from 'node:path';

const cacheDir = process.argv[2] || 'puntoluce/dati/omi/agg';
const outDir = process.argv[3] || 'feed';
const r1 = (v, d = 0) => v === null || v === undefined || isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const chiave = (s) => Number(s.replace('/', ''));
const pulisciNome = (n) => {
  let t = String(n || '').trim().replace(/`/g, "'").replace(/\s+/g, ' ');
  const bi = t.match(/^(.+?)\s*\.\s*([A-Z].+?)\.?$/);
  if (bi) t = bi[1].trim() + ' / ' + bi[2].trim();
  return t.replace(/\s*\.$/, '');
};


// 12/11/2026 — TOLLERANZA ALLE CACHE MANCANTI. iCloud aveva "evaso" 16 file di agg/
// (0 byte leggibili): JSON.parse esplodeva e tutto il giro si fermava. Ora un file
// illeggibile si SALTA e i semestri mancanti si riprendono dal feed già pubblicato,
// così la storia (45 semestri) non si perde e la base dell'indice resta la stessa.
const fileTutti = fs.readdirSync(cacheDir).filter((f) => /^\d{4}-\d\.json$/.test(f)).sort();
if (!fileTutti.length) { console.error('nessuna cache in', cacheDir); process.exit(1); }
const file = [], dati = [], saltati = [];
for (const f of fileTutti) {
  const pp = path.join(cacheDir, f);
  try {
    // 12/11/2026 — i file EVASI da iCloud hanno blocks = 0 (size normale): leggerli BLOCCA
    // il processo per sempre. Si scartano PRIMA di aprire, con una stat (veloce).
    const st = fs.statSync(pp);
    if (st.size > 0 && st.blocks === 0) { saltati.push(f.replace('.json', '').replace('-', '/')); continue; }
    const t = fs.readFileSync(pp, 'utf8');
    if (!t || t.length < 100) throw new Error('file vuoto');
    dati.push(JSON.parse(t)); file.push(f);
  } catch (e) { saltati.push(f.replace('.json', '').replace('-', '/')); }
}
if (!file.length) { console.error('nessuna cache leggibile in', cacheDir); process.exit(1); }
if (saltati.length) console.error('cache non leggibili (salto, riprendo dal feed):', saltati.join(', '));
const semestri = file.map((f) => f.replace('-', '/').replace('.json', ''));
// 12/11/2026 — GUARDIA: mai un feed con MENO storia di quello che c'è già.
// Era successo: con 44 cache evase da iCloud il giro ha scritto un omi-indice con 1 semestre
// al posto di 45, cancellando la serie storica pubblicata. Ora si ferma e lo dice.
const vecchioIndice = (() => { try { return JSON.parse(fs.readFileSync(path.join(outDir, 'omi-indice.json'), 'utf8')); } catch (e) { return null; } })();
const semestriVecchi = (vecchioIndice && vecchioIndice.nazionale) ? vecchioIndice.nazionale.length : 0;
const MANCA_STORIA = saltati.length > 0 && semestri.length < semestriVecchi;
const FORZA = process.argv.includes('--forza');
if (MANCA_STORIA) {
  console.error('ATTENZIONE: ' + saltati.length + ' cache non leggibili, semestri calcolati ' + semestri.length + ' su ' + semestriVecchi + ' pubblicati.');
  console.error('I semestri mancanti vengono RIPRESI dal feed pubblicato (la storia non si perde).');
}

const ultimo = semestri[semestri.length - 1], penultimo = semestri[semestri.length - 2] || null;

const agg = (comuni, filtro) => { const mins = [], maxs = []; for (const c of Object.values(comuni)) { if (filtro && !filtro(c)) continue; if (c.min != null) { mins.push(c.min); maxs.push(c.max); } } return { righe: mins.length, min: r1(med(mins)), max: r1(med(maxs)), mediano: r1((med(mins) + med(maxs)) / 2) }; };

const naz = dati.map((d, i) => ({ semestre: semestri[i], ...agg(d.comuni) }));
const indice = naz.map((x) => ({ ...x, indice: !naz[0].mediano ? 100 : r1(x.mediano / naz[0].mediano * 100, 1) }));

const chiaviAree = new Set(), chiaviReg = new Set(), chiaviProv = new Set();
for (const d of dati) for (const c of Object.values(d.comuni)) { if (c.area) chiaviAree.add(c.area); if (c.reg) chiaviReg.add(c.reg); if (c.prov) chiaviProv.add(c.prov); }
const aree = {}, regioni = {}, province = {};
for (const a of [...chiaviAree].sort()) aree[a] = dati.map((d, i) => ({ semestre: semestri[i], ...agg(d.comuni, (c) => c.area === a) }));
for (const r of [...chiaviReg].sort()) regioni[r] = dati.map((d, i) => ({ semestre: semestri[i], ...agg(d.comuni, (c) => c.reg === r) }));
for (const p of [...chiaviProv].sort()) province[p] = dati.map((d, i) => ({ semestre: semestri[i], ...agg(d.comuni, (c) => c.prov === p) }));

// 12/11/2026 — MERGE CON LA STORIA PUBBLICATA: per i semestri la cui cache non è
// leggibile (iCloud l'ha in deposito) si riusano i valori del feed già pubblicato.
// Così un giro con poche cache non cancella 45 semestri: li completa.
if (MANCA_STORIA && vecchioIndice) {
  const fondi = (serieNuova, serieVecchia) => {
    const perSem = new Map();
    for (const x of serieNuova) perSem.set(x.semestre, x);
    for (const x of (serieVecchia || [])) if (!perSem.has(x.semestre)) perSem.set(x.semestre, { ...x, ripreso: true });
    return [...perSem.values()].sort((a, b) => chiave(a.semestre) - chiave(b.semestre));
  };
  const nazFusa = fondi(naz, vecchioIndice.nazionale);
  const base = nazFusa.length && nazFusa[0].mediano ? nazFusa[0].mediano : null;
  const ricalcola = (serie) => serie.map((x) => ({ ...x, indice: base && x.mediano ? r1(x.mediano / base * 100, 1) : x.indice }));
  const indiceFuso = ricalcola(nazFusa.map(({ ripreso, ...x }) => x));
  naz.length = 0; indice.length = 0;
  nazFusa.forEach(({ ripreso, ...x }, i) => { naz.push(x); indice.push(indiceFuso[i]); });
  for (const [nome, obj, vecchio] of [['aree', aree, vecchioIndice.aree || {}], ['regioni', regioni, vecchioIndice.regioni || {}], ['province', province, vecchioIndice.province || {}]]) {
    for (const k of Object.keys(obj)) obj[k] = fondi(obj[k], vecchio[k] || []);
    for (const k of Object.keys(vecchio)) if (!obj[k]) obj[k] = vecchio[k];
  }
  console.error('storia ricomposta: ' + naz.length + ' semestri (di cui ' + saltati.length + ' ripresi dal feed)');
}

const ult = dati[dati.length - 1], pen = penultimo ? dati[dati.length - 2] : null;
// volumi di compravendita (liquidità): ultimo anno disponibile, per comune
let vol = null;
try { const rv = fs.readFileSync(path.join(outDir, 'omi-volumi.json'), 'utf8'); vol = JSON.parse(rv); } catch (e) {}
const annoVol = vol && vol.meta.anni.length ? vol.meta.anni[vol.meta.anni.length - 1] : null;
const comuni = [];
for (const [istat, c] of Object.entries(ult.comuni)) {
  const p = pen && pen.comuni[istat];
  comuni.push({
    istat, comune: pulisciNome(c.nome), prov: c.prov, regione: c.reg, area: c.area, zone: c.zone,
    residenziale: { min: r1(c.min), max: r1(c.max), mediano: r1((c.min + c.max) / 2) },
    canoneMq: r1(c.loc, 2),
    renditaLordaPct: c.loc ? r1((c.loc * 12) / ((c.min + c.max) / 2) * 100, 2) : null,
    precedente: p ? { min: r1(p.min), max: r1(p.max) } : null,
    variazionePct: p && p.min ? r1((c.min - p.min) / p.min * 100, 1) : null,
    ntn: (vol && vol.comuni[istat] && vol.comuni[istat].y[annoVol]) ? vol.comuni[istat].y[annoVol][0] : null,
    ntnRes: (vol && vol.comuni[istat] && vol.comuni[istat].y[annoVol]) ? vol.comuni[istat].y[annoVol][1] : null
  });
}
comuni.sort((a, b) => b.zone - a.zone || a.comune.localeCompare(b.comune));

// tipologie (nazionali, per semestre): ricavate ricontando le cache? non ci sono nei cache → si omettono qui
fs.mkdirSync(outDir, { recursive: true });
const meta = {
  titolo: 'CAReIndex — statistiche OMI', fonte: 'Agenzia delle Entrate – OMI (CC-BY 4.0)',
  nota: 'Mediane e indici elaborati da CAReAuctions sui dati semestrali OMI. Suddivisione OMI: area territoriale → regione → provincia → comune → zona (fascia, microzona).',
  metodo: 'Mediana di zona calcolata per comune e poi mediana dei comuni: ogni comune pesa uguale, così una città con cento zone non schiaccia il resto del Paese.',
  semestri, semestreCorrente: ultimo, generatoIl: new Date().toISOString(),
  comuni: comuni.length, annoVolumi: annoVol, aree: Object.keys(aree).length, regioni: Object.keys(regioni).length, province: Object.keys(province).length
};
// 11/11/2026 — per il futuro strato «mappa delle rendite»: per ogni provincia
// la mediana della rendita lorda dei suoi comuni e il NTN dell'ultimo anno.
// 11/11/2026 — per il futuro strato «mappa delle rendite»: rendita mediana e NTN per provincia.
// ATTENZIONE: `province[PROV]` resta un ARRAY (la serie semestrale) perché la pagina lo legge
// così; i dati nuovi vanno in `provinceInfo`, accanto, senza rompere il contratto esistente.
const provinceInfo = {};
for (const [prov, serie] of Object.entries(province)) {
  const lista = comuni.filter((c) => c.prov === prov);
  const rend = lista.map((c) => c.renditaLordaPct).filter((v) => v !== null && !isNaN(v));
  const ntn = lista.reduce((s2, c) => s2 + (c.ntn || 0), 0);
  provinceInfo[prov] = { comuni: lista.length, renditaMedianaPct: rend ? r1(med(rend), 2) : null, ntn: ntn || null };
}
fs.writeFileSync(path.join(outDir, 'omi-indice.json'), JSON.stringify({ meta, nazionale: indice, aree, regioni, province, provinceInfo }));
// 12/11/2026 — se manca la cache dell'ULTIMO semestre, omi-comuni sarebbe costruito su
// dati vecchi spacciati per attuali: non si scrive e si tiene quello pubblicato.
const ultimoVero = (vecchioIndice && vecchioIndice.nazionale && vecchioIndice.nazionale.length) ? vecchioIndice.nazionale[vecchioIndice.nazionale.length - 1].semestre : ultimo;
if (saltati.includes(ultimoVero) || saltati.includes(ultimoVero.replace('/', '-'))) {
  console.error('omi-comuni NON riscritto: manca la cache di ' + ultimo + ' (quella pubblicata resta valida).');
} else {
fs.writeFileSync(path.join(outDir, 'omi-comuni.json'), JSON.stringify({ meta, comuni }));
}
fs.writeFileSync(path.join(outDir, 'omi-stato.json'), JSON.stringify({ meta, allarme: comuni.length ? 'ok' : 'nessun dato' }));
console.log('semestri', semestri.length, '· comuni', comuni.length, '· aree', meta.aree, '· regioni', meta.regioni, '· province', meta.province);
console.log('indice', indice[0].semestre, indice[0].indice, '→', indice[indice.length - 1].semestre, indice[indice.length - 1].indice);
for (const f of ['omi-indice.json', 'omi-comuni.json', 'omi-stato.json']) console.log(' ', f, (fs.statSync(path.join(outDir, f)).size / 1024).toFixed(0), 'KB');
