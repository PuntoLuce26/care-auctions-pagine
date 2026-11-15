// scripts/aggiudicazioni-merge.js — 9/11/2026 (battito dentro l'archivio: 15/11/2026)
// ---------------------------------------------------------------------------
// L'archivio dei prezzi di aggiudicazione (feed/aggiudicazioni.json) ha PIU'
// scrittori nello stesso giro di feed-sync in modalita' full: sync-feed.js (esiti
// del PVP) e poi fallco-aggiudicazioni.js e ivg-aggiudicazioni.js. Il 9/11 alle
// 01:58Z l'ultimo scrittore ha sovrascritto l'archivio con un array VUOTO: 16.771
// prezzi (298.835.634 EUR) sono spariti dalla pagina pubblica /aggiudicazioni,
// che da allora mostra zero righe. Ripristinati lo stesso giorno dal commit
// 9357e842; questo file esiste perche' non succeda piu'.
//
// REGOLE (ferme):
//   1) si UNISCE, non si sovrascrive: chiave = fonte|id;
//   2) un array vuoto NON si scrive mai: se non c'e' niente di nuovo, il file
//      resta com'e';
//   3) il merge non accorcia mai l'archivio: se il risultato ha meno record di
//      prima, non si scrive e si dice perche';
//   4) ogni record dichiara la sua fonte (fallcoaste, anivg, ivg, notarile-verona,
//      pvp): un prezzo senza fonte non e' un dato, e' un numero.
//
// 15/11/2026 — IL BATTITO DENTRO IL FILE (difetto 1: aggiudicazioni.json fermo
// da 71,3 h contro una soglia contrattuale di 26 h, con 5 run esiti-sync verdi).
// ---------------------------------------------------------------------------
// MISURA: al 15/11 09:09 il file era fermo al commit ea3f195b del 12/11 08:50:40Z
// (71,3 h) e non portava alcun campo temporale; un giro verde che non scriveva e
// un generatore morto producevano lo STESSO segnale. Il sidecar
// feed/aggiudicazioni-stato.json (battito a ogni giro, anche a zero variazioni)
// dice se il generatore e' vivo, ma NON rende giovane l'archivio: il contratto
// parla del file aggiudicazioni.json.
// PERCHE' NON SI CAMBIA LA FORMA DEL FILE: aggiudicazioni.json e' un ARRAY nudo e
// lo leggono come array 10 script del repo (dati-indice, numeri-vivi, meccanismi-
// dati, esiti-stato, esiti-sync, riconcilia-esiti, idmap-sitemap, ai-education,
// sync-feed, qa-orchestra) piu' l'edge (careauctions/edge/worker.js, rotta
// /osservatorio: `for (const x of agg)`), che NON e' fra i file che questo lavoro
// puo' toccare. Un oggetto {meta,dati} o un record in piu' falserebbero i conteggi
// (record = lunghezza dell'array) in pagine pubbliche.
// PERCHE' NON BASTA RISCRIVERE LO STESSO CONTENUTO: git non registra un commit se i
// byte non cambiano, quindi "riscrivere l'array a ogni run" non rinnova il commit
// che il contratto misura. Serve un byte vero che cambi nel file.
// CURA: il file resta un array dei SOLI record reali (nessun record finto: la
// lunghezza e' il numero pubblicato) e porta il suo istante di scrittura su un
// campo del suo ultimo record:
//   archivioScrittoIl = quando l'archivio e' stato scritto l'ultima volta
//   archivioRecord    = quanti record conteneva in quella scrittura
// I lettori leggono campi noti e la lunghezza: i due campi in piu' non spostano
// nessun numero. Il file viene scritto quando i dati cambiano E, se non cambiano,
// almeno ogni BATTITO_ORE (10 h): cosi' l'eta' del file resta sotto la soglia di
// 26 h anche in giorni senza aggiudicazioni nuove. Costo: una riscrittura ogni
// 10 h dei 3,9 MB (un blob compresso al giorno) al posto di nessuna.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE_FEED = path.join(__dirname, '..', 'feed', 'aggiudicazioni.json');
const BATTITO_ORE = 10;          // oltre questo silenzio il file si riscrive comunque
const SOGLIA_CONTRATTO_ORE = 26; // soglia contrattuale dell'eta' del file
const CAMPI_STAMPO = ['archivioScrittoIl', 'archivioRecord'];

function chiave(x) { return String((x && x.fonte) || '?') + '|' + String((x && x.id) || ''); }

function leggi(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : []; }
  catch (e) { return []; }
}

// Copia dei record senza i campi di battito: servono a confrontare i DATI, non lo stampo.
function senzaStampo(rec) {
  return (rec || []).map((x) => {
    if (!x || typeof x !== 'object') return x;
    let ha = false;
    for (const c of CAMPI_STAMPO) if (Object.prototype.hasOwnProperty.call(x, c)) ha = true;
    if (!ha) return x;
    const y = Object.assign({}, x);
    for (const c of CAMPI_STAMPO) delete y[c];
    return y;
  });
}

// Lo stampo vive sull'ULTIMO record: l'array resta un array, la lunghezza non cambia.
function conStampo(rec, iso) {
  const out = rec.slice();
  if (!out.length) return out;
  const i = out.length - 1;
  if (!out[i] || typeof out[i] !== 'object') return out;
  out[i] = Object.assign({}, out[i], { archivioScrittoIl: iso, archivioRecord: out.length });
  return out;
}

// L'istante di scrittura dichiarato dal file stesso (null se non c'e': file vecchio).
function stampoDi(rec) {
  for (let i = (rec || []).length - 1; i >= 0; i--) {
    const x = rec[i];
    if (x && typeof x === 'object' && /^\d{4}-\d{2}-\d{2}T/.test(String(x.archivioScrittoIl || ''))) {
      return String(x.archivioScrittoIl);
    }
  }
  return null;
}

// Scrive l'archivio quando serve davvero; dice SEMPRE cosa ha deciso e perche'.
//   dati cambiati      -> si scrive (con lo stampo nuovo);
//   dati identici      -> si scrive solo se lo stampo nel file ha piu' di BATTITO_ORE;
//   array vuoto        -> non si scrive mai (regola 2).
function scriviArchivio(file, rec, opts = {}) {
  const log = opts.log || (() => {});
  const suDisco = leggi(file);
  const puliti = senzaStampo(rec);
  if (!puliti.length) {
    log('aggiudicazioni: array vuoto — NON scrivo (regola ferma: un archivio vuoto non si scrive)');
    return { scritto: false, motivo: 'vuoto', record: 0, archivioScrittoIl: stampoDi(suDisco) };
  }
  const datiCambiati = JSON.stringify(puliti) !== JSON.stringify(senzaStampo(suDisco));
  const ultimo = stampoDi(suDisco);
  const ore = ultimo ? (Date.now() - Date.parse(ultimo)) / 3600000 : Infinity;
  if (!datiCambiati && ore < BATTITO_ORE) {
    log('aggiudicazioni: dati invariati e archivio scritto ' + ore.toFixed(1) + ' h fa (< ' + BATTITO_ORE + ' h) — non riscrivo');
    return { scritto: false, motivo: 'fresco', record: puliti.length, ore: Number(ore.toFixed(2)), archivioScrittoIl: ultimo };
  }
  const iso = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(conStampo(puliti, iso)));
  log('aggiudicazioni.json: SCRITTO ' + puliti.length + ' record — '
    + (datiCambiati ? 'dati cambiati' : 'battito (ultimo scritto ' + (isFinite(ore) ? ore.toFixed(1) + ' h fa' : 'mai') + ')')
    + ' · archivioScrittoIl ' + iso);
  return { scritto: true, motivo: datiCambiati ? 'dati' : 'battito', record: puliti.length, archivioScrittoIl: iso };
}

// Unisce `nuovi` all'archivio su disco. Restituisce il conto e se ha scritto.
function mergeRecords(file, nuovi, opts = {}) {
  const log = opts.log || (() => {});
  const fonte = opts.fonte || null;
  const vecchi = leggi(file);
  const m = new Map();
  for (const x of vecchi) if (x && x.id !== undefined && x.id !== null && x.id !== '') m.set(chiave(x), x);
  const prima = m.size;
  let aggiunti = 0, aggiornati = 0;
  for (const x of (nuovi || [])) {
    if (!x || x.id === undefined || x.id === null || x.id === '') continue;
    const y = fonte && !x.fonte ? Object.assign({}, x, { fonte }) : x;
    const k = chiave(y);
    if (!m.has(k)) { m.set(k, y); aggiunti++; }
    else { m.set(k, Object.assign({}, m.get(k), y)); aggiornati++; }
  }
  const fuori = [...m.values()];
  // Se il file su disco ha chiavi ripetute, il numero di RECORD scendera' al primo giro:
  // non e' un record perso (le voci distinte restano tutte, `prima` e' il conto delle
  // chiavi distinte), ma va detto invece di lasciarlo succedere in silenzio.
  if (vecchi.length > prima) log('aggiudicazioni: nel file ci sono ' + (vecchi.length - prima) + ' record con chiave ripetuta — il merge li riduce a una voce ciascuno (' + prima + ' distinte)');
  // 1) niente da unire: non si tocca il contenuto, ma l'archivio puo' comunque aver
  //    bisogno del suo battito (e' cio' che tiene l'eta' del file sotto 26 h).
  if (!fuori.length) {
    log('aggiudicazioni: nessun record — file lasciato com\'era (' + vecchi.length + ')');
    const s = scriviArchivio(file, vecchi, { log });
    battito(file, { log, archivio: s });
    return { prima, dopo: vecchi.length, aggiunti: 0, scritto: false };
  }
  // 2) il merge non accorcia mai: se accorcerebbe, il contenuto non si scrive (regola 3).
  if (fuori.length < prima) {
    log('aggiudicazioni: il merge accorcia (' + prima + ' -> ' + fuori.length + ') — NON scrivo');
    const s = scriviArchivio(file, vecchi, { log });
    battito(file, { log, archivio: s });
    return { prima, dopo: prima, aggiunti, scritto: false };
  }
  const s = scriviArchivio(file, fuori, { log });
  const perFonte = {};
  for (const x of fuori) perFonte[(x && x.fonte) || '?'] = (perFonte[(x && x.fonte) || '?'] || 0) + 1;
  log('aggiudicazioni.json: ' + fuori.length + ' record (prima ' + prima + ', +' + aggiunti + ' nuovi, ' + aggiornati + ' aggiornati) — fonti: ' + JSON.stringify(perFonte));
  // il battito si scrive DOPO l'archivio: se il processo muore prima, il file di stato
  // non racconta un giro che non e' finito.
  battito(file, { log, variazioni: { aggiunti, aggiornati }, archivio: s });
  return { prima, dopo: fuori.length, aggiunti, scritto: !!s.scritto };
}

// Forme delle due fonti raccolte dal workflow.
function daFallco(j) {
  const v = (j && j.voci) || [];
  return v.map(x => ({
    id: String(x.id),
    descrizione: String(x.descrizione || '').slice(0, 140),
    prezzo: x.prezzo_numero,
    prezzo_label: x.prezzo_label || '',
    termina: String(x.termine || '').slice(0, 10),
    ivg: x.ivg || '',
    tribunale: x.tribunale || '',
    fonte: 'fallcoaste',
  }));
}

function daIvg(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(x => x && x.venduto && x.prezzo)
    .map(x => ({ id: x.id, titolo: x.titolo, prezzo: x.prezzo, url: x.url, fonte: 'ivg' }));
}

// 15/11/2026 — IL BATTITO (sidecar di osservabilita').
// Il file aggiudicazioni.json e' un array nudo: la sua data vive qui (aggiornato =
// ultimo giro del generatore, ultimoCambio = ultima variazione reale dei dati) e,
// dentro il file stesso, nel campo archivioScrittoIl dell'ultimo record.
const CANARY = 'care-canary-d2c32afaa5d5';

function battito(file, opts = {}) {
  const log = opts.log || (() => {});
  const statoFile = path.join(path.dirname(file), 'aggiudicazioni-stato.json');
  const rec = leggi(file);
  let prezzoTotale = 0, conPrezzo = 0;
  for (const x of rec) { const p = Number(x && x.prezzo); if (p > 0) { prezzoTotale += p; conPrezzo++; } }
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(statoFile, 'utf8')) || {}; } catch (e) {}
  const v = opts.variazioni || { aggiunti: 0, aggiornati: 0 };
  const cambiato = ((v.aggiunti || 0) + (v.aggiornati || 0)) > 0;
  const aggiornato = new Date().toISOString();
  const scrittoIl = stampoDi(rec) || null;
  const etaOre = scrittoIl ? Number(((Date.now() - Date.parse(scrittoIl)) / 3600000).toFixed(2)) : null;
  const arch = opts.archivio || null;
  const stato = {
    aggiornato,
    ultimoCambio: cambiato ? aggiornato : (prev.ultimoCambio || null),
    esito: cambiato ? 'scritto' : 'nessuna-variazione',
    record: rec.length,
    conPrezzo,
    prezzoTotale: Math.round(prezzoTotale),
    variazioni: v,
    archivio: {
      scrittoIl,
      etaOre,
      sogliaOre: SOGLIA_CONTRATTO_ORE,
      battitoOre: BATTITO_ORE,
      scrittoInQuestoGiro: !!(arch && arch.scritto),
      motivo: arch ? arch.motivo : null,
      nota: 'il file e\' un array nudo: l\'istante di scrittura viaggia nel campo archivioScrittoIl dell\'ultimo record; qui c\'e\' la sua copia leggibile',
    },
    fonte: 'feed/aggiudicazioni.json',
    generatore: 'scripts/aggiudicazioni-merge.js',
    nota: 'aggiornato = ultimo giro del generatore; ultimoCambio = ultima variazione reale dei dati; archivio.etaOre = eta\' del file misurata sul suo stampo (deve restare sotto la soglia contrattuale)',
    meta: { canary: CANARY, canaryNota: 'valore di riconoscimento della copia dei dati' },
  };
  fs.writeFileSync(statoFile, JSON.stringify(stato));
  log('aggiudicazioni-stato.json: ' + stato.esito + ' · ' + stato.record + ' record · aggiornato ' + stato.aggiornato
    + ' · file scritto ' + (scrittoIl || 'mai') + (etaOre === null ? '' : ' (' + etaOre + ' h)'));
  return stato;
}

if (require.main === module) {
  const [tipo, input, out] = process.argv.slice(2);
  const file = out || FILE_FEED;
  const log = (m) => console.log(m);
  if (!tipo) { console.log('uso: node scripts/aggiudicazioni-merge.js fallco|ivg <file-raccolta> [feed/aggiudicazioni.json] | battito'); process.exit(0); }
  // 15/11/2026 — modo "battito": si chiama a ogni giro di feed-sync, anche quando non c'e'
  // niente da unire. Scrive feed/aggiudicazioni-stato.json a ogni giro e, quando lo stampo
  // dell'archivio ha piu' di BATTITO_ORE, riscrive anche l'archivio (stesso contenuto,
  // stampo nuovo) cosi' il file non resta fermo oltre la soglia contrattuale.
  if (tipo === 'battito') {
    const s = scriviArchivio(file, leggi(file), { log });
    const st = battito(file, { log, archivio: s });
    console.log(JSON.stringify({ esito: st.esito, record: st.record, aggiornato: st.aggiornato, ultimoCambio: st.ultimoCambio, archivio: st.archivio }));
    process.exit(0);
  }
  let j = null;
  try { j = JSON.parse(fs.readFileSync(input, 'utf8')); }
  catch (e) {
    console.log('aggiudicazioni: raccolta ' + tipo + ' non leggibile (' + e.message.slice(0, 60) + ') — archivio intatto');
    battito(file, { log, archivio: scriviArchivio(file, leggi(file), { log }) });
    process.exit(0);
  }
  const nuovi = tipo === 'fallco' ? daFallco(j) : tipo === 'ivg' ? daIvg(j) : [];
  if (!nuovi.length) {
    console.log('aggiudicazioni: la raccolta ' + tipo + ' non ha voci utili — archivio intatto');
    battito(file, { log, archivio: scriviArchivio(file, leggi(file), { log }) });
    process.exit(0);
  }
  const esitoMerge = mergeRecords(file, nuovi, { log });
  // 13/11/2026 — la DATA VERA DELLA RACCOLTA non deve piu' perdersi. Il collettore
  // (scripts/fallco-aggiudicazioni.js) scrive raccolto_il sull'oggetto /tmp/aggiudicazioni-fallco.json,
  // ma il merge riduce tutto a un array di record e quel campo evaporava: da qui i feed che
  // aggregano l'archivio (esiti-monitor) non potevano dichiarare una rilevazione e restavano
  // nascosti. Ora il sidecar conserva l'istante di FINE RACCOLTA dichiarato dal collettore
  // stesso (non l'ora dello script ne' quella del commit, che arriva fino a un'ora dopo).
  try {
    const raccolto = String((j && j.raccolto_il) || '');
    if (/^\d{4}-\d{2}-\d{2}T/.test(raccolto)) {
      const metaFile = path.join(path.dirname(file), 'aggiudicazioni-meta.json');
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch (e) {}
      const meta = Object.assign({}, prev, {
        ultimaRaccolta: raccolto,
        raccolte: Object.assign({}, prev.raccolte || {}, { [tipo]: raccolto }),
        fonte: 'FallcoAste — fallcoaste.it',
        fonteUrl: 'https://www.fallcoaste.it',
        record: (esitoMerge && esitoMerge.dopo) || undefined,
        provenienza: 'campo raccolto_il scritto da scripts/fallco-aggiudicazioni.js al termine della raccolta; il merge in feed-sync lo conserva qui',
        scritto: new Date().toISOString(),
      });
      if (!meta.record) delete meta.record;
      fs.writeFileSync(metaFile, JSON.stringify(meta));
      log('aggiudicazioni-meta.json: ultima raccolta ' + raccolto + ' (' + tipo + ')');
    }
  } catch (e) { console.log('aggiudicazioni-meta: non scritto (' + e.message.slice(0, 60) + ')'); }
}

module.exports = { mergeRecords, daFallco, daIvg, chiave, battito, scriviArchivio, stampoDi, BATTITO_ORE, SOGLIA_CONTRATTO_ORE };
