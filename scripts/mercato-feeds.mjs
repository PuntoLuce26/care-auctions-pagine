#!/usr/bin/env node
/** mercato-feeds.mjs — i due feed che chiudono la sezione Mercato.
 *  1) feed/aste-trend.json .............. la serie giornaliera delle aste (l'unica giornaliera)
 *  2) feed/confronto-aste-mercato.json .. per comune: prezzo aste vs OMI, sconto, liquidità, magazzino
 *  Fonti: PVP + fonti pubbliche (aste), Agenzia Entrate – OMI (valori e volumi). CC-BY 4.0.
 */
import fs from 'node:fs';

const BASE = 'https://careauctions.co/feed/';
const UA = { 'User-Agent': 'CARe-mercato' };
const leggi = async (f) => { const r = await fetch(BASE + f, { headers: UA }); if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); };
const r1 = (v, d = 1) => v === null || v === undefined || isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

// 13/11/2026 — FONTE PUBBLICA + DATA DI RILEVAZIONE.
// Questo script non raccoglie nulla: aggrega feed già raccolti. La fonte pubblica è quella dei
// dati di partenza (PVP per i lotti e i prezzi base, OMI per i valori di mercato e i volumi) e la
// rilevazione è l'istante VERO della raccolta che sta dentro gli ingressi — mai l'istante in cui
// gira questo script. Quando un ingresso non dichiara la sua rilevazione si scrive null e il motivo.
const FONTI = {
  pvp: { nome: 'Portale delle Vendite Pubbliche (Ministero della Giustizia)', url: 'https://pvp.giustizia.it', ruolo: "lotti e prezzi base d'asta" },
  omi: { nome: 'OMI — Agenzia delle Entrate', url: 'https://www1.agenziaentrate.gov.it/servizi/geopoi_omi/', ruolo: 'valori di mercato e volumi (NTN)' },
};
const FONTE_ASTE = [FONTI.pvp, FONTI.omi];

const [ap, cm, oc, rc] = await Promise.all([
  leggi('andamento-partecipazione.json'),
  leggi('confronto-mercato.json'),
  leggi('omi-comuni.json'),
  leggi('residenziale-comune.json').catch(() => null)
]);
const oggi = new Date().toISOString();

// 1) serie giornaliera delle aste
const giorni = (ap.giorni || []).map((g) => ({ data: g.data, aggiudicate: g.aggiudicate, deserte: g.deserte, sospese: g.sospese, totale: g.totale }));
// Rilevazione = `generato` di andamento-partecipazione.json: l'istante in cui la serie è stata
// ricalcolata da zero sui lotti del catalogo (il metodo è dichiarato dentro quel feed). L'ultimo
// giorno della serie è contato su quel catalogo: è quella la data della raccolta.
const rilevazioneTrend = (ap && ap.generato) || (ap && ap.meta && ap.meta.generatoIl) || null;
const asteTrend = {
  fonte: FONTI.pvp,
  rilevazione: rilevazioneTrend,
  meta: {
    titolo: 'Aste giudiziarie — giorno per giorno',
    fonte: FONTI.pvp,
    fonteTesto: 'PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia) e fonti pubbliche delle aste',
    rilevazione: rilevazioneTrend,
    rilevazioneOrigine: "feed/andamento-partecipazione.json · campo generato (serie ricalcolata da zero sui lotti del catalogo, un giorno per data d'asta)",
    rilevazioneMotivo: rilevazioneTrend ? null : 'andamento-partecipazione.json non dichiara generato: la data della raccolta non è tracciata, quindi non si inventa',
    licenza: 'dati pubblici, elaborazione CAReAuctions',
    granularita: 'giornaliera',
    generatoIl: oggi,
    nota: 'Il mercato libero non ha un dato giornaliero: questa è l\'unica serie giornaliera del progetto.',
    giorni: giorni.length,
    dal: giorni[0]?.data || null, al: giorni[giorni.length - 1]?.data || null
  },
  giorni
};
fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync('feed/aste-trend.json', JSON.stringify(asteTrend));
console.log('aste-trend.json · giorni:', giorni.length, '·', (fs.statSync('feed/aste-trend.json').size / 1024).toFixed(0), 'KB');

// 2) confronto per comune
const omi = new Map((oc.comuni || []).map((c) => [c.comune.toUpperCase(), c]));
const attivi = new Map(((rc && rc.comuni) || []).map((c) => [String(c.comune).toUpperCase(), c]));
const comuni = [];
for (const c of (cm.comuni || [])) {
  const o = omi.get(String(c.comune).toUpperCase());
  const asteMq = Number(c.prezzoMqMedio) || null;
  const mercatoMq = o && o.residenziale ? (Number(o.residenziale.mediano) || null) : null;
  const a = attivi.get(String(c.comune).toUpperCase());
  const lottiAttiviRes = a ? Number(a.residenziali) || null : null;
  const lotti = Number(c.lotti) || 0;
  const ntnRes = o ? (Number(o.ntnRes) || null) : null;
  comuni.push({
    istat: o ? o.istat : null,
    comune: c.comune,
    prov: c.provincia || (o ? o.prov : null),
    regione: o ? o.regione : null,
    prezzoMqAste: asteMq,
    prezzoMqMercato: mercatoMq,
    scontoPct: asteMq && mercatoMq ? r1((1 - asteMq / mercatoMq) * 100) : null,
    lottiAsta: lotti,
    lottiAttiviResidenziali: lottiAttiviRes,
    ntnRes: ntnRes,
    // 540 lotti su 37.293 compravendite = 1,4% del mercato: «anni di magazzino» arrotondato
    // a zero non dice niente, quindi si pubblica la QUOTA e i MESI, non gli anni.
    quotaAsteSuMercatoPct: ntnRes && lottiAttiviRes !== null ? r1((lottiAttiviRes / ntnRes) * 100, 2) : null,
    tempoAssorbimentoMesi: ntnRes && lottiAttiviRes ? r1((lottiAttiviRes / ntnRes) * 12, 2) : null
  });
}
comuni.sort((a, b) => (b.lottiAsta || 0) - (a.lottiAsta || 0));
// Rilevazione del confronto = la rilevazione del feed che porta i PREZZI (confronto-mercato.json),
// perché è su quei lotti che nasce lo sconto. Le altre due popolazioni hanno istanti propri e
// vengono dichiarati uno per uno: un solo istante per tutto il file sarebbe una data finta.
const rilevazioneConfronto = (cm && cm.meta && cm.meta.rilevazione) || (cm && cm.rilevazione) || null;
const confronto = {
  fonte: FONTE_ASTE,
  rilevazione: rilevazioneConfronto,
  meta: {
    titolo: 'Aste contro mercato libero, comune per comune',
    fonte: FONTE_ASTE,
    rilevazione: rilevazioneConfronto,
    rilevazioni: {
      prezziAste: rilevazioneConfronto,
      valoriOmi: { semestre: (oc.meta && oc.meta.semestreCorrente) || null, raccolta: (oc.meta && oc.meta.generatoIl) || null },
      lottiAttivi: (rc && rc.meta && rc.meta.generatoIl) || null,
    },
    rilevazioneMotivo: rilevazioneConfronto ? null : 'confronto-mercato.json (ingresso dei prezzi) non dichiara meta.rilevazione: la data della raccolta non è tracciata, quindi resta null',
    fonti: { valoriOmi: 'Agenzia delle Entrate – OMI (CC-BY 4.0)', prezziAste: 'PVP e fonti pubbliche, elaborazione CAReAuctions' },
    licenza: 'CC-BY 4.0 (dati OMI) · elaborazione CAReAuctions',
    semestreOmi: oc.meta?.semestreCorrente || null,
    annoVolumi: oc.meta?.annoVolumi || null,
    generatoIl: oggi,
    metodo: 'scontoPct = 1 − (prezzo €/m² delle nostre aste / mediana OMI residenziale del comune). quotaAsteSuMercatoPct = lotti ATTIVI residenziali in asta ÷ compravendite residenziali annue del comune (quanto pesano le aste sul mercato). tempoAssorbimentoMesi = quota × 12: quanti mesi di vendite servirebbero per smaltire i lotti attualmente in asta, al ritmo del mercato di oggi. Non è un termine OMI né ISTAT: è una nostra misura, e la formula è questa.',
    nota: 'Valori OMI pubblicati solo come statistica derivata (mediana per comune); il dato di zona resta interno.',
    // 11/11/2026 — DUE POPOLAZIONI, DICHIARATE. Lo sconto nasce dai lotti con superficie
    // (anche già venduti: servono i €/m²), la quota dai lotti ATTIVI. Non sono la stessa
    // popolazione: finché non si estrae la superficie anche per gli attivi, va scritto qui.
    popolazioni: {
      sconto: 'lotti residenziali CON superficie, anche non più in asta (servono i €/m² per il confronto con OMI)',
      quota: 'lotti residenziali ATTIVI con asta non ancora svolta (stock reale di oggi)',
      prezzoMqMercato: 'mediana OMI residenziale del comune, semestre ' + (oc.meta?.semestreCorrente || 'n/d'),
      allineamento: 'parziale: sconto e quota usano popolazioni diverse. Allineamento completo = estrarre la superficie anche per i lotti attivi.'
    },
    copertura: { comuni: comuni.length, conPrezzoAste: comuni.filter((x) => x.prezzoMqAste).length, conOmi: comuni.filter((x) => x.prezzoMqMercato).length, conVolumi: comuni.filter((x) => x.ntnRes).length }
  },
  comuni
};
fs.writeFileSync('feed/confronto-aste-mercato.json', JSON.stringify(confronto));
console.log('confronto-aste-mercato.json · comuni:', comuni.length, '·', (fs.statSync('feed/confronto-aste-mercato.json').size / 1024).toFixed(0), 'KB');
const roma = comuni.find((c) => c.comune === 'ROMA');
console.log('esempio ROMA:', JSON.stringify(roma));
