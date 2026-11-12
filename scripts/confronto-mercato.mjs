#!/usr/bin/env node
/**
 * confronto-mercato.mjs — LO SCONTO REALE CERTIFICATO (aste vs valore di mercato OMI).
 *
 * Perché esiste: `feed/confronto-mercato.json` era ORFANO — lo leggono in sei
 * (dati-indice, numeri-vivi, quadro, comunicato-mensile, mercato-feeds, residenziale-comune)
 * ma nessuno lo scriveva più da quando lo generava uno script del Mac. Ultima rilevazione
 * vera: 31/10/2026. Un numero senza data accanto è un'affermazione falsa.
 *
 * Cosa calcola (la metrica del 31/10, MAI lo scarto base→minima):
 *   sconto            = 1 − (prezzoBase / mq) / valoreOmiComune    (valore = mediana delle zone)
 *   scontoConservativo= 1 − (prezzoBase / mq) / zonaOmiPiuEconomica
 *   nazionale         = MEDIANA degli sconti dei lotti confrontabili, con P25 e P75
 *
 * Regole ferme rispettate:
 *  - si usa SEMPRE il prezzo BASE d'asta, mai l'offerta minima (il 25% è il pavimento legale);
 *  - dove l'mq non è dichiarato nella descrizione il lotto NON entra: mai una superficie stimata;
 *  - dove il comune non ha valori OMI il lotto NON entra: mai un valore inventato;
 *  - se la sorgente OMI non risponde IL FILE NON SI SCRIVE (nessun numero senza fonte);
 *  - i valori OMI grezzi NON finiscono nel file: solo la metrica, la rilevazione e la copertura.
 *
 * Sorgenti: PVP (ricerca vendite, POST body {}, paginata) + KV TRAFFICO del worker
 * `icare-ai`, azione `omi-export` protetta dalla chiave di regia (secret REGIA_KEY).
 * Zero dipendenze: node:fs + fetch (Node 20+).
 */
import fs from 'node:fs';

const WORKER = process.env.WORKER_URL || 'https://icare-ai.misty-mode-1cbc.workers.dev';
const REGIA_KEY = process.env.REGIA_KEY || '';
const OUT = process.env.OUT || 'feed/confronto-mercato.json';
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 50);
const MAX_PAGINE = Number(process.env.MAX_PAGINE || 5000);
const CONCORRENZA = Number(process.env.CONCORRENZA || 5);
const DRY = process.env.DRY === '1';

const MIN_LOTTI_COMUNE = 3;         // sotto 3 lotti il comune non entra (metrica instabile)
const MIN_LOTTI_PUBBLICABILI = 500; // sotto questa soglia il numero non si pubblica
const TOT_PAGINE_MAX_KO = 0.05;     // oltre il 5% di pagine fallite il file non si scrive

const PVP = 'https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite';
const UA = { 'User-Agent': 'CARe-sconto-omi', 'Content-Type': 'application/json' };
const RESID = /^(ABITAZIONE|APPARTAMENTO|VILLA|VILLINO|CASALE|RUSTICO|ALLOGGIO|CASCINA|STALLA|IMMOBILE_RESIDENZIALE)/i;
// quota / nuda proprietà / usufrutto: il prezzo è di una PARTE, la superficie del TUTTO
const ESCLUSI = /NUDA\s+PROPRIET|USUFRUTT|DIRITTO\s+DI\s+ABITAZ|SOLA\s+PROPRIET|IN\s+RAGIONE\s+DI\s+1\s*\/\s*[2-9]|QUOTA\s+(?:DI|PARTE|PARI)|MILLESIM/;
// superficie dichiarata nella descrizione della fonte: solo forme esplicite
const MQ_RE = /(?:MQ|M\.Q\.|MQT|METRI\s+QUADRATI|SUPERFICIE\s+(?:COMMERCIALE\s+|UTILE\s+|LORD[A-Z\s]*|TOTALE\s+)?(?:DI\s+)?(?:CIRCA\s+)?)[\s.:=]*([0-9]{1,4}(?:[.,][0-9]{1,2})?)/gi;

const dormi = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const scaduto = () => (Date.now() - t0) / 60000 > MAX_MINUTES;
const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '');
const r1 = (v) => (v === null || v === undefined || !isFinite(v) ? null : Math.round(v * 10) / 10);
const mediana = (a) => {
  if (!a.length) return null;
  const b = a.slice().sort((x, y) => x - y), m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const percentile = (a, q) => {
  if (!a.length) return null;
  const b = a.slice().sort((x, y) => x - y);
  const pos = (b.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? b[lo] : b[lo] + (b[hi] - b[lo]) * (pos - lo);
};

// ─────────────────────── 1) valori OMI dal KV (worker, chiave di regia) ───────────────────────
async function leggiOmi() {
  if (!REGIA_KEY) throw new Error('REGIA_KEY mancante: senza chiave di regia non si legge l OMI');
  let ultimo = null;
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(WORKER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'CARe-sconto-omi' },
        body: JSON.stringify({ azione: 'omi-export', chiave: REGIA_KEY }),
      });
      if (!r.ok) throw new Error('worker HTTP ' + r.status);
      const d = await r.json();
      if (!d || !Array.isArray(d.comuni) || !d.comuni.length) throw new Error('omi-export vuoto');
      return d;
    } catch (e) {
      ultimo = e;
      console.error('OMI tentativo', k + 1, 'KO:', e.message);
      await dormi(2000 * (k + 1));
    }
  }
  throw ultimo || new Error('OMI non leggibile');
}

// ─────────────────────── 2) lotti dal PVP ───────────────────────
async function pagina(p) {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(`${PVP}?page=${p}&size=100&language=it&sort=dataOraVendita%2Cdesc`, {
        method: 'POST', headers: UA, body: '{}',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).body || {};
    } catch (e) {
      if (k === 3) throw e;
      await dormi(400 * (k + 1));
    }
  }
}

function mqDa(desc) {
  if (!desc) return null;
  MQ_RE.lastIndex = 0;
  let m, scartati = 0;
  while ((m = MQ_RE.exec(desc))) {
    const v = Number(String(m[1]).replace(',', '.'));
    if (isFinite(v) && v >= 20 && v <= 5000) return v;
    if (++scartati > 8) break;
  }
  return null;
}

async function main() {
  // L'OMI si legge PRIMA DI TUTTO: se non risponde si esce senza toccare il file.
  const omi = await leggiOmi();
  const perComune = new Map();   // norm(comune) → { comune, provincia, valore, zonaMin, zone }
  for (const c of omi.comuni) {
    const zone = (c.zone || []).filter((z) => Number(z.compravendita_min) > 0 && Number(z.compravendita_max) >= Number(z.compravendita_min));
    if (!zone.length) continue;
    const medi = zone.map((z) => (Number(z.compravendita_min) + Number(z.compravendita_max)) / 2);
    const k = norm(c.comune);
    if (!k) continue;
    perComune.set(k, {
      comune: c.comune,
      provincia: c.provincia || '',
      valore: mediana(medi),
      zonaMin: Math.min.apply(null, medi),
      zone: zone.length,
    });
  }
  console.log('OMI: comuni', omi.comuni.length, '· con valori', perComune.size, '· semestre', omi.semestre);
  if (perComune.size < 100) throw new Error('copertura OMI troppo bassa (' + perComune.size + ' comuni): il file NON si scrive');

  const primo = await pagina(0);
  const totale = Number(primo.totalElements) || 0;
  const pagine = Math.min(MAX_PAGINE, Math.ceil(totale / 100));
  console.log('PVP: lotti', totale, '· pagine da leggere', pagine);

  const coper = {
    lottiTotale: totale, lottiResidenziali: 0, lottiConMq: 0, lottiSenzaMq: 0,
    lottiEsclusiPerQuota: 0, comuniSenzaOmi: 0, fuoriScala: 0,
  };
  const perComuneLotti = new Map();  // norm(comune) → { comune, provincia, sconti[], scontiCons[], prezziMq[] }
  let letti = 0, pagineKO = 0;

  function assorbi(lst) {
    for (const x of lst) {
      letti++;
      if (String(x.tipoLotto || '').indexOf('IMMOBIL') < 0) continue;
      const cats = (Array.isArray(x.categoriaBene) ? x.categoriaBene : [x.categoriaBene]).filter(Boolean).map(String);
      if (!cats.some((c) => RESID.test(c))) continue;
      coper.lottiResidenziali++;
      const desc = String(x.descLotto || '');
      if (ESCLUSI.test(desc)) { coper.lottiEsclusiPerQuota++; continue; }
      const mq = mqDa(desc);
      if (!mq) { coper.lottiSenzaMq++; continue; }
      const prezzo = Number(x.prezzoBaseAsta) || 0;
      if (!(prezzo > 0)) { coper.lottiSenzaMq++; continue; }
      const ind = x.indirizzo || {};
      const nome = String(ind.citta || '').trim();
      if (!nome) { coper.lottiSenzaMq++; continue; }
      const k = norm(nome);
      const om = perComune.get(k);
      if (!om) { coper.comuniSenzaOmi++; continue; }
      const euMq = prezzo / mq;
      if (!(euMq >= 100 && euMq <= 20000)) { coper.fuoriScala++; continue; }
      const sconto = (1 - euMq / om.valore) * 100;
      const scontoCons = (1 - euMq / om.zonaMin) * 100;
      if (!isFinite(sconto) || !isFinite(scontoCons)) { coper.fuoriScala++; continue; }
      coper.lottiConMq++;
      const g = perComuneLotti.get(k) || { comune: om.comune, provincia: String(ind.provincia || om.provincia || ''), sconti: [], scontiCons: [], prezziMq: [] };
      g.sconti.push(sconto); g.scontiCons.push(scontoCons); g.prezziMq.push(euMq);
      perComuneLotti.set(k, g);
    }
  }

  async function elabora(p) {
    const b = await pagina(p);
    const lst = b.content || [];
    assorbi(lst);
    return lst.length;
  }

  assorbi(primo.content || []);
  let interrotto = false;
  for (let p = 1; p < pagine && !interrotto; p += CONCORRENZA) {
    const gruppo = [];
    for (let i = 0; i < CONCORRENZA && p + i < pagine; i++) gruppo.push(p + i);
    const esiti = await Promise.all(gruppo.map((pp) => elabora(pp).catch(() => { pagineKO++; return 0; })));
    if (esiti.every((n) => n === 0)) break;   // il PVP non ha più lotti
    if (p % 500 < CONCORRENZA) console.log('pagina', p, '· letti', letti, '· residenziali', coper.lottiResidenziali, '· con mq', coper.lottiConMq);
    if (scaduto()) { console.log('tempo massimo raggiunto a pagina', p); interrotto = true; }
  }
  console.log('scansione finita · lotti letti', letti, '· pagine KO', pagineKO);

  // ─────────────────────── 3) aggregazione ───────────────────────
  const comuni = [];
  for (const g of perComuneLotti.values()) {
    if (g.sconti.length < MIN_LOTTI_COMUNE) continue;
    comuni.push({
      comune: g.comune,
      provincia: g.provincia,
      lotti: g.sconti.length,
      prezzoMqMedio: Math.round(mediana(g.prezziMq)),
      scontoMedianoPct: r1(mediana(g.sconti)),
      scontoP25Pct: r1(percentile(g.sconti, 0.25)),
      scontoP75Pct: r1(percentile(g.sconti, 0.75)),
      scontoConservativoPct: r1(mediana(g.scontiCons)),
    });
  }
  comuni.sort((a, b) => b.lotti - a.lotti || String(a.comune).localeCompare(String(b.comune)));

  const scontiPub = [], scontiConsPub = [], prezziPub = [];
  for (const g of perComuneLotti.values()) {
    if (g.sconti.length < MIN_LOTTI_COMUNE) continue;
    scontiPub.push(...g.sconti); scontiConsPub.push(...g.scontiCons); prezziPub.push(...g.prezziMq);
  }
  const nazionale = {
    lotti: scontiPub.length,
    prezzoMqMedio: prezziPub.length ? Math.round(mediana(prezziPub)) : null,
    scontoMedianoPct: r1(mediana(scontiPub)),
    scontoP25Pct: r1(percentile(scontiPub, 0.25)),
    scontoP75Pct: r1(percentile(scontiPub, 0.75)),
    scontoConservativoPct: r1(mediana(scontiConsPub)),
  };

  if (!comuni.length || nazionale.lotti < MIN_LOTTI_PUBBLICABILI) {
    throw new Error('dati insufficienti: ' + nazionale.lotti + ' lotti confrontabili (minimo ' + MIN_LOTTI_PUBBLICABILI + '). Il file NON si scrive.');
  }
  if (pagineKO > pagine * TOT_PAGINE_MAX_KO) {
    throw new Error('scansione incompleta: ' + pagineKO + ' pagine KO su ' + pagine + '. Il file NON si scrive.');
  }

  const rilevazione = new Date().toISOString();
  const copertura = {
    lottiTotale: coper.lottiTotale,
    lottiResidenziali: coper.lottiResidenziali,
    lottiConMq: coper.lottiConMq,
    lottiSenzaMq: coper.lottiSenzaMq,
    lottiEsclusiPerQuota: coper.lottiEsclusiPerQuota,
    comuniSenzaOmi: coper.comuniSenzaOmi,
    fuoriScala: coper.fuoriScala,
    percentualeConMq: coper.lottiResidenziali ? r1((coper.lottiConMq / coper.lottiResidenziali) * 100) : 0,
    comuniPubblicati: comuni.length,
    comuniOmi: perComune.size,
  };

  // l'ordine conta: `rilevazione` va IN CODA, così la veglia la legge con `leggi_coda`
  // (ultimi 8192 byte) senza fare JSON.parse di tutto il feed sul piano Free del worker.
  const out = {
    meta: {
      titolo: 'Lo Sconto Reale Certificato — i prezzi delle aste confrontati con il valore di mercato OMI',
      rilevazione,
      generatoIl: rilevazione,
      cadenza: 'settimanale, lunedì 03:30 (workflow confronto-mercato.yml)',
      semestreOmi: omi.semestre || null,
      fonteValore: 'Agenzia delle Entrate — OMI (Osservatorio del Mercato Immobiliare), KV del worker icare-ai',
      fontePrezzi: 'fonte PVP - Portale delle Vendite Pubbliche Giustizia - Ministero della Giustizia',
      metodo: 'Per ogni lotto residenziale a piena proprietà con la superficie in mq pubblicata nella descrizione della fonte, prezzo al mq = prezzo base / mq, confrontato con i valori OMI residenziali del comune (mediana delle zone). Sconto reale = mediana di 1 - prezzo al mq / valore OMI. scontoConservativoPct confronta con la zona OMI PIÙ ECONOMICA del comune (il confronto più prudente possibile). Esclusi i lotti in quota, nuda proprietà e usufrutto (il prezzo è di una parte, la superficie del tutto). Entrano solo i comuni con almeno 3 lotti confrontabili. Si usa SEMPRE il prezzo base d asta, mai l offerta minima: lo scarto base→minima è il pavimento legale del 25%, non uno sconto di mercato.',
      copertura,
      nota: 'I valori OMI restano interni: pubblichiamo solo la NOSTRA metrica e il prezzo al mq delle aste. Nessun numero inventato; i lotti senza superficie dichiarata non entrano. Se la sorgente OMI non risponde questo file non viene riscritto.',
    },
    nazionale,
    comuni,
    rilevazione,
  };

  const testo = JSON.stringify(out);
  if (DRY) {
    fs.writeFileSync('confronto-mercato.dry.json', testo);
    console.log('DRY (feed non scritto) · nazionale', JSON.stringify(nazionale), '· comuni', comuni.length, '· KB', (testo.length / 1024).toFixed(1));
    return;
  }
  fs.writeFileSync(OUT, testo);
  console.log('scritto', OUT, (testo.length / 1024).toFixed(1), 'KB · nazionale', JSON.stringify(nazionale), '· comuni', comuni.length);
}

main().catch((e) => {
  console.error('FALLITO:', e.message);
  process.exit(1);
});
