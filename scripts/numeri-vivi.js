// scripts/numeri-vivi.js — 6.052 · i numeri delle cinque pagine, ognuno con fonte, data e stato
// Regola: un numero senza fonte tracciata non si pubblica. Se la fonte è ferma → stato "in verifica"
// e al posto del numero si mostra la dichiarazione (nota + data). Se non c'è → il campo non c'è.
// 13/11/2026 (figura sweep) — la `fonte` è il NOME PUBBLICO della sorgente, mai il percorso di un
// file o di uno script: "scripts/sync-feed.js → feed/statistiche.json" non è una fonte. Dove la
// sorgente pubblica unica non esiste, `fonte` è null e il numero è dichiarato `fonteMancante: true`:
// meglio un numero nascosto che un numero attribuito a un file.
'use strict';
const fs = require('fs');
const path = require('path');
const FEED = path.join(__dirname, '..', 'feed');
const leggi = (n) => { try { return JSON.parse(fs.readFileSync(path.join(FEED, n), 'utf8')); } catch (e) { return null; } };
const { FONTI_PUBBLICHE } = require('./feed-regole');

const stat = leggi('statistiche.json') || {};
const indice = leggi('indice-completo.json') || {};
const confronto = leggi('confronto-mercato.json') || {};
const aggiud = leggi('aggiudicazioni.json') || [];
const monitor = leggi('esiti-monitor.json') || {};
const andEsiti = leggi('andamento-esiti.json') || {};
const ril = stat.esitiUltimaRilevazione || null;

const dataIt = (iso) => { const a = String(iso || '').slice(0, 10).split('-'); return a.length === 3 ? a[2] + '/' + a[1] + '/' + a[0] : null; };
// fonte null → il campo resta null e si dichiara fonteMancante: true (nessuna attribuzione finta)
const n = (v, unita, fonte, rilevazione, stato, extra) => {
  const o = Object.assign({ numero: v, unita, fonte: fonte || null, rilevazione, stato }, extra || {});
  if (!fonte) o.fonteMancante = true;
  return o;
};
// la data degli esiti: se la rilevazione corrente è fresca, l'istante è quello del canone
// feed/andamento-esiti.json; se è vecchia, è la data della rilevazione dichiarata in stat.
const RIL_ESITI = ril ? dataIt(ril.data) : (stat.esiti && andEsiti.generato ? dataIt(andEsiti.generato) : null);
const OK = 'ok', VER = 'in-verifica';

// Nomi pubblici, una sola definizione (scripts/feed-regole.js · FONTI_PUBBLICHE).
const NOME_PVP = FONTI_PUBBLICHE.pvp.nome;
const NOME_OMI = FONTI_PUBBLICHE.omi.nome;
const NOME_PVP_OMI = NOME_PVP + ' · ' + NOME_OMI;

// L'archivio delle aggiudicazioni è un AGGREGATO: ogni record dichiara la sua fonte
// (fallcoaste | anivg | notarile-verona | ivg). Si nomina il portale pubblico solo se TUTTE le
// fonti presenti sono note; se ne compare una non mappata → null + fonteMancante, perché un
// archivio misto non si attribuisce a un solo portale.
const NOMI_PORTAI = {
  fallcoaste: 'FallcoAste',
  anivg: 'ANIVG',
  'notarile-verona': 'Notarile Verona',
  ivg: 'IVG (Istituti Vendite Giudiziarie)',
};
const fontiArchivio = (arr) => {
  const viste = [...new Set((arr || []).map((r) => String((r && r.fonte) || '').toLowerCase()).filter(Boolean))];
  if (!viste.length || viste.some((f) => !NOMI_PORTAI[f])) return null;
  return viste.map((f) => NOMI_PORTAI[f]).join(' · ');
};
const FONTE_ARCHIVIO = fontiArchivio(aggiud);

const pagine = {};

pagine['care-index'] = {
  numeri: {
    lotti: n(stat.totale, 'lotti', NOME_PVP, stat.aggiornato || null, OK),
    prezzoMedioImm: n(stat.prezzoMedioImm, '€', NOME_PVP, stat.aggiornato || null, OK, { nota: 'media dei prezzi base d asta del catalogo' }),
    bande: n(indice.bandePrezzo || null, 'fasce', NOME_PVP, indice.data || null, OK),
  },
};

pagine['osservatorio'] = {
  numeri: {
    lotti: n(stat.totale, 'lotti', NOME_PVP, stat.aggiornato || null, OK),
    lottiComparabiliOmi: n((confronto.nazionale || {}).lotti, 'lotti', NOME_PVP_OMI, (confronto.meta || {}).generatoIl || null, OK, { copertura: ((confronto.meta || {}).copertura || {}) }),
    scontoOmiMediano: n((confronto.nazionale || {}).scontoMedianoPct, '%', NOME_PVP_OMI, (confronto.meta || {}).generatoIl || null, OK, { nota: 'sconto di mercato = 1 − (prezzo base/mq) / valore OMI; mediana su ' + ((confronto.meta || {}).copertura || {}).lottiConMq + ' lotti confrontabili in ' + ((confronto.meta || {}).copertura || {}).comuniPubblicati + ' comuni; P25 ' + ((confronto.nazionale || {}).scontoP25Pct) + '% · P75 ' + ((confronto.nazionale || {}).scontoP75Pct) + '%' }),
    // catalogo foto costruito da più portali (FallcoAste, AstaGiudiziaria, IVG) + perizie PVP:
    // nessuna fonte pubblica unica → null + fonteMancante. Rilevazione non dichiarata.
    fotoPerizie: n((leggi('dati-indice.json') || {}).dataset ? ((leggi('dati-indice.json').dataset.find(d => d.id === 'foto') || {}).valore) : null, 'lotti', null, null, VER, { nota: 'catalogo foto da più portali (FallcoAste, AstaGiudiziaria, IVG) e perizie PVP: nessuna fonte pubblica unica dichiarabile; la data di rilevazione delle foto non è pubblicata' }),
  },
};

pagine['aggiudicazioni'] = {
  numeri: {
    voci: n(aggiud.length, 'voci d archivio', FONTE_ARCHIVIO, '2026-10-28', VER, {
      nota: 'archivio aggregato (ogni record dichiara la sua fonte) · 13.574 anivg senza data né tribunale · 52 notarili con id sintetici; gli id non sono collegabili ai lotti del PVP (1.233 su 16.771, 0 con tribunale coerente)',
    }),
  },
};

pagine['esiti'] = {
  numeri: {
    riepilogo: stat.esiti
      ? n(stat.esiti.aggiudicate, 'aggiudicate', NOME_PVP, RIL_ESITI, OK)
      : n(null, 'aggiudicate', NOME_PVP, RIL_ESITI, VER, { nota: (ril && ril.nota) || stat.esitiMotivo || 'rilevazione ferma' }),
    // esiti-monitor.json dichiara 'PVP' ma è costruito sui SOLI record con fonte 'fallcoaste'
    // (scripts/idmap-sitemap.js): attribuzione contraddittoria → numero nascosto finché non si chiarisce.
    monitor: n((monitor.copertura || {}).esiti, 'esiti con prezzo', null, (monitor.copertura || {}).al || null, VER, {
      nota: 'provenienza non univoca: feed esiti-monitor.json etichettato PVP ma costruito su record fallcoaste · copertura ' + ((monitor.copertura || {}).dal || '?') + ' → ' + ((monitor.copertura || {}).al || '?') + ' · ' + ((monitor.copertura || {}).tribunali || '?') + ' tribunali; il collegamento ai lotti non è dimostrato',
    }),
  },
};

pagine['idati'] = {
  numeri: {
    aste: n(stat.totale, 'lotti', NOME_PVP, stat.aggiornato || null, OK),
    aggiudicazioni: n(aggiud.length, 'voci', FONTE_ARCHIVIO, '2026-10-28', VER),
    esiti: n(stat.esiti ? stat.esiti.aggiudicate : null, 'aggiudicate', NOME_PVP, RIL_ESITI, stat.esiti ? OK : VER, { nota: stat.esiti ? null : ((ril && ril.nota) || stat.esitiMotivo) }),
    omi: n(((confronto.meta || {}).copertura || {}).comuniPubblicati, 'comuni con confronto', NOME_PVP_OMI, (confronto.meta || {}).generatoIl || null, OK, { nota: 'copertura: ' + ((confronto.meta || {}).copertura || {}).lottiConMq + ' lotti con mq su ' + ((confronto.meta || {}).copertura || {}).lottiResidenziali + ' residenziali' }),
  },
};

const out = {
  generato: new Date().toISOString(),
  regola: 'ogni numero ha fonte pubblica, rilevazione e stato; fonte ferma = "in verifica" con la dichiarazione al posto del numero; fonte pubblica assente = fonte null + fonteMancante: true (il numero non si mostra)',
  pagine,
};
fs.writeFileSync(path.join(FEED, 'numeri-vivi.json'), JSON.stringify(out));
console.log('numeri-vivi.json:', Object.keys(pagine).length, 'pagine ·', (fs.statSync(path.join(FEED, 'numeri-vivi.json')).size / 1024).toFixed(1) + ' KB');
