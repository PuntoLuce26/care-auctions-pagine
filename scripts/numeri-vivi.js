// scripts/numeri-vivi.js — 6.052 · i numeri delle cinque pagine, ognuno con fonte, data e stato
// Regola: un numero senza fonte tracciata non si pubblica. Se la fonte è ferma → stato "in verifica"
// e al posto del numero si mostra la dichiarazione (nota + data). Se non c'è → il campo non c'è.
'use strict';
const fs = require('fs');
const path = require('path');
const FEED = path.join(__dirname, '..', 'feed');
const leggi = (n) => { try { return JSON.parse(fs.readFileSync(path.join(FEED, n), 'utf8')); } catch (e) { return null; } };

const stat = leggi('statistiche.json') || {};
const indice = leggi('indice-completo.json') || {};
const confronto = leggi('confronto-mercato.json') || {};
const aggiud = leggi('aggiudicazioni.json') || [];
const monitor = leggi('esiti-monitor.json') || {};
const ril = stat.esitiUltimaRilevazione || null;

const dataIt = (iso) => { const a = String(iso || '').slice(0, 10).split('-'); return a.length === 3 ? a[2] + '/' + a[1] + '/' + a[0] : null; };
const n = (v, unita, fonte, rilevazione, stato, extra) => Object.assign({ numero: v, unita, fonte, rilevazione, stato }, extra || {});
const OK = 'ok', VER = 'in-verifica';

const pagine = {};

pagine['care-index'] = {
  numeri: {
    lotti: n(stat.totale, 'lotti', 'scripts/sync-feed.js → feed/statistiche.json', stat.aggiornato || null, OK),
    prezzoMedioImm: n(stat.prezzoMedioImm, '€', 'scripts/sync-feed.js → feed/statistiche.json (media dei prezzi base)', stat.aggiornato || null, OK),
    scartoBaseMinima: n(stat.scontoMedioImm, '%', 'scripts/sync-feed.js → feed/statistiche.json (media di scontoPct)', stat.aggiornato || null, OK, { nota: 'scarto prezzo base → offerta minima (pavimento legale 25%), non è uno sconto di mercato' }),
    bande: n(indice.bandePrezzo || null, 'fasce', 'scripts/sync-feed.js → feed/indice-completo.json', indice.data || null, OK),
  },
};

pagine['osservatorio'] = {
  numeri: {
    lotti: n(stat.totale, 'lotti', 'scripts/sync-feed.js → feed/statistiche.json', stat.aggiornato || null, OK),
    lottiComparabiliOmi: n((confronto.nazionale || {}).lotti, 'lotti', 'scripts/statistiche-mercato.js → feed/confronto-mercato.json', (confronto.meta || {}).generatoIl || null, OK, { copertura: ((confronto.meta || {}).copertura || {}) }),
    scontoOmiMediano: n((confronto.nazionale || {}).scontoMedianoPct, '%', 'scripts/statistiche-mercato.js → feed/confronto-mercato.json (mediana, solo lotti con mq e OMI)', (confronto.meta || {}).generatoIl || null, OK, { nota: 'sconto di mercato = 1 − (prezzo base/mq) / valore OMI; P25 ' + ((confronto.nazionale || {}).scontoP25Pct) + '% · P75 ' + ((confronto.nazionale || {}).scontoP75Pct) + '%' }),
    fotoPerizie: n((leggi('dati-indice.json') || {}).dataset ? ((leggi('dati-indice.json').dataset.find(d => d.id === 'foto') || {}).valore) : null, 'lotti', 'foto-perizie → feed/foto-procedure.json', null, VER, { nota: 'la data di rilevazione delle foto non è pubblicata: va dichiarata prima di mostrare il numero' }),
  },
};

pagine['aggiudicazioni'] = {
  numeri: {
    voci: n(aggiud.length, 'voci d archivio', 'write del 29/10 → feed/aggiudicazioni.json', '2026-10-28', VER, {
      nota: '3.145 fallcoaste con data e tribunale · 13.574 anivg senza data né tribunale · 52 notarili con id sintetici; gli id non sono collegabili ai lotti del PVP (1.233 su 16.771, 0 con tribunale coerente)',
    }),
  },
};

pagine['esiti'] = {
  numeri: {
    riepilogo: stat.esiti
      ? n(stat.esiti.aggiudicate, 'aggiudicate', 'feed/andamento-esiti.json', ril ? dataIt(ril.data) : null, OK)
      : n(null, 'aggiudicate', 'feed/andamento-esiti.json', ril ? dataIt(ril.data) : null, VER, { nota: (ril && ril.nota) || stat.esitiMotivo || 'rilevazione ferma' }),
    monitor: n((monitor.copertura || {}).esiti, 'esiti con prezzo', 'scripts/idmap-sitemap.js → feed/esiti-monitor.json (archivio fallco)', (monitor.copertura || {}).al || null, VER, {
      nota: 'copertura ' + ((monitor.copertura || {}).dal || '?') + ' → ' + ((monitor.copertura || {}).al || '?') + ' · ' + ((monitor.copertura || {}).tribunali || '?') + ' tribunali; il collegamento ai lotti non è dimostrato',
    }),
  },
};

pagine['idati'] = {
  numeri: {
    aste: n(stat.totale, 'lotti', 'feed/statistiche.json', stat.aggiornato || null, OK),
    aggiudicazioni: n(aggiud.length, 'voci', 'feed/aggiudicazioni.json', '2026-10-28', VER),
    esiti: n(stat.esiti ? stat.esiti.aggiudicate : null, 'aggiudicate', 'feed/andamento-esiti.json', ril ? dataIt(ril.data) : null, stat.esiti ? OK : VER, { nota: stat.esiti ? null : ((ril && ril.nota) || stat.esitiMotivo) }),
    omi: n(((confronto.meta || {}).copertura || {}).comuniPubblicati, 'comuni con confronto', 'feed/confronto-mercato.json', (confronto.meta || {}).generatoIl || null, OK, { nota: 'copertura: ' + ((confronto.meta || {}).copertura || {}).lottiConMq + ' lotti con mq su ' + ((confronto.meta || {}).copertura || {}).lottiResidenziali + ' residenziali' }),
  },
};

const out = {
  generato: new Date().toISOString(),
  regola: 'ogni numero ha fonte, rilevazione e stato; fonte ferma = "in verifica" con la dichiarazione al posto del numero; fonte assente = campo assente',
  pagine,
};
fs.writeFileSync(path.join(FEED, 'numeri-vivi.json'), JSON.stringify(out));
console.log('numeri-vivi.json:', Object.keys(pagine).length, 'pagine ·', (fs.statSync(path.join(FEED, 'numeri-vivi.json')).size / 1024).toFixed(1) + ' KB');
