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
import { createRequire } from 'node:module';
// 13/11/2026 (figura sweep) — i nomi pubblici delle fonti vivono in un solo posto:
// scripts/feed-regole.js · FONTI_PUBBLICHE (CommonJS, si carica dal modulo ESM).
const { FONTI_PUBBLICHE } = createRequire(import.meta.url)('./feed-regole.js');

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

// ─────────────── 0) GUARDIA ANTI-REGRESSIONE (17/11/2026) ───────────────
// Perché esiste: il 17/11/2026 questo workflow ha pubblicato DUE VOLTE un feed
// PEGGIORE del precedente — 31.767 lotti / 2.117 comuni contro 33.937 / 2.233,
// perché nella KV mancavano i valori OMI di 4 province. Un feed peggiore non deve
// MAI andare live: se il nuovo cala oltre il ricambio fisiologico del catalogo non
// si scrive, e il precedente (già live, quello buono) resta al suo posto.
// Esce con codice 0: non c'è un guasto da riparare, c'è una pubblicazione da evitare.
// Il ricambio vero del 17/11 (run #8) è stato −1 comune (-4 usciti, +3 entrati, tutti
// con 3 lotti, soglia MIN_LOTTI_COMUNE=3): deve passare. La regressione −116 comuni
// e −2.170 lotti deve essere rifiutata.
const GUARDIA = {
  file: process.env.GUARDIA_FILE || 'feed/confronto-mercato-guardia.json',
  url: process.env.GUARDIA_URL || 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/feed/confronto-mercato.json',
  maxCaloLotti: Number(process.env.GUARDIA_MAX_LOTTI || 50),
  maxCaloComuni: Number(process.env.GUARDIA_MAX_COMUNI || 20),
};

function scriviStatoGuardia(stato) {
  try {
    fs.writeFileSync(GUARDIA.file, JSON.stringify(stato));
  } catch (e) {
    // il file di stato è un diario, non una condizione: se non si scrive, non si blocca nulla
    console.error('GUARDIA: stato non scrivibile su', GUARDIA.file, '—', e.message);
  }
}

function cavalcaPrecedente(d, da) {
  const lotti = Number(d && d.nazionale && d.nazionale.lotti);
  const comuni = Array.isArray(d && d.comuni)
    ? d.comuni.length
    : Number(d && d.meta && d.meta.copertura && d.meta.copertura.comuniPubblicati);
  if (Number.isFinite(lotti) && lotti > 0 && Number.isFinite(comuni) && comuni > 0) return { lotti, comuni, da };
  return null;
}

async function leggiPrecedente() {
  // 1) il feed LIVE servito dalla raw: è il "precedente" vero, quello che gli utenti leggono
  try {
    const r = await fetch(GUARDIA.url, { headers: { 'User-Agent': 'CARe-guardia-feed' }, cache: 'no-store' });
    if (r.ok) {
      const p = cavalcaPrecedente(await r.json(), 'raw');
      if (p) return p;
    } else {
      console.error('GUARDIA: raw HTTP', r.status);
    }
  } catch (e) {
    console.error('GUARDIA: raw non leggibile —', e.message);
  }
  // 2) la copia nel checkout (a questo punto della main il file NON è ancora stato riscritto)
  try {
    if (fs.existsSync(OUT)) {
      const p = cavalcaPrecedente(JSON.parse(fs.readFileSync(OUT, 'utf8')), 'checkout');
      if (p) return p;
    }
  } catch (e) {
    console.error('GUARDIA: copia locale non leggibile —', e.message);
  }
  return null;   // non valutabile: si scrive comunque, e lo si dichiara
}

async function guardia(nuovo, anteprima) {
  const quando = new Date().toISOString();
  const precedente = await leggiPrecedente();
  const stato = {
    rifiutato: false,
    guardia: 'valutata',
    motivo: null,
    nuovo: { lotti: nuovo.lotti, comuni: nuovo.comuni },
    precedente: precedente ? { lotti: precedente.lotti, comuni: precedente.comuni } : null,
    soglie: { maxCaloLotti: GUARDIA.maxCaloLotti, maxCaloComuni: GUARDIA.maxCaloComuni },
    fontePrecedente: precedente ? precedente.da : null,
    quando,
  };

  if (!precedente) {
    // Regola ferma: un errore di rete NON blocca la scrittura, ma resta scritto che la guardia non ha giudicato.
    stato.guardia = 'non valutabile';
    stato.motivo = 'feed precedente non leggibile (rete o file assente): si scrive comunque, guardia non valutabile';
    if (!anteprima) scriviStatoGuardia(stato);
    console.log('GUARDIA: non valutabile (precedente non leggibile) — si scrive comunque · nuovo', nuovo.lotti, 'lotti /', nuovo.comuni, 'comuni');
    return { rifiutato: false, stato };
  }

  const caloLotti = precedente.lotti - nuovo.lotti;
  const caloComuni = precedente.comuni - nuovo.comuni;
  const regLotti = nuovo.lotti < precedente.lotti - GUARDIA.maxCaloLotti;
  const regComuni = nuovo.comuni < precedente.comuni - GUARDIA.maxCaloComuni;

  if (regLotti || regComuni) {
    const motivo = 'GUARDIA: regressione rifiutata (lotti ' + nuovo.lotti + ' < ' + precedente.lotti + '-' + GUARDIA.maxCaloLotti
      + ' | comuni ' + nuovo.comuni + ' < ' + precedente.comuni + '-' + GUARDIA.maxCaloComuni + ')';
    stato.rifiutato = true;
    stato.motivo = motivo;
    if (!anteprima) scriviStatoGuardia(stato);
    console.log(motivo);
    console.log('GUARDIA: lotti ' + (caloLotti > 0 ? '−' + caloLotti : '+' + (-caloLotti))
      + ' · comuni ' + (caloComuni > 0 ? '−' + caloComuni : '+' + (-caloComuni))
      + ' · precedente da ' + precedente.da + ' · il feed NON viene scritto');
    return { rifiutato: true, stato };
  }

  if (!anteprima) scriviStatoGuardia(stato);
  console.log('GUARDIA: ok · nuovo', nuovo.lotti, 'lotti /', nuovo.comuni, 'comuni · precedente', precedente.lotti, 'lotti /', precedente.comuni, 'comuni (da ' + precedente.da + ')');
  return { rifiutato: false, stato };
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
      canary: 'care-canary-d2c32afaa5d5',
      canaryNota: 'valore di riconoscimento della copia dei dati (scritto dal generatore, mai patchato nel JSON)',
      titolo: 'Lo Sconto Reale Certificato — i prezzi delle aste confrontati con il valore di mercato OMI',
      rilevazione,
      generatoIl: rilevazione,
      cadenza: 'settimanale, lunedì 03:30 (workflow confronto-mercato.yml)',
      semestreOmi: omi.semestre || null,
      // 13/11/2026 (figura sweep) — la FONTE PUBBLICA, nominata, accanto alla `rilevazione` che c'è già.
      // Un numero senza fonte e data non si pubblica: il sito nasconde ciò che il feed non dichiara.
      fonte: [
        { nome: FONTI_PUBBLICHE.pvp.nome, url: FONTI_PUBBLICHE.pvp.url, ruolo: 'prezzi base d asta dei lotti' },
        { nome: FONTI_PUBBLICHE.omi.nome, url: FONTI_PUBBLICHE.omi.url, ruolo: 'valori di mercato OMI (mediana delle zone del comune)' },
      ],
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

  // ─────── 4) GUARDIA: si pubblica solo un feed non peggiore del precedente ───────
  // Va QUI, subito prima della scrittura: è l'ultimo cancello tra il calcolo e il file.
  const verdetto = await guardia({ lotti: nazionale.lotti, comuni: comuni.length }, DRY);

  const testo = JSON.stringify(out);
  if (DRY) {
    if (verdetto.rifiutato) console.log('DRY (anteprima): la guardia avrebbe RIFIUTATO la scrittura — il feed non sarebbe stato toccato');
    fs.writeFileSync('confronto-mercato.dry.json', testo);
    console.log('DRY (feed non scritto) · nazionale', JSON.stringify(nazionale), '· comuni', comuni.length, '· KB', (testo.length / 1024).toFixed(1));
    return;
  }
  if (verdetto.rifiutato) {
    // Codice 0 deliberato: la run resta verde (nessuna emergenza), il file live non viene toccato.
    console.log('GUARDIA: il file NON è stato scritto — resta live il feed precedente (' + verdetto.stato.precedente.lotti + ' lotti / '
      + verdetto.stato.precedente.comuni + ' comuni). Motivo in ' + GUARDIA.file + '.');
    return;
  }
  fs.writeFileSync(OUT, testo);
  console.log('scritto', OUT, (testo.length / 1024).toFixed(1), 'KB · nazionale', JSON.stringify(nazionale), '· comuni', comuni.length);
}

main().catch((e) => {
  console.error('FALLITO:', e.message);
  process.exit(1);
});
