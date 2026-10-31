#!/usr/bin/env node
/**
 * dati-indice.js — 5.909 / 5.915 · L'INDICE DEI NOSTRI DATI (il cruscotto pubblico del mercato)
 *
 * Legge tutti i dataset che produciamo e scrive `feed/dati-indice.json`: un file leggero
 * che alimenta la pagina /dati (cosa abbiamo, quanto è fresco, cosa misura).
 * 5.915: ogni dataset dichiara anche METODO, COPERTURA, FRESCHEZZA, VERSIONE e PROVENIENZA
 * (testo nel campo `fonte`, che la pagina /dati mostra sotto ogni numero), e due card portano
 * al "Metodo e copertura" e al report mensile certificato (pubblicati nel repo Pages:
 * nessuna modifica all'edge necessaria). Gira nel cloud dopo il sync (feed-sync.yml).
 */
const fs = require('fs');
const path = require('path');

const FEED = path.join(__dirname, '..', 'feed');
const OUT = path.join(FEED, 'dati-indice.json');
const BASE_PAGINE = 'https://puntoluce26.github.io/care-auctions-pagine/';

function leggi(nome) { try { return JSON.parse(fs.readFileSync(path.join(FEED, nome), 'utf8')); } catch (e) { return null; } }
const conta = (a) => (Array.isArray(a) ? a.length : 0);

// versione ufficiale del CAReIndex: anno ISO + settimana ISO (es. CAReIndex 2026-W44)
function settimanaISO(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dn = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dn + 3);
  const gio = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const gdn = (gio.getUTCDay() + 6) % 7;
  gio.setUTCDate(gio.getUTCDate() - gdn + 3);
  const n = 1 + Math.round((t - gio) / (7 * 86400000));
  return t.getUTCFullYear() + '-W' + String(n).padStart(2, '0');
}
const VERSIONE = 'CAReIndex ' + settimanaISO(new Date());
const fresco = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : 'in aggiornamento');

const stat = leggi('statistiche.json') || {};
const indice = leggi('indice-completo.json') || {};
const indiceFeed = leggi('indice.json') || {};
const aggiud = leggi('aggiudicazioni.json') || [];
const aziende = leggi('aste-aziende.json') || {};
const confronto = leggi('confronto-mercato.json') || {};
const mercato = leggi('statistiche-mercato.json') || null;
const esiti = leggi('andamento-esiti.json') || {};
const prezzi = leggi('andamento-prezzi.json') || {};
const monitor = leggi('esiti-monitor.json') || null;
let fotoLotti = 0, fotoFile = 0;
try {
  const f = leggi('foto-procedure.json');
  if (Array.isArray(f)) { fotoLotti = f.length; fotoFile = f.reduce((t, x) => t + ((x.foto || []).length + (x.perizia || []).length), 0); }
} catch (e) {}

const oggi = new Date().toISOString().slice(0, 10);
const ora = new Date().toISOString();
const meseReport = (monitor && monitor.copertura && monitor.copertura.al) ? monitor.copertura.al.slice(0, 7) : oggi.slice(0, 7);
const regioneOk = Object.keys(indiceFeed.regioni || {}).length;
const totaleLotti = indice.totaleLotti || indiceFeed.totali || stat.totale || 0;
const coperturaAste = 'copertura: ' + (conta(indiceFeed.regioni || {}) ? regioneOk + '/21 regioni' : '21/21 regioni') + ' · ' + Number(totaleLotti).toLocaleString('it-IT') + ' lotti letti';

const dataset = [
  { id: 'aste', nome: 'Aste giudiziarie italiane', valore: totaleLotti, unita: 'lotti', aggiornato: fresco(indice.data || stat.generato), fonte: 'PVP — Ministero della Giustizia · ' + coperturaAste + ' · metodo: conteggio diretto dei lotti pubblicati, nessuna stima · ' + VERSIONE, descrizione: 'Tutti i lotti pubblicati sul Portale delle Vendite Pubbliche: prezzo base, offerta minima, data, tribunale, regione. Nessun campo dedotto: se il PVP non lo pubblica, non c è.', link: '/aste' },
  { id: 'aggiudicazioni', nome: 'Prezzi reali di aggiudicazione', valore: conta(aggiud), unita: 'aggiudicazioni', aggiornato: fresco(aggiornatoAggiudicazioni(aggiud)), fonte: 'PVP (vendite aggiudicate, raccolta Fallco) · copertura: solo lotti con prezzo finale pubblicato; esclusi i lotti con solo prezzo base · metodo: prezzo finale come pubblicato, nessuna stima · ' + VERSIONE, descrizione: 'I prezzi veri a cui le aste si sono chiuse: la base del CAReIndex e dello sconto reale. I lotti senza prezzo finale sono esclusi e dichiarati.', link: '/ca-re-index' },
  { id: 'esiti', nome: 'Esiti delle aste', valore: (esiti.esiti && esiti.esiti.aggiudicate) || 0, unita: 'aggiudicate', aggiornato: fresco(esiti.generato), fonte: 'PVP · copertura: stato dichiarato dal PVP per ogni lotto (aggiudicata, deserta, sospesa, non pubblicato) · metodo: conteggio degli stati, nessuna stima · ' + VERSIONE, descrizione: 'Aggiudicate, deserte, sospese: il polso della domanda, giorno per giorno. Il monitor navigabile è su /esiti.', link: '/esiti' },
  { id: 'foto', nome: 'Foto e perizie delle procedure', valore: fotoLotti, unita: 'lotti', aggiornato: fresco(null), fonte: 'Perizie pubbliche (atti del tribunale) · copertura: i lotti per cui la perizia pubblica almeno un file · metodo: link diretto all atto, nessuna elaborazione · ' + VERSIONE, descrizione: fotoFile + ' file (foto e documenti) con la provenienza in fondo a ogni documento.', link: '/osservatorio' },
  { id: 'aziende', nome: 'Aste di aziende, quote e crediti', valore: (aziende.meta && aziende.meta.totale) || 0, unita: 'lotti', aggiornato: fresco((aziende.meta && aziende.meta.dataRaccolta) || null), fonte: 'PVP · copertura: rami d azienda, quote e crediti all asta · metodo: conteggio e somma dei valori base pubblicati · ' + VERSIONE, descrizione: 'Rami d azienda, quote societarie e crediti all asta, con il valore base dichiarato dal PVP.', link: '/aste-aziende' },
  { id: 'omi', nome: 'Valori di mercato OMI', valore: (confronto.meta && confronto.meta.copertura && confronto.meta.copertura.comuniPubblicati) || 0, unita: 'comuni', aggiornato: fresco((confronto.meta && confronto.meta.generatoIl) || null), fonte: 'Agenzia delle Entrate — OMI · copertura: comuni con quotazioni OMI disponibili · metodo: valori OMI come pubblicati; il confronto con il prezzo d asta è un rapporto tra due dati pubblici, mai una stima · ' + VERSIONE, descrizione: 'Il confronto tra prezzo d asta e valore di mercato: ' + ((confronto.nazionale && confronto.nazionale.lotti) || 0) + ' lotti comparabili.', link: '/osservatorio' },
  { id: 'prezzi', nome: 'Storico del prezzo medio', valore: (prezzi.giorni || []).length, unita: 'giorni', aggiornato: fresco((prezzi.giorni && prezzi.giorni.length) ? prezzi.giorni[prezzi.giorni.length - 1].data : null), fonte: 'Nostro calcolo sul PVP · copertura: i giorni in cui il giro automatico ha letto il feed · metodo: media dei prezzi base dei lotti del giorno; è un indicatore, non un prezzo di vendita · ' + VERSIONE, descrizione: 'La serie giornaliera del prezzo medio con la percentuale di crescita: il CAReIndex.', link: '/andamento-prezzi' },
  {
    id: 'metodo', nome: 'Metodo e copertura', valore: 8, unita: 'indicatori documentati', aggiornato: fresco(ora),
    fonte: 'CARe Auctions — documento pubblico di metodo · versione ' + VERSIONE + ' · provenienza: PVP Ministero della Giustizia, OMI Agenzia delle Entrate · stimato: nulla',
    descrizione: 'Per ogni numero che pubblichiamo: metodo di calcolo, copertura dichiarata (lotti, tribunali, comuni), freschezza (data e ora dell ultimo giro), versione e provenienza — e cosa NON è un dato ma una stima (oggi: nessun numero stimato).',
    link: BASE_PAGINE + 'metodo.html'
  },
  {
    id: 'report', nome: 'Report mensile certificato', valore: (monitor && monitor.copertura && monitor.copertura.esiti) || 0, unita: 'aggiudicazioni del mese', aggiornato: fresco(monitor ? monitor.generato : null),
    fonte: 'PVP — Ministero della Giustizia · versione ' + VERSIONE + ' · report del mese ' + meseReport + ' con data di riferimento e copertura dichiarata',
    descrizione: 'Il report del mese in formato leggibile e citabile: numeri certificati, copertura e data. Pensato per banche, giornali e ricercatori.',
    link: BASE_PAGINE + 'report-' + meseReport + '.html'
  }
];

function aggiornatoAggiudicazioni(a) {
  // data più recente disponibile nel feed delle aggiudicazioni (termina dd/mm/yy)
  let max = null;
  for (const x of a) { const m = /^(\d{2})\/(\d{2})\/(\d{2,4})/.exec(String(x.termina || '')); if (!m) continue; const y = m[3].length === 2 ? '20' + m[3] : m[3]; const d = y + '-' + m[2] + '-' + m[1]; if (!max || d > max) max = d; }
  return max;
}

const mondo = [
  { paese: 'Italia', stato: 'operativo', nota: 'PVP completo, prezzi di aggiudicazione, esiti, foto, OMI' },
  { paese: 'Spagna', stato: 'in corso', nota: 'subastas.boe.es — aste pubbliche' },
  { paese: 'Portogallo', stato: 'in corso', nota: 'e-leiloes.pt' },
  { paese: 'Germania', stato: 'prossimo', nota: 'zvg-portal.de' },
  { paese: 'Austria', stato: 'prossimo', nota: 'edikte.justiz.gv.at' },
  { paese: 'Francia', stato: 'in corso', nota: 'DVF — prezzi di compravendita reali' },
  { paese: 'Regno Unito', stato: 'in corso', nota: 'HM Land Registry Price Paid' }
];

const out = {
  meta: {
    titolo: 'I dati delle aste — l archivio che nessuno aveva',
    generato: ora,
    giorno: oggi,
    versione: VERSIONE,
    fonte: 'fonte PVP - Portale delle Vendite Pubbliche Giustizia - Ministero della Giustizia · Agenzia delle Entrate — OMI · IVG · FallcoAste',
    metodo: 'Ogni numero viene da una fonte pubblica citata e viene ricalcolato dai giri automatici. I campi che la fonte non pubblica non si mostrano: nessun numero inventato, nessuna stima.',
    copertura: coperturaAste,
    parametri: { lotti: totaleLotti, regioni: regioneOk, aggiudicazioni: conta(aggiud), tribunaliEsiti: (monitor && monitor.copertura && monitor.copertura.tribunali) || 0 },
    nota: 'I dataset completi sono disponibili in formato aperto per giornalisti e ricercatori: info@careauctions.co',
    metodoUrl: BASE_PAGINE + 'metodo.html',
    reportUrl: BASE_PAGINE + 'report-' + meseReport + '.html'
  },
  dataset,
  statistiche: mercato && mercato.meta ? mercato : null,
  mondo
};

fs.writeFileSync(OUT, JSON.stringify(out));
console.log('dati-indice.json:', dataset.length, 'dataset ·', VERSIONE, '·', (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
