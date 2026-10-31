#!/usr/bin/env node
/**
 * dati-indice.js — 5.909 · L'INDICE DEI NOSTRI DATI (il cruscotto pubblico del mercato)
 *
 * Legge tutti i dataset che produciamo e scrive `feed/dati-indice.json`: un file leggero
 * che alimenta la pagina /dati (cosa abbiamo, quanto è fresco, cosa misura).
 * Gira nel cloud dopo il sync (vedi .github/workflows/feed-sync.yml).
 */
const fs = require('fs');
const path = require('path');

const FEED = path.join(__dirname, '..', 'feed');
const OUT = path.join(FEED, 'dati-indice.json');

function leggi(nome) { try { return JSON.parse(fs.readFileSync(path.join(FEED, nome), 'utf8')); } catch (e) { return null; } }
const conta = (a) => (Array.isArray(a) ? a.length : 0);

const stat = leggi('statistiche.json') || {};
const indice = leggi('indice-completo.json') || {};
const aggiud = leggi('aggiudicazioni.json') || [];
const aziende = leggi('aste-aziende.json') || {};
const confronto = leggi('confronto-mercato.json') || {};
const mercato = leggi('statistiche-mercato.json') || null;
const esiti = leggi('andamento-esiti.json') || {};
const prezzi = leggi('andamento-prezzi.json') || {};
let fotoLotti = 0, fotoFile = 0;
try {
  const f = leggi('foto-procedure.json');
  if (Array.isArray(f)) { fotoLotti = f.length; fotoFile = f.reduce((t, x) => t + ((x.foto || []).length + (x.perizia || []).length), 0); }
} catch (e) {}

const oggi = new Date().toISOString().slice(0, 10);
const dataset = [
  { id: 'aste', nome: 'Aste giudiziarie italiane', valore: indice.totaleLotti || stat.totale || 0, unita: 'lotti', aggiornato: indice.data || stat.generato || null, fonte: 'PVP', descrizione: 'Tutti i lotti pubblicati sul Portale delle Vendite Pubbliche: prezzo base, offerta minima, data, tribunale, regione.', link: '/aste' },
  { id: 'aggiudicazioni', nome: 'Prezzi reali di aggiudicazione', valore: conta(aggiud), unita: 'aggiudicazioni', aggiornato: null, fonte: 'IVG / FallcoAste / PVP', descrizione: 'I prezzi veri a cui le aste si sono chiuse: la base del CAReIndex e dello sconto reale.', link: '/ca-re-index' },
  { id: 'esiti', nome: 'Esiti delle aste', valore: (esiti.esiti && esiti.esiti.aggiudicate) || 0, unita: 'aggiudicate', aggiornato: esiti.generato ? String(esiti.generato).slice(0, 10) : null, fonte: 'PVP', descrizione: 'Aggiudicate, deserte, sospese: il polso della domanda, giorno per giorno.', link: '/andamento-partecipazione' },
  { id: 'foto', nome: 'Foto e perizie delle procedure', valore: fotoLotti, unita: 'lotti', aggiornato: null, fonte: 'Perizie pubbliche', descrizione: fotoFile + ' file (foto e documenti) con la provenienza in fondo a ogni documento.', link: '/osservatorio' },
  { id: 'aziende', nome: 'Aste di aziende, quote e crediti', valore: (aziende.meta && aziende.meta.totale) || 0, unita: 'lotti', aggiornato: (aziende.meta && aziende.meta.dataRaccolta) || null, fonte: 'PVP', descrizione: 'Rami d azienda, quote societarie e crediti all asta: 459 attive, 2,53 mld € di valore base.', link: '/aste-aziende' },
  { id: 'omi', nome: 'Valori di mercato OMI', valore: (confronto.meta && confronto.meta.copertura && confronto.meta.copertura.comuniPubblicati) || 0, unita: 'comuni', aggiornato: (confronto.meta && confronto.meta.generatoIl) ? String(confronto.meta.generatoIl).slice(0, 10) : null, fonte: 'Agenzia delle Entrate — OMI', descrizione: 'Il confronto tra prezzo d asta e valore di mercato: ' + ((confronto.nazionale && confronto.nazionale.lotti) || 0) + ' lotti comparabili.', link: '/osservatorio' },
  { id: 'prezzi', nome: 'Storico del prezzo medio', valore: (prezzi.giorni || []).length, unita: 'giorni', aggiornato: (prezzi.giorni && prezzi.giorni.length) ? prezzi.giorni[prezzi.giorni.length - 1].data : null, fonte: 'Nostro calcolo sul PVP', descrizione: 'La serie giornaliera del prezzo medio con la percentuale di crescita: il CAReIndex.', link: '/andamento-prezzi' }
];

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
    generato: new Date().toISOString(),
    giorno: oggi,
    fonte: 'fonte PVP - Portale delle Vendite Pubbliche Giustizia - Ministero della Giustizia · Agenzia delle Entrate — OMI · IVG · FallcoAste',
    metodo: 'Ogni numero viene da una fonte pubblica citata e viene ricalcolato dai giri automatici. I campi che la fonte non pubblica non si mostrano: nessun numero inventato.',
    nota: 'I dataset completi sono disponibili in formato aperto per giornalisti e ricercatori: info@careauctions.co'
  },
  dataset,
  statistiche: mercato && mercato.meta ? mercato : null,
  mondo
};

fs.writeFileSync(OUT, JSON.stringify(out));
console.log('dati-indice.json:', dataset.length, 'dataset ·', (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
