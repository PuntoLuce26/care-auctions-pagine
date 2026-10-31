// scripts/statistiche-mercato.js — statistiche di mercato delle aste giudiziarie italiane
// Legge i file regionali del feed (feed/*.json, quelli elencati in feed/indice.json) e scrive
// feed/statistiche-mercato.json: sconti reali per tribunale, desertione, tempi pubblicazione→asta,
// rialzi minimi, lotti per procedura, distribuzione per giorno/ora, mix per categoria, copertura.
//
// REGOLE DI CASA
//  - nessun numero inventato: ogni indicatore dichiara su quanti lotti è calcolato;
//  - se un campo non c'è (o non c'è ancora: i campi nuovi arrivano dal prossimo giro completo),
//    l'indicatore è null e la copertura lo dice a caratteri cubitali — mai uno zero finto;
//  - costo zero: legge solo file locali, nessuna chiamata di rete;
//  - idempotente: si può lanciare quante volte si vuole, l'output dipende solo dal feed.
//
// Uso: node scripts/statistiche-mercato.js
const fs = require('fs');
const path = require('path');

const FEED = path.join(__dirname, '..', 'feed');
const OUT = path.join(FEED, 'statistiche-mercato.json');

const FONTE = 'fonte PVP - Portale delle Vendite Pubbliche Giustizia - Ministero della Giustizia';
const FONTE_URL = 'https://pvp.giustizia.it/pvp/it/ricerca.page';

// ---- utilità statistiche -------------------------------------------------
const somma = a => a.reduce((s, v) => s + v, 0);
const media = a => (a.length ? somma(a) / a.length : null);
const r1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
function mediana(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(a, p) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
const statBase = arr => ({ lotti: arr.length, medio: r1(media(arr)), mediano: r1(mediana(arr)) });
const statRicca = arr => ({ lotti: arr.length, medio: r1(media(arr)), mediano: r1(mediana(arr)), p10: r1(percentile(arr, 10)), p90: r1(percentile(arr, 90)) });
const statPercentili = arr => (arr.length ? statRicca(arr) : { lotti: 0, medio: null, mediano: null, p10: null, p90: null });
// tieni solo i gruppi con abbastanza lotti: sotto la soglia il numero è rumore, non statistica
const MIN_GRUPPO = 5;

// ---- lettura del feed ----------------------------------------------------
const indice = JSON.parse(fs.readFileSync(path.join(FEED, 'indice.json'), 'utf8'));
const fileFeed = [];
for (const r of Object.keys(indice.regioni || {})) {
  for (const f of [...(indice.regioni[r].filesImm || []), ...(indice.regioni[r].filesMob || [])]) fileFeed.push(f);
}

// accumulatori
const copertura = {}; // campo -> quanti lotti lo hanno
let lotti = 0, immobiliari = 0, mobiliari = 0;
let minAsta = null, maxAsta = null;
const scontoNaz = [], scontoTrib = new Map(), // tribunale -> [sconto %]
  tempoNaz = [], tempoTrib = new Map();       // tribunale -> [giorni pubblicazione->asta]
const esitiTrib = new Map(), esitiReg = new Map(), esitiNaz = { aggiudicate: 0, deserte: 0, sospese: 0, altro: 0 };
let esitiDa = null, esitiA = null, esitiLotti = 0;
const rialzoEur = [], rialzoPct = [];
const procCount = new Map(); // procedura -> n. lotti
const giorni = [0, 0, 0, 0, 0, 0, 0]; // domenica..sabato
const ore = new Array(24).fill(0);
let oreTot = 0;
const categorie = new Map(); // categoria primaria -> n. lotti
let catDaTitolo = 0;
let occupati = 0, liberi = 0;

// campi che ci aspettiamo nel feed (i 15 storici + i nuovi di mercato)
const CAMPI = ['id', 'tipo', 'pubblicazione', 'prezzoBase', 'minima', 'dataAsta', 'regione', 'citta',
  'tribunale', 'occupazione', 'cat', 'proc', 'num', 'rialzo', 'disp', 'ora', 'esito', 'lat', 'lon'];

const RE_DATA = /^(19|20)\d\d-\d\d-\d\d$/;
const dataOk = d => RE_DATA.test(d) && d >= '2010-01-01' && d <= '2035-12-31';
const giorniTra = (a, b) => {
  const t1 = Date.parse(a + 'T00:00:00Z'), t2 = Date.parse(b + 'T00:00:00Z');
  if (!isFinite(t1) || !isFinite(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
};
const addAl = (map, k, v) => { let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(v); };

let fileLetti = 0, fileRotti = 0;
for (const f of fileFeed) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(FEED, f), 'utf8')); } catch (e) { fileRotti++; continue; }
  if (!Array.isArray(arr)) { fileRotti++; continue; }
  fileLetti++;
  for (const x of arr) {
    if (!x || x.id == null) continue;
    lotti++;
    for (const c of CAMPI) if (x[c] != null && x[c] !== '') copertura[c] = (copertura[c] || 0) + 1;

    const tipo = x.tipo === 'IMMOBILIARE' ? 'IMMOBILIARE' : 'MOBILIARE';
    if (tipo === 'IMMOBILIARE') immobiliari++; else mobiliari++;

    const trib = String(x.tribunale || '(tribunale non indicato)');
    const reg = String(x.regione || '(regione non indicata)');
    const base = Number(x.prezzoBase) || 0;
    const minima = Number(x.minima) || 0;

    // --- sconto: base vs offerta minima ---
    if (base > 0 && minima > 0 && minima <= base) {
      const sc = (1 - minima / base) * 100;
      scontoNaz.push(sc);
      addAl(scontoTrib, trib, sc);
    }

    // --- date: finestra del feed + tempo pubblicazione→asta ---
    const dAsta = String(x.dataAsta || '').slice(0, 10);
    if (dataOk(dAsta)) {
      if (!minAsta || dAsta < minAsta) minAsta = dAsta;
      if (!maxAsta || dAsta > maxAsta) maxAsta = dAsta;
      giorni[new Date(dAsta + 'T00:00:00Z').getUTCDay()]++;
      const pub = String(x.pubblicazione || '').slice(0, 10);
      if (dataOk(pub)) {
        const g = giorniTra(pub, dAsta);
        if (g != null && g >= 0 && g <= 3650) { tempoNaz.push(g); addAl(tempoTrib, trib, g); }
      }
    }

    // --- esiti (il PVP li pubblica solo per le aste recenti) ---
    const es = String(x.esito || '').toUpperCase();
    if (es) {
      esitiLotti++;
      if (!esitiDa || (dataOk(dAsta) && dAsta < esitiDa)) esitiDa = dataOk(dAsta) ? dAsta : esitiDa;
      if (!esitiA || (dataOk(dAsta) && dAsta > esitiA)) esitiA = dataOk(dAsta) ? dAsta : esitiA;
      let bucket = 'altro';
      if (es === 'AGGIU') { esitiNaz.aggiudicate++; bucket = 'aggiudicate'; }
      else if (es === 'ASDES') { esitiNaz.deserte++; bucket = 'deserte'; }
      else if (es === 'SOSPE') { esitiNaz.sospese++; bucket = 'sospese'; }
      else esitiNaz.altro++;
      for (const [map, k] of [[esitiTrib, trib], [esitiReg, reg]]) {
        let g = map.get(k);
        if (!g) { g = { aste: 0, aggiudicate: 0, deserte: 0, sospese: 0, altro: 0 }; map.set(k, g); }
        g.aste++; g[bucket]++;
      }
    }

    // --- rialzo minimo ---
    if (x.rialzo != null && x.rialzo !== '' && isFinite(Number(x.rialzo))) {
      const rz = Number(x.rialzo);
      rialzoEur.push(rz);
      if (base > 0) rialzoPct.push((rz / base) * 100);
    }

    // --- lotti per procedura ---
    if (x.proc != null && x.proc !== '') {
      const p = String(x.proc);
      procCount.set(p, (procCount.get(p) || 0) + 1);
    }

    // --- ora di vendita ---
    const ora = String(x.ora || '').slice(0, 2);
    if (/^\d\d$/.test(ora)) { ore[Number(ora)]++; oreTot++; }

    // --- categoria: campo nuovo se c'è, altrimenti si ricava dal titolo (che è categoriaBene[0]) ---
    let cat = x.cat ? String(x.cat).split('|')[0].trim() : '';
    if (!cat) {
      const t = String(x.titolo || '');
      const i = t.indexOf(' · ');
      if (i > 0) { cat = t.slice(0, i).trim(); catDaTitolo++; }
    }
    if (cat) categorie.set(cat, (categorie.get(cat) || 0) + 1);

    // --- occupazione ---
    const occ = String(x.occupazione || '');
    if (occ === 'OCCUPATO') occupati++; else if (occ === 'LIBERO') liberi++;
  }
}

// ---- costruzione dell'output --------------------------------------------
const perTribunaleDaArray = (map, fn) => {
  const out = {};
  for (const [k, v] of [...map.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (v.length >= MIN_GRUPPO) out[k] = fn(v);
  }
  return out;
};
const tassi = g => ({
  aste: g.aste, aggiudicate: g.aggiudicate, deserte: g.deserte, sospese: g.sospese, altro: g.altro,
  // denominatore dichiarato: solo le aste CON esito pubblicato e definite (aggiudicate o deserte)
  tassoDesertione: pct(g.deserte, g.aggiudicate + g.deserte),
  tassoAggiudicazione: pct(g.aggiudicate, g.aggiudicate + g.deserte)
});
const perGruppoEsiti = map => {
  const out = {};
  for (const [k, g] of [...map.entries()].sort((a, b) => b[1].aste - a[1].aste)) {
    if (g.aste >= MIN_GRUPPO) out[k] = tassi(g);
  }
  return out;
};
const procArr = [...procCount.values()];
const topCategorie = [...categorie.entries()].sort((a, b) => b[1] - a[1]);
const TOTCAT = topCategorie.reduce((s, [, n]) => s + n, 0);

const nomiGiorni = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const out = {
  meta: {
    generato: new Date().toISOString(),
    fonte: FONTE,
    fonteUrl: FONTE_URL,
    script: 'scripts/statistiche-mercato.js',
    totaleLotti: lotti,
    fileLetti, fileRotti,
    finestraAste: { da: minAsta, a: maxAsta },
    finestraEsiti: { da: esitiDa, a: esitiA, lottiConEsito: esitiLotti },
    copertura: Object.fromEntries(CAMPI.map(c => [c, pct(copertura[c] || 0, lotti)])),
    metodo: {
      sconto: 'sconto % = 1 − (offerta minima / prezzo base d\'asta). Lotti con prezzo base > 0 e minima > 0 e minima ≤ base. Medio e mediano per tribunale; gruppi sotto ' + MIN_GRUPPO + ' lotti esclusi.',
      desertione: 'tasso di desertione = aste deserte / (aste aggiudicate + aste deserte), calcolato SOLO sui lotti in cui il PVP pubblica l\'esito (AGGIU/ASDES/SOSPE). Il PVP pubblica gli esiti solo per le aste recenti: la finestra è dichiarata in meta.finestraEsiti. Le sospese sono contate a parte e non entrano nel denominatore.',
      tempoPubblicazioneAsta: 'giorni tra dataPubblicazione e data vendita. Esclusi i lotti con date mancanti, invertite, oltre 10 anni o con anni implausibili (il PVP contiene refusi tipo 3019 al posto di 2019): restano solo date 2010-2035 e differenze 0-3650 giorni.',
      rialzo: 'rialzo minimo pubblicato dal PVP, in euro e in % sul prezzo base d\'asta.',
      lottiPerProcedura: 'raggruppamento per identificativo di procedura esposto dal PVP (campo proc, non il numero di ruolo del tribunale).',
      mixCategoria: 'categoria bene primaria (primo valore di categoriaBene, campo cat). Per i lotti non ancora arricchiti la categoria è ricavata dal titolo, che è costruito proprio su categoriaBene[0]: la copertura della categoria resta quindi piena, il metodo è dichiarato nel campo categoriaDaTitolo.',
      copertura: 'per ogni campo: quanti lotti hanno un valore non vuoto, in % sul totale. È la misura di quanto possiamo fidarci di ogni indicatore.'
    },
    limiti: [
      'Il feed contiene i lotti pubblicati dal PVP, non le aggiudicazioni: gli esiti sono disponibili solo per la finestra dichiarata, non per tutto lo storico.',
      'Il prezzo di aggiudicazione reale non è in questo file: qui si misura la distanza tra prezzo base e offerta minima, non il prezzo di vendita.',
      'Le coordinate arrivano dalla toponomastica del PVP, non dal catasto: quando mancano il lotto resta senza lat/lon (copertura dichiarata).',
      'I tagli per tribunale/regione sono calcolati sui lotti presenti nel feed in questo momento: regioni con pochi lotti hanno gruppi esclusi (soglia ' + MIN_GRUPPO + ').',
      'Nessun dato è stimato o interpolato: dove il campo manca l\'indicatore è assente, non zero.'
    ]
  },

  lotti: {
    totale: lotti, immobiliari, mobiliari,
    quotaImmobiliare: pct(immobiliari, lotti),
    regioni: Object.keys(indice.regioni || {}).length,
    fileLetti, fileRotti
  },

  sconto: {
    nazionale: statRicca(scontoNaz),
    perTribunale: perTribunaleDaArray(scontoTrib, statBase)
  },

  desertione: {
    finestra: { da: esitiDa, a: esitiA, lottiConEsito: esitiLotti },
    nazionale: esitiLotti ? tassi({ ...esitiNaz, aste: esitiLotti }) : null,
    perTribunale: perGruppoEsiti(esitiTrib),
    perRegione: perGruppoEsiti(esitiReg)
  },

  tempoPubblicazioneAsta: {
    nazionaleGiorni: statRicca(tempoNaz),
    perTribunaleGiorni: perTribunaleDaArray(tempoTrib, statBase)
  },

  rialzo: {
    lottiConRialzo: rialzoEur.length,
    copertura: pct(rialzoEur.length, lotti),
    euro: statBase(rialzoEur),
    pctSuBase: statPercentili(rialzoPct)
  },

  lottiPerProcedura: procArr.length ? {
    procedure: procArr.length,
    lottiConProcedura: somma(procArr),
    mediaLottiPerProcedura: r1(media(procArr)),
    medianaLottiPerProcedura: r1(mediana(procArr)),
    // quante procedure hanno un solo lotto: la misura di quanto il mercato sia frammentato
    quotaProceduraConUnLotto: pct(procArr.filter(n => n === 1).length, procArr.length),
    maxLottiInUnaProcedura: Math.max(...procArr)
  } : { procedure: 0, lottiConProcedura: 0, note: 'campo proc non ancora presente nel feed: arriva col prossimo giro completo' },

  giornoSettimana: {
    lottiConData: somma(giorni),
    giorni: Object.fromEntries(nomiGiorni.map((n, i) => [n, { lotti: giorni[i], quota: pct(giorni[i], somma(giorni)) }]))
  },

  ora: {
    lottiConOrario: oreTot,
    copertura: pct(oreTot, lotti),
    fasce: {
      'mattina (8-12)': somma(ore.slice(8, 13)),
      'pomeriggio (13-17)': somma(ore.slice(13, 18)),
      'sera (18-23)': somma(ore.slice(18, 24)),
      'altro (0-7)': somma(ore.slice(0, 8))
    },
    // solo le ore effettivamente usate, per non gonfiare il file con 24 zeri
    perOra: Object.fromEntries(ore.map((n, h) => [String(h).padStart(2, '0'), n]).filter(([, n]) => n > 0))
  },

  mixCategoria: {
    lottiConCategoria: TOTCAT,
    categoriaDaTitolo: catDaTitolo,
    top: topCategorie.slice(0, 40).map(([c, n]) => ({ categoria: c, lotti: n, quota: pct(n, TOTCAT) })),
    altro: TOTCAT - topCategorie.slice(0, 40).reduce((s, [, n]) => s + n, 0),
    quanteCategorie: topCategorie.length
  },

  occupazione: {
    occupati, liberi,
    quotaOccupati: pct(occupati, occupati + liberi)
  },

  copertura: {
    totaleLotti: lotti,
    campi: Object.fromEntries(CAMPI.map(c => [c, { presenti: copertura[c] || 0, pct: pct(copertura[c] || 0, lotti) }]))
  }
};

fs.writeFileSync(OUT, JSON.stringify(out));
console.log('statistiche-mercato.json scritto:', OUT);
console.log('  lotti:', lotti, '| immobiliari', immobiliari, '| mobiliari', mobiliari);
console.log('  sconto nazionale: medio', out.sconto.nazionale.medio, '% mediano', out.sconto.nazionale.mediano, '%');
console.log('  tempo pubblicazione→asta: mediano', out.tempoPubblicazioneAsta.nazionaleGiorni.mediano, 'giorni');
console.log('  desertione: lotti con esito', esitiLotti, '→ deserte', esitiNaz.deserte, 'aggiudicate', esitiNaz.aggiudicate);
console.log('  rialzo: copertura', out.rialzo.copertura, '%');
console.log('  copertura campi nuovi:', ['cat', 'proc', 'num', 'rialzo', 'disp', 'ora', 'esito', 'lat'].map(c => c + ' ' + (out.copertura.campi[c] ? out.copertura.campi[c].pct : 0) + '%').join(', '));
