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

const [ap, cm, oc] = await Promise.all([
  leggi('andamento-partecipazione.json'),
  leggi('confronto-mercato.json'),
  leggi('omi-comuni.json')
]);
const oggi = new Date().toISOString();

// 1) serie giornaliera delle aste
const giorni = (ap.giorni || []).map((g) => ({ data: g.data, aggiudicate: g.aggiudicate, deserte: g.deserte, sospese: g.sospese, totale: g.totale }));
const asteTrend = {
  meta: {
    titolo: 'Aste giudiziarie — giorno per giorno',
    fonte: 'PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia) e fonti pubbliche delle aste',
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
const comuni = [];
for (const c of (cm.comuni || [])) {
  const o = omi.get(String(c.comune).toUpperCase());
  const asteMq = Number(c.prezzoMqMedio) || null;
  const mercatoMq = o && o.residenziale ? (Number(o.residenziale.mediano) || null) : null;
  const lotti = Number(c.lotti) || 0;
  const ntnRes = o ? (Number(o.ntnRes) || null) : null;
  comuni.push({
    comune: c.comune,
    prov: c.provincia || (o ? o.prov : null),
    regione: o ? o.regione : null,
    prezzoMqAste: asteMq,
    prezzoMqMercato: mercatoMq,
    scontoPct: asteMq && mercatoMq ? r1((1 - asteMq / mercatoMq) * 100) : null,
    lottiAsta: lotti,
    ntnRes: ntnRes,
    // 540 lotti su 37.293 compravendite = 1,4% del mercato: «anni di magazzino» arrotondato
    // a zero non dice niente, quindi si pubblica la QUOTA e i MESI, non gli anni.
    quotaAsteSuMercatoPct: ntnRes ? r1((lotti / ntnRes) * 100, 2) : null,
    mesiMagazzino: ntnRes && lotti ? r1((lotti / ntnRes) * 12, 1) : null
  });
}
comuni.sort((a, b) => (b.lottiAsta || 0) - (a.lottiAsta || 0));
const confronto = {
  meta: {
    titolo: 'Aste contro mercato libero, comune per comune',
    fonti: { valoriOmi: 'Agenzia delle Entrate – OMI (CC-BY 4.0)', prezziAste: 'PVP e fonti pubbliche, elaborazione CAReAuctions' },
    licenza: 'CC-BY 4.0 (dati OMI) · elaborazione CAReAuctions',
    semestreOmi: oc.meta?.semestreCorrente || null,
    annoVolumi: oc.meta?.annoVolumi || null,
    generatoIl: oggi,
    metodo: 'scontoPct = 1 − (prezzo €/m² delle nostre aste / mediana OMI residenziale del comune). quotaAsteSuMercatoPct = lotti in asta ÷ NTN residenziale annuo (quanto pesano le aste); mesiMagazzino = quota × 12.',
    nota: 'Valori OMI pubblicati solo come statistica derivata (mediana per comune); il dato di zona resta interno.',
    copertura: { comuni: comuni.length, conPrezzoAste: comuni.filter((x) => x.prezzoMqAste).length, conOmi: comuni.filter((x) => x.prezzoMqMercato).length, conVolumi: comuni.filter((x) => x.ntnRes).length }
  },
  comuni
};
fs.writeFileSync('feed/confronto-aste-mercato.json', JSON.stringify(confronto));
console.log('confronto-aste-mercato.json · comuni:', comuni.length, '·', (fs.statSync('feed/confronto-aste-mercato.json').size / 1024).toFixed(0), 'KB');
const roma = comuni.find((c) => c.comune === 'ROMA');
console.log('esempio ROMA:', JSON.stringify(roma));
