#!/usr/bin/env node
/**
 * esiti-stato.mjs — IL FILE DI STATO DEL GIRO `esiti-sync` (13/11/2026)
 * ---------------------------------------------------------------------------
 * PERCHÉ ESISTE (misurato, non ipotizzato)
 * `feed/aggiudicazioni.json` è un array nudo di 3,8 MB SENZA campo di tempo: se i prezzi non
 * cambiano, il file è identico e non c'è commit. Per un sorvegliante «nessuna variazione» e
 * «non è girato» sono LO STESSO SEGNALE (età del commit). Il 12/11 il workflow è finito verde
 * col log «nessuna variazione» e il feed è sembrato fermo per 24 ore.
 * Questo file si scrive a OGNI giro, anche quando non c'è niente di nuovo, e dichiara:
 *   · `ultimoGiro` — QUANDO il giro è stato fatto (la prova che il processo è vivo);
 *   · `esito`      — COSA ha trovato («niente di nuovo» ≠ «non gira»);
 *   · `record`     — quanti record ha il feed;
 *   · `fonte`      — DA DOVE vengono davvero quei record (una fonte falsa è peggio di una
 *                    fonte assente: `esiti-monitor.json` si dichiarava «PVP» mentre il suo
 *                    generatore include solo i record `fonte:"fallcoaste"`).
 *
 * REGOLA (ferma, dal caso del 13/11): `ultimoGiro` AVANZA SOLO SE IL GIRO HA CONSEGNATO.
 * Se la normalizzazione o il push falliscono, il file si riscrive comunque (con `esito:
 * "errore-…"` e la nota che dice cosa è successo) ma `ultimoGiro` resta quello precedente:
 * così il sorvegliante continua a vedere il processo FERMO e lo ripara. Uno stato «fresco»
 * sopra un giro rosso sarebbe la stessa bugia che questo file esiste per togliere.
 *
 * USO
 *   node scripts/esiti-stato.mjs                      # scrive feed/esiti-stato.json
 *   node scripts/esiti-stato.mjs --precedente /tmp/esiti-stato-precedente.json
 *   node scripts/esiti-stato.mjs --inizio 2026-11-13T10:00:00Z --consegna fallita
 *   ESITO_NORMALIZZA / ESITO_COMMIT             (in alternativa a --consegna)
 *
 * ZERO DIPENDENZE: solo `node:fs` e `node:crypto`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FEED = path.join(process.cwd(), 'feed');
const OUT_DEFAULT = path.join(FEED, 'esiti-stato.json');

/** Nomi PUBBLICI delle fonti dell'archivio. La chiave è il campo `fonte` dei record. */
const FONTI_NOTE = {
  fallcoaste: { nome: 'FallcoAste — fallcoaste.it', url: 'https://www.fallcoaste.it' },
  'notarile-verona': { nome: 'Notarile Verona (aste notarili)', url: null },
  ivg: { nome: 'AstaGiudiziaria / IVG', url: 'https://www.astagiudiziaria.com' },
  anivg: { nome: 'ANIVG — Associazione Nazionale Istituti Vendite Giudiziarie', url: null },
  pvp: { nome: 'PVP — Portale delle Vendite Pubbliche', url: 'https://pvp.giustizia.it' },
};

const leggi = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return d;
  }
};

function argomenti(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith('--')) {
      a._.push(v);
      continue;
    }
    a[v.slice(2)] = argv[++i];
  }
  return a;
}

const a = argomenti(process.argv.slice(2));
const out = a.out ? path.resolve(a.out) : OUT_DEFAULT;
const inizio = a.inizio || process.env.ESITI_INIZIO || null;

// ── 0. la consegna: il giro ha portato a casa il risultato? ────────────────────────────
// Un passo `skipped` non è un fallimento (nel workflow il commit non si salta mai, ma se un
// giorno lo facesse non vogliamo dichiarare rosso un giro che ha scritto i derivati).
const esitoNom = String(a.normalizza || process.env.ESITO_NORMALIZZA || '').trim();
const esitoCommit = String(a.commit || process.env.ESITO_COMMIT || '').trim();
let consegna;
if (a.consegna) consegna = String(a.consegna) === 'ok' ? 'ok' : 'fallita';
else if (esitoNom || esitoCommit) {
  const okNom = esitoNom === '' || esitoNom === 'success';
  const okCommit = esitoCommit === 'success' || esitoCommit === 'skipped';
  consegna = okNom && okCommit ? 'ok' : 'fallita';
} else consegna = 'ok';

// ── 1. l'archivio: quanti record, di quali fonti, con quale impronta ──────────────────
const archivio = leggi(path.join(FEED, 'aggiudicazioni.json'), null);
let record = null;
let impronta = null;
let byte = null;
let fontiArchivio = [];
let letturaArchivio = 'ok';
try {
  if (!Array.isArray(archivio)) {
    letturaArchivio = archivio === null ? 'archivio assente o non JSON' : 'archivio non è un array';
  } else {
    record = archivio.length;
    const perFonte = new Map();
    for (const x of archivio) {
      const k = String((x && x.fonte) || '?');
      perFonte.set(k, (perFonte.get(k) || 0) + 1);
    }
    fontiArchivio = [...perFonte.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([k, n]) => Object.assign({ chiave: k, nome: k, url: null, record: n }, FONTI_NOTE[k] || { nome: k + ' (fonte non dichiarata)' }));
    const buf = fs.readFileSync(path.join(FEED, 'aggiudicazioni.json'));
    byte = buf.length;
    impronta = crypto.createHash('sha256').update(buf).digest('hex');
  }
} catch (e) {
  letturaArchivio = 'lettura fallita: ' + String((e && e.message) || e).slice(0, 120);
}

// ── 2. i derivati: gli esiti (prezzi di aggiudicazione) e il monitor ──────────────────
const stat = leggi(path.join(FEED, 'esiti-statistiche.json'), null);
const monitor = leggi(path.join(FEED, 'esiti-monitor.json'), null);

// `esiti-statistiche.json` dal 13/11 porta `fonte` come ARRAY (nome+url+quota) e `fonteTesto`
// come stringa. Si accettano entrambe le forme: un lettore non deve rompersi per una forma nuova.
function testoFonti(v, alt) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v)) {
    const s = v
      .map((f) => (f && f.nome ? String(f.nome) + (Number.isFinite(Number(f.esiti)) ? ' (' + f.esiti + ')' : '') : ''))
      .filter(Boolean)
      .join(' · ');
    if (s) return s;
  }
  return alt || null;
}

const awards = Number(stat && (stat.tutti != null ? stat.tutti : stat.copertura && stat.copertura.esiti)) || null;
const immobiliari = Number(stat && stat.copertura && stat.copertura.esiti) || null;
const copertura = {
  dal: (stat && stat.copertura && stat.copertura.dal) || (monitor && monitor.copertura && monitor.copertura.dal) || null,
  al: (stat && stat.copertura && stat.copertura.al) || (monitor && monitor.copertura && monitor.copertura.al) || null,
};
const fonteEsiti = stat ? testoFonti(stat.fonteTesto || stat.fonte, null) : null;
const rilevazioneEsiti = (stat && (stat.rilevazione || stat.generato)) || null;

// ── 3. cosa hanno raccolto i collettori in QUESTO giro (i file /tmp del job) ──────────
const raccolti = { fallcoaste: null, ivg: null, totale: null };
try {
  const f = leggi('/tmp/aggiudicazioni-fallco.json', null);
  const i = leggi('/tmp/aggiudicazioni-ivg.json', null);
  const conta = (j) => (Array.isArray(j) ? j.length : Array.isArray(j && j.voci) ? j.voci.length : null);
  raccolti.fallcoaste = conta(f);
  raccolti.ivg = conta(i);
  const noti = [raccolti.fallcoaste, raccolti.ivg].filter((n) => n !== null);
  raccolti.totale = noti.length ? noti.reduce((s, n) => s + n, 0) : null;
} catch (e) {
  /* i collettori non hanno lasciato file: resta null, che è «non so», non zero */
}

// ── 4. il giro precedente: serve per dire «nuovi record» invece di indovinarlo ───────
const precedente = a.precedente ? leggi(a.precedente, null) : null;
const recordPrima = precedente && Number.isFinite(Number(precedente.record)) ? Number(precedente.record) : null;
const recordNuovi = record != null && recordPrima != null ? record - recordPrima : null;
const ultimoGiroPrima = precedente && typeof precedente.ultimoGiro === 'string' ? precedente.ultimoGiro : null;

// ── 5. l'esito: la frase che distingue «niente di nuovo» da «non gira» ───────────────
let esito;
let nota;
if (consegna === 'fallita') {
  esito = esitoNom && esitoNom !== 'success' ? 'errore-giro' : 'errore-consegna';
  nota =
    esito === 'errore-giro'
      ? 'la normalizzazione o una raccolta è fallita: il giro NON ha consegnato, ultimoGiro non avanza'
      : 'raccolta e normalizzazione ok, ma il commit/push non è riuscito: il giro NON ha consegnato, ultimoGiro non avanza';
} else if (record == null) {
  esito = 'errore-archivio';
  nota = 'aggiudicazioni.json non leggibile (' + letturaArchivio + '): ultimoGiro non avanza';
} else if (recordNuovi != null && recordNuovi > 0) {
  esito = 'nuovi-record';
  nota = 'girato: l\'archivio è cresciuto di ' + recordNuovi + ' record rispetto al giro precedente';
} else if (recordNuovi != null && recordNuovi < 0) {
  esito = 'archivio-accorciato';
  nota = 'ATTENZIONE: l\'archivio ha ' + Math.abs(recordNuovi) + ' record in MENO del giro precedente';
} else if (raccolti.totale === 0) {
  esito = 'collezione-vuota';
  nota = 'girato, ma i collettori non hanno restituito nemmeno un record: da guardare (non è «niente di nuovo»)';
} else if (recordNuovi === 0) {
  esito = 'nessuna-variazione';
  nota = 'girato: niente di nuovo — l\'archivio è identico al giro precedente (non è un guasto)';
} else {
  esito = 'giro-eseguito';
  nota = 'girato: nessun giro precedente con cui confrontare i record, quindi non si dichiara né «nuovo» né «identico»';
}

const ora = new Date().toISOString();
const avanza = esito !== 'errore-giro' && esito !== 'errore-consegna' && esito !== 'errore-archivio';
const ultimoGiro = avanza ? ora : ultimoGiroPrima || ora;

const durataMin = inizio && Number.isFinite(Date.parse(inizio)) ? Math.max(0, Math.round((Date.now() - Date.parse(inizio)) / 60000)) : null;

const stato = {
  // ── il contratto della lezione (02-lezioni/ESITI-SYNC-NESSUN-CAMPO-TEMPO.md) ──
  ultimoGiro: ultimoGiro,
  record: record,
  fonte: fontiArchivio.length
    ? fontiArchivio.map((f) => f.nome).join(' · ')
    : 'nessuna fonte leggibile (archivio non leggibile)',
  esito: esito,
  durataMin: durataMin,
  // ── il resto: la prova, non la promessa ──
  giro: {
    avviato: inizio || null,
    finito: ora,
    consegna: consegna,
    runId: process.env.GITHUB_RUN_ID || null,
    commit: process.env.GITHUB_SHA ? String(process.env.GITHUB_SHA).slice(0, 12) : null,
    workflow: 'esiti-sync',
  },
  fonti: fontiArchivio,
  archivio: { byte: byte, sha256: impronta, recordPrima: recordPrima, recordNuovi: recordNuovi, lettura: letturaArchivio },
  raccolti: raccolti,
  esiti: {
    awards: awards,
    immobiliari: immobiliari,
    copertura: copertura,
    fonte: fonteEsiti,
    rilevazione: rilevazioneEsiti,
  },
  // la prova del punto 3: cosa dichiara OGGI il monitor servito dal sito
  monitor: monitor
    ? {
        generato: monitor.generato || null,
        fonte: monitor.fonte || null,
        fonteUrl: monitor.fonteUrl || null,
        rilevazione: monitor.rilevazione || null,
        coperturaAl: (monitor.copertura && monitor.copertura.al) || null,
      }
    : null,
  nota: nota,
  schema: 'esiti-stato/1 (13/11/2026) — scritto a ogni giro; ultimoGiro avanza solo se il giro ha consegnato',
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(stato, null, 2) + '\n');

console.log(
  'esiti-stato: ' +
    out +
    ' · ultimoGiro ' +
    stato.ultimoGiro +
    ' · esito ' +
    esito +
    ' · record ' +
    record +
    (recordNuovi != null ? ' (' + (recordNuovi >= 0 ? '+' : '') + recordNuovi + ')' : '') +
    ' · fonte ' +
    stato.fonte +
    (durataMin != null ? ' · ' + durataMin + ' min' : ''),
);
if (raccolti.totale != null) console.log('esiti-stato: raccolti in questo giro: ' + JSON.stringify(raccolti));
if (!avanza) {
  console.error('esiti-stato: il giro NON ha consegnato (' + esito + '): ultimoGiro resta ' + ultimoGiro);
  process.exitCode = 2;
}
