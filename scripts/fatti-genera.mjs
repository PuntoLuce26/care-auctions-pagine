#!/usr/bin/env node
/**
 * scripts/fatti-genera.mjs
 *
 * Genera gli artefatti che rendono i numeri delle aste giudiziarie italiane
 * leggibili a una macchina:
 *   - ai/fatti.json    → { meta, fatti: [ {id, frase, valore, unita, fonte, url_fonte,
 *                        rilevazione, copertura, feed, url_pagina, ...} ] }
 *   - fatti/index.html → pagina statica (zero JS) con una frase autosufficiente per riga
 *                        + JSON-LD Dataset e FAQPage
 *
 * Zero dipendenze. Node 22. Legge i feed da <radice>/feed/ e, se un file locale
 * manca, da https://careauctions.co/feed/<file>.
 *
 * LA REGOLA ESEGUITA: un fatto senza fonte, rilevazione o copertura — o con una
 * cifra nella frase e nessuna «Fonte:» — non si pubblica: il generatore NON scrive
 * i file, elenca i rifiutati ed esce con codice 1. Lo stesso vale per la forma:
 * lo scarto prezzo base → offerta minima non si chiama «sconto» (è il pavimento
 * legale del 25%): si chiama scarto_base_minima, e un campo «sconto» che sia
 * quello scarto viene rifiutato dicendolo.
 *
 * Uso:
 *   node scripts/fatti-genera.mjs                 # genera
 *   node scripts/fatti-genera.mjs --autotest      # fixture senza fonte: DEVE uscire 1
 *   node scripts/fatti-genera.mjs --root=<dir>    # radice alternativa (prove locali)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const QUI = dirname(fileURLToPath(import.meta.url));

function argomento(nome) {
  const prefisso = `--${nome}=`;
  const trovato = process.argv.find((a) => a.startsWith(prefisso));
  return trovato ? trovato.slice(prefisso.length) : null;
}

const RADICE = resolve(argomento('root') || process.env.CARE_FATTI_ROOT || join(QUI, '..'));
const AUTOTEST = process.argv.includes('--autotest');
const ORIGINE_FEED = argomento('feed-base') || 'https://careauctions.co/feed/';
const FILE_FATTI = join(RADICE, 'ai', 'fatti.json');
const FILE_PAGINA = join(RADICE, 'fatti', 'index.html');

/* ------------------------------------------------------------------ *
 * Errori
 * ------------------------------------------------------------------ */

/** Violazione di una regola: blocca la scrittura ed esce con 1. */
class Rifiuto extends Error {
  constructor(messaggio, dettagli = []) {
    super(messaggio);
    this.dettagli = dettagli;
  }
}

/* ------------------------------------------------------------------ *
 * Lettura file e feed
 * ------------------------------------------------------------------ */

function leggiJson(percorso) {
  return JSON.parse(readFileSync(percorso, 'utf8'));
}

if (!existsSync(join(RADICE, 'regole', 'fatti.json'))) {
  console.error(`RIFIUTO: manca ${join(RADICE, 'regole', 'fatti.json')} — senza le regole non si generano fatti.`);
  process.exit(1);
}
const REGOLE = leggiJson(join(RADICE, 'regole', 'fatti.json'));

const CACHE_FEED = new Map();
const FEED_LETTI = [];

/** Chiavi «sconto…» trovate nei feed, con il loro percorso. */
function chiaviSconto(valore, percorso = '', trovate = []) {
  if (Array.isArray(valore)) {
    valore.forEach((v, i) => chiaviSconto(v, `${percorso}[${i}]`, trovate));
  } else if (valore && typeof valore === 'object') {
    for (const [k, v] of Object.entries(valore)) {
      if (/^sconto/i.test(k)) trovate.push(`${percorso}${percorso ? '.' : ''}${k}`);
      chiaviSconto(v, `${percorso}${percorso ? '.' : ''}${k}`, trovate);
    }
  }
  return trovate;
}

/** Il feed dichiara un confronto di mercato (OMI)? Serve a distinguere
 *  «sconto» (ribasso rispetto al mercato) da «scarto base → minima». */
function dichiaraConfrontoDiMercato(json) {
  const contesto = JSON.stringify({
    meta: json.meta || null,
    fonte: json.fonte || null,
    fonteValore: json.fonteValore || null,
    fontePrezzi: json.fontePrezzi || null,
    metodo: json.metodo || null,
    nota: json.nota || null,
  });
  return /omi|mercato|agenzia\s+delle\s+entrate/i.test(contesto);
}

async function feed(nome) {
  if (CACHE_FEED.has(nome)) return CACHE_FEED.get(nome);

  const percorso = join(RADICE, 'feed', nome);
  let esito;
  if (existsSync(percorso)) {
    esito = { json: leggiJson(percorso), da: 'locale' };
  } else {
    const risposta = await fetch(ORIGINE_FEED + nome, {
      headers: { 'user-agent': 'careauctions-fatti/1.0 (+https://careauctions.co/fatti)' },
    });
    if (!risposta.ok) {
      throw new Error(`feed ${nome} non leggibile: file locale assente, remoto HTTP ${risposta.status}`);
    }
    esito = { json: await risposta.json(), da: 'remoto' };
  }

  // Regola di forma: un campo «sconto…» senza confronto OMI dichiarato è lo
  // scarto prezzo base → offerta minima mascherato da sconto di mercato.
  const sconto = chiaviSconto(esito.json);
  if (sconto.length && !dichiaraConfrontoDiMercato(esito.json)) {
    throw new Rifiuto(
      `il feed ${nome} espone ${sconto.length} campo/i «sconto» (${sconto.slice(0, 4).join(', ')}) senza dichiarare il confronto con i valori di mercato OMI`,
      [
        'Lo scarto tra prezzo base e offerta minima è il pavimento legale del 25% (base − 25% = minima), non uno sconto di mercato.',
        'Cura: rinominare il campo in scarto_base_minima, oppure dichiarare nel feed (meta/metodo/fonte) che lo sconto è calcolato contro i valori OMI.',
      ],
    );
  }

  esito.scontoOmi = sconto;
  CACHE_FEED.set(nome, esito);
  FEED_LETTI.push({ file: `feed/${nome}`, da: esito.da, scontoDichiarato: sconto.length || 0 });
  return esito;
}

/* ------------------------------------------------------------------ *
 * Formattazione (it-IT a mano: su questo Node toLocaleString('it-IT')
 * non mette il separatore delle migliaia)
 * ------------------------------------------------------------------ */

function NUM(n, decimali = 0) {
  if (decimali > 0 && Number.isInteger(Number(n))) decimali = 0;
  const negativo = n < 0;
  const [intero, frazione] = Math.abs(n).toFixed(decimali).split('.');
  const interoFmt = intero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}${interoFmt}${frazione ? `,${frazione}` : ''}`;
}

function partiUtc(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    data: `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    ora: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
  };
}

function dataIt(iso) {
  const p = partiUtc(iso);
  return p ? p.data : String(iso || '');
}

function rilevazioneIt(iso) {
  const p = partiUtc(iso);
  return p ? `${p.data} ${p.ora} UTC` : String(iso || '');
}

/** ISO da una data semplice AAAA-MM-GG (mezzanotte UTC). */
function isoDaGiorno(giorno) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(giorno)) ? `${giorno}T00:00:00Z` : null;
}

/* ------------------------------------------------------------------ *
 * Fonti e coperture
 * ------------------------------------------------------------------ */

function sorgente(id) {
  const trovata = (REGOLE.fonti || []).find((f) => f.id === id);
  if (!trovata) throw new Rifiuto(`fonte «${id}» non presente in regole/fatti.json: una fonte non ammessa non si usa`);
  return trovata;
}

/** Copertura dichiarata in regole/fatti.json per un campo che il feed non copre. */
function coperturaDichiarata(fileFeed, campo) {
  const riga = (REGOLE.coperturaDichiarata || []).find((r) => r.feed === fileFeed && r.campo === campo);
  return riga ? { copertura: riga.copertura, origine: 'regole-dichiarata' } : null;
}

/* ------------------------------------------------------------------ *
 * Costruzione del fatto (formato esatto della frase)
 * ------------------------------------------------------------------ */

function costruisciFatto(spec) {
  const frase =
    `Al ${dataIt(spec.rilevazione)} ${spec.parte}. ` +
    `Fonte: ${spec.fonte}. ` +
    `Rilevazione: ${rilevazioneIt(spec.rilevazione)}. ` +
    `Copertura: ${spec.copertura}.`;
  return {
    id: spec.id,
    frase,
    valore: spec.valore,
    unita: spec.unita,
    fonte: spec.fonte,
    url_fonte: spec.url_fonte,
    rilevazione: spec.rilevazione,
    copertura: spec.copertura,
    coperturaFonte: spec.coperturaFonte,
    feed: spec.feed,
    url_pagina: spec.url_pagina,
    domanda: spec.domanda,
    etaOre: Number.isNaN(Date.parse(spec.rilevazione))
      ? null
      : Math.round(((Date.now() - Date.parse(spec.rilevazione)) / 3600000) * 10) / 10,
  };
}

/* ------------------------------------------------------------------ *
 * Derivazione dei fatti dai feed reali (mai un numero inventato)
 * ------------------------------------------------------------------ */

const FATTI = [];
const NON_EMESSI = [];

function nonEmesso(id, motivo, fileFeed) {
  NON_EMESSI.push({ id, motivo, feed: fileFeed || null });
}

function emetti(spec) {
  if (!spec.copertura || String(spec.copertura).trim() === '') {
    nonEmesso(spec.id, 'nessuna copertura nel feed e nessuna copertura dichiarata in regole/fatti.json: non si emette', spec.feed);
    return;
  }
  FATTI.push(costruisciFatto(spec));
}

/** Esegue un blocco di derivazione: un guasto tecnico diventa «non emesso», una violazione di regola no. */
async function blocco(nome, funzione) {
  try {
    await funzione();
  } catch (errore) {
    if (errore instanceof Rifiuto) throw errore;
    nonEmesso(`blocco-${nome}`, `derivazione non riuscita: ${errore.message}`, null);
  }
}

/* --- 1. Catalogo lotti (feed/statistiche.json) --------------------- */

async function derivaStatistiche() {
  const { json: s } = await feed('statistiche.json');
  const pvp = sorgente('pvp');
  const rilevazione = s.rilevazione || s.aggiornato;
  const fileFeed = 'feed/statistiche.json';
  const base = {
    fonte: pvp.nome,
    url_fonte: s.fonte?.url || pvp.url,
    rilevazione,
    feed: fileFeed,
  };

  const copTotale = coperturaDichiarata(fileFeed, 'totale');
  if (Number.isFinite(Number(s.totale))) {
    emetti({
      ...base,
      id: 'catalogo-lotti-attivi',
      domanda: 'Quante aste giudiziarie ci sono in Italia?',
      parte: `le aste giudiziarie attive pubblicate in Italia (immobiliari e mobiliari) sono ${NUM(Number(s.totale))}`,
      valore: Number(s.totale),
      unita: 'lotti',
      copertura: copTotale?.copertura,
      coperturaFonte: copTotale?.origine,
      url_pagina: 'https://careauctions.co/idati',
    });
  } else {
    nonEmesso('catalogo-lotti-attivi', 'feed/statistiche.json non espone un totale numerico', fileFeed);
  }

  const copPrezzo = coperturaDichiarata(fileFeed, 'prezzoMedioImm');
  if (Number.isFinite(Number(s.prezzoMedioImm))) {
    emetti({
      ...base,
      id: 'prezzo-base-medio-immobiliare',
      domanda: 'Qual è il prezzo base medio delle aste immobiliari in Italia?',
      parte: `il prezzo base medio dei lotti immobiliari in catalogo è di ${NUM(Number(s.prezzoMedioImm))} €`,
      valore: Number(s.prezzoMedioImm),
      unita: '€',
      copertura: copPrezzo?.copertura,
      coperturaFonte: copPrezzo?.origine,
      url_pagina: 'https://careauctions.co/idati',
    });
  } else {
    nonEmesso('prezzo-base-medio-immobiliare', 'feed/statistiche.json non espone prezzoMedioImm', fileFeed);
  }

  const copScarto = coperturaDichiarata(fileFeed, 'scartoBaseMinimaMedioImm');
  if (Number.isFinite(Number(s.scartoBaseMinimaMedioImm))) {
    emetti({
      ...base,
      id: 'scarto-base-minima-medio-immobiliare',
      domanda: 'Quanto vale lo scarto tra prezzo base e offerta minima in un\'asta giudiziaria?',
      parte: `lo scarto medio tra prezzo base d'asta e offerta minima sui lotti immobiliari è del ${NUM(Number(s.scartoBaseMinimaMedioImm))}% (è il pavimento legale dell'offerta, non uno sconto di mercato)`,
      valore: Number(s.scartoBaseMinimaMedioImm),
      unita: '%',
      copertura: copScarto?.copertura,
      coperturaFonte: copScarto?.origine,
      url_pagina: 'https://careauctions.co/ca-re-index',
    });
  } else {
    nonEmesso('scarto-base-minima-medio-immobiliare', 'feed/statistiche.json non espone scartoBaseMinimaMedioImm', fileFeed);
  }

  // Gli esiti per stato (aggiudicate / deserte / sospese / non pubblicato) sono
  // esposti dal feed senza copertura e senza provenienza per stato: non si emettono.
  const esiti = s.esiti || null;
  if (esiti && Object.keys(esiti).length) {
    const senzaProvenienza = !s.esitiCopertura && !s.copertura && !s.esitiUltimaRilevazione;
    if (senzaProvenienza) {
      nonEmesso(
        'esiti-aggiudicate-deserte-sospese-non-pubblicato',
        'feed/statistiche.json espone i quattro stati degli esiti senza copertura dichiarata e senza provenienza per stato; ' +
          'la verifica di progetto del 6/11/2026 documenta che l\'API pubblica del PVP restituisce il campo esito sempre null, ' +
          'quindi il conteggio non è citabile come censimento finché il generatore del feed non dichiara copertura e rilevazione per stato',
        fileFeed,
      );
    } else {
      const cop = s.esitiCopertura || s.copertura;
      const rie = s.esitiUltimaRilevazione || rilevazione;
      for (const [stato, valore] of Object.entries(esiti)) {
        if (!Number.isFinite(Number(valore))) continue;
        emetti({
          ...base,
          rilevazione: rie,
          id: `esiti-${stato.toLowerCase()}`,
          domanda: `Quante aste risultano «${stato}» in Italia?`,
          parte: `i lotti del catalogo con esito «${stato}» sono ${NUM(Number(valore))}`,
          valore: Number(valore),
          unita: 'lotti',
          copertura: cop,
          coperturaFonte: s.esitiCopertura ? 'feed' : 'regole-dichiarata',
          url_pagina: 'https://careauctions.co/aggiudicazioni',
        });
      }
    }
  }
}

/* --- 2. Tribunali (feed/tribunali.json) ---------------------------- */

function segmentoCopertura(copertura, chiave) {
  const segmenti = String(copertura || '').split(' · ');
  return segmenti.filter((s) => s.toLowerCase().startsWith(chiave.toLowerCase())).join(' · ');
}

async function derivaTribunali() {
  const { json: t } = await feed('tribunali.json');
  const pvp = sorgente('pvp');
  const elenco = Array.isArray(t.tribunali) ? t.tribunali : Object.values(t.tribunali || {});
  if (!elenco.length) throw new Error('feed/tribunali.json non contiene l\'elenco dei tribunali');

  const rilevazione = t.aggiornato || t.rilevazione;
  const fileFeed = 'feed/tribunali.json';
  const testa = segmentoCopertura(t.copertura, `${elenco.length} tribunali`) || `${elenco.length} tribunali in tabella`;
  const conLotti = elenco.filter((x) => Number(x.lottiAperti) > 0).length;
  const conEsiti = elenco.filter((x) => Number(x.aggiudicazioni) > 0).length;

  emetti({
    id: 'tribunali-con-lotti-attivi',
    domanda: 'Quanti tribunali hanno aste immobiliari ancora aperte in Italia?',
    parte: `i tribunali con lotti immobiliari ancora aperti sono ${NUM(conLotti)} (su ${NUM(elenco.length)} presenti nella tabella)`,
    valore: conLotti,
    unita: 'tribunali',
    fonte: t.fonte ? String(t.fonte).split(' · ')[0] : pvp.nome,
    url_fonte: pvp.url,
    rilevazione,
    copertura: `${testa} · ${segmentoCopertura(t.copertura, 'lottiAperti')}`,
    coperturaFonte: 'feed',
    feed: fileFeed,
    url_pagina: 'https://careauctions.co/idati',
  });

  emetti({
    id: 'tribunali-con-esiti',
    domanda: 'Quanti tribunali hanno almeno un\'aggiudicazione pubblicata?',
    parte: `i tribunali con almeno un esito di aggiudicazione pubblicato sono ${NUM(conEsiti)}`,
    valore: conEsiti,
    unita: 'tribunali',
    fonte: t.fonte ? String(t.fonte).split(' · ')[0] : pvp.nome,
    url_fonte: pvp.url,
    rilevazione,
    copertura: `${testa} · ${segmentoCopertura(t.copertura, 'aggiudicazioni')}`,
    coperturaFonte: 'feed',
    feed: fileFeed,
    url_pagina: 'https://careauctions.co/aggiudicazioni',
  });
}

/* --- 3. CAReIndex (feed/careindex-serie.json) ---------------------- */

async function derivaCareindex() {
  const { json: c } = await feed('careindex-serie.json');
  const pvp = sorgente('pvp');
  const serie = Array.isArray(c.serie) ? c.serie : [];
  if (serie.length < 2) throw new Error('feed/careindex-serie.json non contiene almeno due punti di serie');

  const primo = serie[0];
  const ultimo = serie[serie.length - 1];
  const meta = c.meta || {};
  const cop = meta.copertura || {};
  const finestra = meta.finestra || {};
  const rilevazione = meta.generatoIl || c.aggiornato || c.generatoIl;
  const fileFeed = 'feed/careindex-serie.json';

  const copertura =
    `serie di ${NUM(Number(cop.giorniInSerie || serie.length))} giorni dal ${dataIt(isoDaGiorno(finestra.dal) || rilevazione)} ` +
    `al ${dataIt(isoDaGiorno(finestra.al) || rilevazione)}, costruita su ${NUM(Number(cop.lottiConSuperficie || 0))} lotti residenziali ` +
    `con superficie dichiarata su ${NUM(Number(cop.lottiResidenziali || 0))} residenziali letti (${NUM(Number(cop.quotaPct || 0), 1)}%): ` +
    `i lotti senza superficie non si stimano e restano fuori`;

  const base = {
    fonte: pvp.nome,
    url_fonte: pvp.url,
    rilevazione,
    copertura,
    coperturaFonte: 'feed',
    feed: fileFeed,
    url_pagina: 'https://careauctions.co/ca-re-index',
  };

  emetti({
    ...base,
    id: 'careindex-indice-ultimo-punto',
    domanda: 'Come si muove il prezzo base al metro quadro delle aste immobiliari?',
    parte:
      `l'indice CAReIndex del prezzo base al metro quadro dei lotti residenziali è ${NUM(Number(ultimo.indice), 1)} ` +
      `nell'ultimo punto disponibile (${dataIt(isoDaGiorno(ultimo.giorno) || rilevazione)}), con base 100 nel primo punto ` +
      `(${dataIt(isoDaGiorno(primo.giorno) || rilevazione)})`,
    valore: Number(ultimo.indice),
    unita: 'indice (base 100)',
  });

  emetti({
    ...base,
    id: 'careindex-prezzo-mq-ultimo-punto',
    domanda: 'Qual è il prezzo base al metro quadro delle aste residenziali?',
    parte: `il prezzo base al metro quadro dei lotti residenziali nell'ultimo punto della serie è di ${NUM(Number(ultimo.prezzoMq))} €/m²`,
    valore: Number(ultimo.prezzoMq),
    unita: '€/m²',
  });

  emetti({
    ...base,
    id: 'careindex-prezzo-mq-primo-punto',
    domanda: 'Da quale prezzo al metro quadro parte la serie CAReIndex?',
    parte: `il prezzo base al metro quadro dei lotti residenziali nel primo punto della serie è di ${NUM(Number(primo.prezzoMq))} €/m²`,
    valore: Number(primo.prezzoMq),
    unita: '€/m²',
  });

  emetti({
    ...base,
    id: 'careindex-lotti-con-superficie',
    domanda: 'Su quanti lotti è calcolato il CAReIndex?',
    parte:
      `i lotti residenziali con superficie dichiarata che alimentano la serie CAReIndex sono ` +
      `${NUM(Number(cop.lottiConSuperficie || 0))} su ${NUM(Number(cop.lottiResidenziali || 0))} lotti residenziali letti`,
    valore: Number(cop.lottiConSuperficie || 0),
    unita: 'lotti',
  });
}

/* --- 4. Esiti con prezzo finale (feed/esiti-statistiche.json) ------ */

async function derivaEsitiStatistiche() {
  const { json: e } = await feed('esiti-statistiche.json');
  const cop = e.copertura || {};
  if (!e.rilevazione) throw new Error('feed/esiti-statistiche.json non dichiara la rilevazione');
  if (!cop.dal || !cop.al) throw new Error('feed/esiti-statistiche.json non dichiara la copertura temporale');

  const fallco = sorgente('fallcoaste');
  const fileFeed = 'feed/esiti-statistiche.json';
  const fonti = Array.isArray(e.fonte) ? e.fonte : [];
  const nomi = fonti.map((f) => f.nome).filter(Boolean);
  const fonte = nomi.length > 1 ? `${nomi.join(' e ')}` : (nomi[0] || fallco.nome);
  const urlFonte = fonti.find((f) => f.url)?.url || fallco.url;
  const copertura =
    `esiti immobiliari con prezzo finale di aggiudicazione pubblicato: ${NUM(Number(cop.esiti))} esiti ` +
    `dal ${dataIt(isoDaGiorno(cop.dal))} al ${dataIt(isoDaGiorno(cop.al))}, ${NUM(Number(cop.tribunali))} tribunali, ` +
    `${NUM(Number(cop.regioni))} regioni; non tutte le aste pubblicano il prezzo finale, i lotti senza prezzo base restano fuori`;

  const base = {
    fonte,
    url_fonte: urlFonte,
    rilevazione: e.rilevazione,
    copertura,
    coperturaFonte: 'feed',
    feed: fileFeed,
    url_pagina: 'https://careauctions.co/aggiudicazioni',
  };

  emetti({
    ...base,
    id: 'esiti-immobiliari-con-prezzo-finale',
    domanda: 'Quante aste immobiliari hanno un prezzo di aggiudicazione pubblicato?',
    parte:
      `gli esiti immobiliari con prezzo finale di aggiudicazione pubblicato sono ${NUM(Number(cop.esiti))} ` +
      `su ${NUM(Number(e.tutti))} esiti immobiliari raccolti`,
    valore: Number(cop.esiti),
    unita: 'esiti',
  });

  emetti({
    ...base,
    id: 'esiti-immobiliari-tribunali',
    domanda: 'Quanti tribunali compaiono nell\'archivio degli esiti con prezzo finale?',
    parte:
      `i tribunali coperti dall'archivio degli esiti immobiliari con prezzo finale sono ${NUM(Number(cop.tribunali))} ` +
      `in ${NUM(Number(cop.regioni))} regioni`,
    valore: Number(cop.tribunali),
    unita: 'tribunali',
  });

  const mediana = e.nazionale?.mediana;
  if (Number.isFinite(Number(mediana))) {
    emetti({
      ...base,
      id: 'esiti-prezzo-finale-mediano',
      domanda: 'Qual è il prezzo finale mediano di aggiudicazione di un\'asta immobiliare?',
      parte: `il prezzo finale mediano delle aggiudicazioni immobiliari è di ${NUM(Number(mediana))} €`,
      valore: Number(mediana),
      unita: '€',
    });
  }

  // Il monitor (feed/esiti-monitor.json) dichiara rilevazione: null — la data di
  // generazione non è la data di rilevazione, quindi non si emette.
  try {
    const { json: m } = await feed('esiti-monitor.json');
    if (!m.rilevazione) {
      nonEmesso(
        'esiti-monitor-aggiudicazioni',
        'feed/esiti-monitor.json dichiara rilevazione: null (il campo rilevazioneMotivo spiega che l\'archivio aggiudicazioni non conserva ' +
          'l\'istante di raccolta): la data di generazione non è la data di rilevazione, quindi il fatto non si emette. ' +
          'Cura: scripts/aggiudicazioni-merge.js deve scrivere l\'istante di raccolta (feed/aggiudicazioni-meta.json).',
        'feed/esiti-monitor.json',
      );
    }
  } catch (errore) {
    if (errore instanceof Rifiuto) throw errore;
  }
}

/* --- 5. Sconto Reale Certificato (feed/confronto-mercato.json) ----- */

async function derivaConfrontoMercato() {
  const { json: m } = await feed('confronto-mercato.json');
  const omi = sorgente('omi');
  const pvp = sorgente('pvp');
  const meta = m.meta || {};
  const cop = m.meta?.copertura || m.copertura || {};
  const naz = m.nazionale || {};
  const rilevazione = meta.rilevazione || m.rilevazione;
  if (!rilevazione) throw new Error('feed/confronto-mercato.json non dichiara la rilevazione');
  if (!cop.lottiResidenziali) throw new Error('feed/confronto-mercato.json non dichiara la copertura dei lotti');

  const copertura =
    `lotti residenziali a piena proprietà con superficie dichiarata e comune con valori OMI: ${NUM(Number(naz.lotti))} lotti confrontabili ` +
    `su ${NUM(Number(cop.lottiResidenziali))} residenziali; ${NUM(Number(cop.comuniPubblicati))} comuni pubblicati su ` +
    `${NUM(Number(cop.comuniOmi))} con valori OMI; semestre OMI ${meta.semestreOmi || 'dichiarato dal feed'}`;

  const base = {
    fonte: `${omi.nome} (valori di mercato) e ${pvp.nome} (prezzi base)`,
    url_fonte: omi.url,
    rilevazione,
    copertura,
    coperturaFonte: 'feed',
    feed: 'feed/confronto-mercato.json',
    url_pagina: 'https://careauctions.co/sconto-reale-certificato',
  };

  if (Number.isFinite(Number(naz.scontoMedianoPct))) {
    emetti({
      ...base,
      id: 'sconto-reale-mediano-nazionale',
      domanda: 'Quanto costano meno le aste rispetto ai valori di mercato OMI?',
      parte:
        `lo sconto mediano dei prezzi base d'asta rispetto ai valori di mercato OMI è del ` +
        `${NUM(Number(naz.scontoMedianoPct), 1)}%`,
      valore: Number(naz.scontoMedianoPct),
      unita: '%',
    });
  }

  if (Number.isFinite(Number(naz.scontoConservativoPct))) {
    emetti({
      ...base,
      id: 'sconto-reale-conservativo-nazionale',
      domanda: 'Qual è lo sconto delle aste calcolato nel modo più prudente?',
      parte:
        `lo sconto mediano calcolato contro la zona OMI più economica del comune è del ` +
        `${NUM(Number(naz.scontoConservativoPct), 1)}%`,
      valore: Number(naz.scontoConservativoPct),
      unita: '%',
    });
  }
}

/* --- 6. OMI (feed/omi-indice.json) -------------------------------- */

async function derivaOmi() {
  const { json: o } = await feed('omi-indice.json');
  const omi = sorgente('omi');
  const meta = o.meta || {};
  const rilevazione = meta.generatoIl;
  if (!rilevazione) throw new Error('feed/omi-indice.json non dichiara meta.generatoIl');
  if (!Number.isFinite(Number(meta.comuni))) throw new Error('feed/omi-indice.json non dichiara meta.comuni');

  const semestri = Array.isArray(meta.semestri) ? meta.semestri : [];
  const copertura =
    `${NUM(Number(meta.comuni))} comuni con quotazioni OMI, ${NUM(Object.keys(o.province || {}).length)} province, ` +
    `${NUM(Object.keys(o.regioni || {}).length)} regioni, ${NUM(Object.keys(o.aree || {}).length)} aree, ` +
    `semestri ${semestri[0] || '—'}–${semestri[semestri.length - 1] || '—'}`;

  const base = {
    fonte: omi.nome,
    url_fonte: omi.url,
    rilevazione,
    copertura,
    coperturaFonte: 'feed',
    feed: 'feed/omi-indice.json',
    url_pagina: 'https://careauctions.co/osservatorio',
  };

  emetti({
    ...base,
    id: 'omi-comuni-con-quotazioni',
    domanda: 'Su quanti comuni italiani esistono quotazioni OMI?',
    parte: `i comuni con quotazioni OMI disponibili sono ${NUM(Number(meta.comuni))}`,
    valore: Number(meta.comuni),
    unita: 'comuni',
  });

  const nazionale = Array.isArray(o.nazionale) ? o.nazionale : [];
  const ultimo = nazionale[nazionale.length - 1];
  if (ultimo) {
    emetti({
      ...base,
      id: 'omi-mediana-nazionale-ultimo-semestre',
      domanda: 'Qual è il valore mediano OMI al metro quadro in Italia?',
      parte:
        `il valore mediano al metro quadro delle quotazioni OMI residenziali nazionali è di ` +
        `${NUM(Number(ultimo.mediano))} €/m² nel semestre ${ultimo.semestre}`,
      valore: Number(ultimo.mediano),
      unita: '€/m²',
    });

    if (Number.isFinite(Number(ultimo.indice))) {
      const primo = nazionale[0];
      emetti({
        ...base,
        id: 'omi-indice-nazionale-ultimo-semestre',
        domanda: 'Come sono cambiati i valori OMI in Italia?',
        parte:
          `l'indice nazionale dei valori OMI è ${NUM(Number(ultimo.indice), 1)} nel semestre ${ultimo.semestre} ` +
          `(base 100 nel semestre ${primo.semestre})`,
        valore: Number(ultimo.indice),
        unita: 'indice (base 100)',
      });
    }
  }
}

/* --- 7. Lingue servite (feed/pagine91.json) ------------------------ */

async function derivaLingue() {
  const { json: p } = await feed('pagine91.json');
  const i18n = sorgente('i18n-care');
  const meta = p._meta || {};
  const rilevazione = meta.aggiornato || meta.ultimoCambio;
  if (!rilevazione) throw new Error('feed/pagine91.json non dichiara _meta.aggiornato');
  if (!Number.isFinite(Number(meta.lingue))) throw new Error('feed/pagine91.json non dichiara _meta.lingue');

  emetti({
    id: 'lingue-servite',
    domanda: 'In quante lingue è pubblicato il sito?',
    parte:
      `le lingue servite da careauctions.co sono ${NUM(Number(meta.lingue))}, ognuna tradotta una per una per le pagine /ilive e /stampa`,
    valore: Number(meta.lingue),
    unita: 'lingue',
    fonte: i18n.nome,
    url_fonte: i18n.url,
    rilevazione,
    copertura:
      `${NUM(Number(meta.lingueConIlive || meta.lingue))} lingue con la pagina /ilive e ` +
      `${NUM(Number(meta.lingueConStampa || meta.lingue))} con /stampa tradotte una per una (nessun fallback automatico)`,
    coperturaFonte: 'feed',
    feed: 'feed/pagine91.json',
    url_pagina: 'https://careauctions.co/ilive',
  });
}

/* --- 8. Fatti che NON si emettono (decisione dichiarata) ----------- */

function nonEmessiDichiarati() {
  nonEmesso(
    'aste-immobiliari-totale',
    'feed/indice.json espone immobiliari: 271623 ma non dichiara fonte, rilevazione né copertura, e il numero non si ricava per ' +
      'sottrazione (il totale comprende i mobiliari): non emesso finché il feed non dichiara fonte e copertura',
    'feed/indice.json',
  );
}

/* ------------------------------------------------------------------ *
 * Fixture di autotest: un fatto volutamente senza fonte
 * ------------------------------------------------------------------ */

function fixtureAutotest() {
  const ora = new Date().toISOString();
  const senzaFonte = {
    id: 'autotest-senza-fonte',
    frase:
      `Al ${dataIt(ora)} il controllo automatico verifica che un numero senza fonte non venga pubblicato. ` +
      `Rilevazione: ${rilevazioneIt(ora)}. Copertura: fixture di autotest, non destinata alla pubblicazione.`,
    valore: 1,
    unita: 'prova',
    fonte: '',
    url_fonte: '',
    rilevazione: ora,
    copertura: 'fixture di autotest, non destinata alla pubblicazione',
    coperturaFonte: 'fixture',
    feed: 'fixture/autotest.json',
    url_pagina: 'https://careauctions.co/fatti',
  };

  // Seconda fixture: lo scarto base → minima travestito da «sconto».
  const scontoMascherato = {
    id: 'autotest-sconto-scarto-base-minima',
    frase:
      `Al ${dataIt(ora)} lo sconto medio sui lotti è del 25%. Fonte: PVP — Portale delle Vendite Pubbliche. ` +
      `Rilevazione: ${rilevazioneIt(ora)}. Copertura: fixture di autotest.`,
    valore: 25,
    unita: '%',
    fonte: 'PVP — Portale delle Vendite Pubbliche',
    url_fonte: 'https://pvp.giustizia.it',
    rilevazione: ora,
    copertura: 'fixture di autotest: scarto prezzo base → offerta minima',
    coperturaFonte: 'fixture',
    feed: 'fixture/autotest.json',
    url_pagina: 'https://careauctions.co/fatti',
  };

  return [senzaFonte, scontoMascherato];
}

/* ------------------------------------------------------------------ *
 * Validazione: qui la regola morde
 * ------------------------------------------------------------------ */

const CAMPI_OBBLIGATORI = ['id', 'frase', 'valore', 'unita', 'fonte', 'url_fonte', 'rilevazione', 'copertura', 'feed', 'url_pagina'];

function validaFatto(f) {
  const guasti = [];

  for (const campo of CAMPI_OBBLIGATORI) {
    const valore = f[campo];
    if (valore === undefined || valore === null || String(valore).trim() === '') {
      guasti.push(`campo «${campo}» mancante o vuoto`);
    }
  }

  if (typeof f.valore !== 'number' || !Number.isFinite(f.valore)) guasti.push('valore non è un numero finito');
  if (typeof f.fonte === 'string' && f.fonte.trim() !== '' && !/Fonte:/.test(String(f.frase))) {
    guasti.push('la frase non contiene «Fonte:»');
  }

  if (typeof f.rilevazione === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(f.rilevazione) || Number.isNaN(Date.parse(f.rilevazione))) {
      guasti.push(`rilevazione non è un istante ISO 8601 con ora: «${f.rilevazione}»`);
    }
  }

  if (/\d/.test(String(f.frase)) && !/Fonte:\s*\S/.test(String(f.frase))) {
    guasti.push('la frase contiene una cifra e non dichiara la fonte');
  }

  if (/sconto/i.test(f.id)) {
    const contesto = `${f.fonte} ${f.copertura}`;
    if (!/omi|mercato|agenzia\s+delle\s+entrate/i.test(contesto)) {
      guasti.push(
        'il fatto si chiama «sconto» ma non dichiara un confronto di mercato OMI: se è lo scarto prezzo base → offerta minima ' +
          'va chiamato scarto_base_minima (è il pavimento legale del 25%)',
      );
    }
  }

  for (const campo of ['url_fonte', 'url_pagina']) {
    const valore = f[campo];
    if (typeof valore === 'string' && valore.trim() !== '' && !/^https?:\/\//.test(valore)) {
      guasti.push(`${campo} non è un URL http(s): «${valore}»`);
    }
  }

  return guasti;
}

/* ------------------------------------------------------------------ *
 * HTML statico + JSON-LD
 * ------------------------------------------------------------------ */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function costruisciHtml(fatti, generato) {
  const url = REGOLE.url || {};
  const pagina = url.paginaFatti || 'https://careauctions.co/fatti';
  const dati = url.datiJson || 'https://careauctions.co/ai/fatti.json';
  const pagineDati = Array.isArray(url.pagineDati) ? url.pagineDati : [];

  const dataset = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'Fatti citabili — i numeri delle aste giudiziarie italiane',
    description:
      'Ogni numero di questa pagina porta la sua fonte, la data di rilevazione e la copertura: una frase autosufficiente per riga, ' +
      'citabile da un assistente AI senza aprire altre pagine.',
    url: pagina,
    dateModified: generato,
    inLanguage: 'it-IT',
    isAccessibleForFree: true,
    creator: { '@type': 'Organization', name: 'CAReAuctions', url: 'https://careauctions.co' },
    license: 'https://careauctions.co/termini',
    variableMeasured: fatti.map((f) => ({
      '@type': 'PropertyValue',
      name: f.id,
      value: f.valore,
      unitText: f.unita,
    })),
    distribution: [
      {
        '@type': 'DataDownload',
        contentUrl: dati,
        encodingFormat: 'application/json',
        description: 'Gli stessi fatti in JSON, con schema dichiarato in regole/fatti.json',
      },
    ],
    citation: [...new Set(fatti.map((f) => f.fonte))].map((nome) => {
      const f0 = fatti.find((f) => f.fonte === nome);
      return { '@type': 'CreativeWork', name: nome, url: f0?.url_fonte };
    }),
  };

  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: fatti.map((f) => ({
      '@type': 'Question',
      name: f.domanda || `Che valore ha «${f.id}»?`,
      acceptedAnswer: { '@type': 'Answer', text: f.frase },
    })),
  };

  const righeFatti = fatti.map((f) => `<p class="fatto" id="${esc(f.id)}">${esc(f.frase)}</p>`).join('\n');

  const provenienzaFonti = [...new Set(fatti.map((f) => `${f.fonte} (${f.url_fonte})`))];

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fatti citabili — i numeri delle aste giudiziarie italiane | CAReAuctions</title>
<meta name="description" content="Ogni numero con fonte, data di rilevazione e copertura: una frase autosufficiente per riga, leggibile da una macchina.">
<link rel="canonical" href="${esc(pagina)}">
<link rel="alternate" type="application/json" href="${esc(dati)}">
<meta name="robots" content="index,follow,max-snippet:-1">
<meta name="care-canary" content="${esc(REGOLE.canary)}">
<meta property="article:modified_time" content="${esc(generato)}">
<script type="application/ld+json">${JSON.stringify(dataset)}</script>
<script type="application/ld+json">${JSON.stringify(faq)}</script>
<style>
:root{--inchiostro:#0F1E3A;--carta:#FBF9F4;--oro:#A2977E}
*{box-sizing:border-box}
body{margin:0;background:var(--carta);color:var(--inchiostro);font:400 18px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 1rem}
h1{font-size:1.9rem;line-height:1.25;font-weight:600;margin:0 0 .75rem}
.regola{font-size:1.05rem;margin:0 0 .5rem}
.datemodified,.canary{font:400 .8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#55617a;margin:0}
.fatto{border-left:3px solid var(--oro);padding:.55rem 0 .55rem .9rem;margin:1.1rem 0}
footer{max-width:46rem;margin:0 auto;padding:1.5rem 1.25rem 3rem;border-top:1px solid #ddd8cb}
footer p{margin:.4rem 0;font-size:.92rem;color:#3c4763}
footer a{color:var(--inchiostro)}
</style>
</head>
<body>
<main>
<h1>Fatti citabili: i numeri delle aste giudiziarie italiane</h1>
<p class="regola">Ogni numero di questa pagina porta la sua fonte, la data di rilevazione e la copertura: una frase per riga, autosufficiente, così una macchina può citarla senza aprire altro. Se un numero non ha fonte e copertura, non viene pubblicato.</p>
<p class="datemodified">dateModified: ${esc(generato)}</p>
<section id="fatti">
${righeFatti}
</section>
</main>
<footer>
<p class="provenienza">Provenienza del blocco: feed pubblici di CAReAuctions, citati una volta qui e nella frase di ogni fatto — ${esc(provenienzaFonti.join(' · '))}.</p>
<p class="link">Pagine dati: ${pagineDati.map((p) => `<a href="${esc(p.url)}">${esc(p.nome)}</a>`).join(' · ')} · <a href="${esc(dati)}">ai/fatti.json</a></p>
</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * Programma
 * ------------------------------------------------------------------ */

async function main() {
  await blocco('statistiche', derivaStatistiche);
  await blocco('tribunali', derivaTribunali);
  await blocco('careindex', derivaCareindex);
  await blocco('esiti-statistiche', derivaEsitiStatistiche);
  await blocco('confronto-mercato', derivaConfrontoMercato);
  await blocco('omi', derivaOmi);
  await blocco('lingue', derivaLingue);
  nonEmessiDichiarati();

  if (AUTOTEST) FATTI.push(...fixtureAutotest());

  // id duplicati = rifiuto (due fatti con lo stesso identificativo non sono citabili)
  const visti = new Set();
  const rifiutati = [];
  for (const fatto of FATTI) {
    const guasti = validaFatto(fatto);
    if (visti.has(fatto.id)) guasti.push(`id duplicato: «${fatto.id}»`);
    visti.add(fatto.id);
    if (guasti.length) rifiutati.push({ id: fatto.id, guasti, frase: fatto.frase });
  }

  if (rifiutati.length) {
    console.error('');
    console.error(`RIFIUTO: ${rifiutati.length} fatto/i non rispettano la regola «mai un numero senza fonte dichiarata».`);
    console.error('Nessun file è stato scritto: ai/fatti.json e fatti/index.html restano quelli di prima.');
    for (const r of rifiutati) {
      console.error(`  · ${r.id}`);
      for (const g of r.guasti) console.error(`      - ${g}`);
      if (AUTOTEST) console.error(`      frase: ${r.frase}`);
    }
    console.error('');
    process.exit(1);
  }

  if (!FATTI.length) {
    console.error('RIFIUTO: zero fatti emessi — non si pubblica una pagina vuota.');
    process.exit(1);
  }

  const generato = new Date().toISOString();
  const meta = {
    generato,
    canary: REGOLE.canary,
    regola: REGOLE.regola.testo,
    schema: 'regole/fatti.json#schemaFatto',
    versioneRegole: REGOLE.versione,
    totaleFatti: FATTI.length,
    pagina: REGOLE.url?.paginaFatti,
    datiJson: REGOLE.url?.datiJson,
    fontiUsate: [...new Set(FATTI.map((f) => f.fonte))],
    feedLetti: FEED_LETTI,
    copertureDichiarate: FATTI.filter((f) => f.coperturaFonte === 'regole-dichiarata').map((f) => ({
      id: f.id,
      motivo: 'la copertura viene da regole/fatti.json perché il feed non la dichiara',
    })),
    nonEmessi: NON_EMESSI,
  };

  const documento = { meta, fatti: FATTI };
  const html = costruisciHtml(FATTI, generato);

  mkdirSync(dirname(FILE_FATTI), { recursive: true });
  mkdirSync(dirname(FILE_PAGINA), { recursive: true });
  writeFileSync(FILE_FATTI, `${JSON.stringify(documento, null, 2)}\n`, 'utf8');
  writeFileSync(FILE_PAGINA, html, 'utf8');

  if (AUTOTEST) {
    // Non si arriva qui: le fixture devono essere rifiutate. Se ci si arriva, la regola non morde.
    console.error('AUTOTEST FALLITO: le fixture sono state accettate. La regola non morde.');
    process.exit(1);
  }

  console.log(`OK — ${FATTI.length} fatti emessi, ${NON_EMESSI.length} non emessi (motivo in meta.nonEmessi).`);
  console.log(`     ${FILE_FATTI}`);
  console.log(`     ${FILE_PAGINA}`);
  for (const n of NON_EMESSI) console.log(`     non emesso: ${n.id} — ${n.motivo.slice(0, 120)}…`);
}

main().catch((errore) => {
  if (errore instanceof Rifiuto) {
    console.error('');
    console.error(`RIFIUTO: ${errore.message}`);
    for (const dettaglio of errore.dettagli) console.error(`  · ${dettaglio}`);
    console.error('Nessun file scritto.');
    console.error('');
    process.exit(1);
  }
  console.error(`ERRORE: ${errore.stack || errore.message}`);
  process.exit(1);
});
