#!/usr/bin/env node
/** visite-report.js — il software che guarda il sito e ne parla due volte al giorno.
 *  Misura: visite e pagine viste (Cloudflare Web Analytics via worker icare-ai, azione visite-rum),
 *  calcola le DOPPIE percentuali (vs report precedente e vs giorno prima), aggiorna il valore
 *  costruito e la proiezione a 5 anni, scrive visite/stato.json + visite/QUADRO.md e manda l'email. */
const fs = require('fs');
const path = require('path');
const K = process.env.REGIA_KEY || '';
const WORKER = 'https://icare-ai.misty-mode-1cbc.workers.dev';
const DIR = path.join(process.cwd(), 'visite');
const STATO = path.join(DIR, 'stato.json');
const QUADRO = path.join(DIR, 'QUADRO.md');

// ---- parametri del valore (si toccano qui, non nel codice sparso) ----
const VAL = {
  ricostruzione: { ore: 1400, tariffa: 45, software: 63000, dati: 12000, brand: 6000, totale: 81000 },
  debiti: { finanziamentoSoci: 1000, klarna: 50.31, totale: 1050.31 },
  prezzi: { icare: 179, ishop: 129, ipartner: 799, successFeeMedia: 3000 },
  scenari: {
    prudente: { icare: 200, ishop: 40, ipartner: 4, pratiche: 12, multiplo: 3 },
    base: { icare: 500, ishop: 150, ipartner: 10, pratiche: 36, multiplo: 3 },
    ottimista: { icare: 1200, ishop: 400, ipartner: 25, pratiche: 72, multiplo: 4 },
  },
};
// ---- avanzamento dei lavori (percentuali dichiarate, aggiornate a mano quando si chiude un blocco) ----
const LAVORI = [
  ['Piattaforma CAReAuctions (aste, iCARe, iDati)', 92],
  ['Feed dati (321k lotti, 22 software cloud)', 95],
  ['SEO Italia (A chiuso, B in corso)', 55],
  ['SEO mondo (8 lingue, C avviata)', 20],
  ['iShop (struttura Emergent, dati e link nostri)', 35],
  ['Affiliazioni (programmi, /vai, click)', 40],
  ['Pagamenti e abbonamenti', 55],
  ['Automazioni e QA (cloud, 2 report/giorno)', 85],
  ['Secondo Cervello e memoria', 90],
  ['Marchi e affidabilità legale', 60],
];

const pct = (a, b) => (b ? Math.round((a - b) / b * 1000) / 10 : null);
const nf = (n) => Number(n || 0).toLocaleString('it-IT');
const pctTxt = (v) => (v === null ? 'n/d' : (v > 0 ? '+' : '') + v.toLocaleString('it-IT') + '%');
const oraLocale = () => new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

async function rum() {
  const r = await fetch(WORKER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ azione: 'visite-rum', chiave: K }) });
  const j = await r.json();
  return (j && j.dati) || null;
}

function leggiStato() { try { return JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (e) { return null; } }

function valutazione() {
  const v = VAL;
  const costo = v.ricostruzione.totale;
  const societa = Math.round((costo - v.debiti.totale) * 100) / 100;
  const scen = {};
  for (const [nome, s] of Object.entries(v.scenari)) {
    const ricavo = s.icare * v.prezzi.icare + s.ishop * v.prezzi.ishop + s.ipartner * v.prezzi.ipartner + s.pratiche * v.prezzi.successFeeMedia;
    scen[nome] = { ricavoAnno5: ricavo, multiplo: s.multiplo, valore: ricavo * s.multiplo };
  }
  return { metodo: 'costo di ricostruzione per il costruito; scenari di ricavo ×3-4 per la proiezione a 5 anni (assunzioni dichiarate, non promesse)', costoRicostruzione: costo, debiti: v.debiti.totale, valoreSocietaOggi: societa, scenari5Anni: scen };
}

(async () => {
  if (!K) { console.error('REGIA_KEY assente'); process.exit(1); }
  const dati = await rum();
  if (!dati || !dati.giorni) { console.error('RUM non leggibile'); process.exit(1); }
  const giorni = dati.giorni || {};
  const chiavi = Object.keys(giorni).sort();
  const ultimo = chiavi[chiavi.length - 1] || null;
  const ieri = chiavi[chiavi.length - 2] || null;
  const pvOggi = ultimo ? (giorni[ultimo].pv || 0) : 0;
  const viOggi = ultimo ? (giorni[ultimo].visite || 0) : 0;
  const pvIeri = ieri ? (giorni[ieri].pv || 0) : 0;
  const viIeri = ieri ? (giorni[ieri].visite || 0) : 0;
  const ultimi7 = chiavi.slice(-7);
  const media7 = ultimi7.length ? Math.round(ultimi7.reduce((s, k) => s + (giorni[k].pv || 0), 0) / ultimi7.length) : 0;
  const prec = leggiStato();
  const reportPrec = prec && prec.ultimoReport ? prec.ultimoReport : null;
  const report = {
    quando: new Date().toISOString(),
    giorno: ultimo,
    pv: pvOggi, visite: viOggi,
    totalePv: dati.totale ? dati.totale.pv : null,
    totaleVisite: dati.totale ? dati.totale.visite : null,
    giorniMisurati: chiavi.length,
    pvIeri: pvIeri, visiteIeri: viIeri,
    vsGiornoPrima: { pv: pct(pvOggi, pvIeri), visite: pct(viOggi, viIeri) },
    vsReportPrecedente: reportPrec ? { pv: pct(pvOggi, reportPrec.pv), visite: pct(viOggi, reportPrec.visite) } : { pv: null, visite: null },
    media7: media7,
    valutazione: valutazione(),
    lavori: LAVORI,
    fonte: 'Cloudflare Web Analytics (RUM)',
  };
  const storico = ((prec && prec.report) || []).concat([report]).slice(-60);
  const nuovo = { aggiornato: new Date().toISOString(), ultimoReport: report, report: storico };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATO, JSON.stringify(nuovo, null, 1));

  const V = report.valutazione;
  const righe = [];
  righe.push('CARe — rapporto visite · ' + oraLocale());
  righe.push('');
  righe.push('VISITE (Cloudflare RUM, ' + chiavi.length + ' giorni misurati)');
  righe.push('- Ultimo giorno (' + ultimo + '): ' + nf(pvOggi) + ' pagine viste · ' + nf(viOggi) + ' visite');
  righe.push('- Doppia percentuale: vs giorno prima ' + pctTxt(report.vsGiornoPrima.pv) + ' · vs report precedente ' + pctTxt(report.vsReportPrecedente.pv));
  righe.push('- Totale cumulato: ' + nf(report.totalePv) + ' pagine viste · ' + nf(report.totaleVisite) + ' visite');
  righe.push('- Media ultimi 7 giorni: ' + nf(media7) + ' pagine viste/giorno');
  righe.push('');
  righe.push('VALORE');
  righe.push('- Costruito (costo di ricostruzione): ' + nf(V.costoRicostruzione) + ' EUR');
  righe.push('- Società oggi (patrimoniale, debiti ' + nf(V.debiti) + '): ' + nf(V.valoreSocietaOggi) + ' EUR');
  for (const [k, s] of Object.entries(V.scenari5Anni)) righe.push('- 5 anni · ' + k + ': ricavo anno 5 ' + nf(s.ricavoAnno5) + ' EUR · valore ' + nf(s.valore) + ' EUR (×' + s.multiplo + ')');
  righe.push('');
  righe.push('AVANZAMENTO');
  for (const [n, p] of LAVORI) righe.push('- ' + n + ': ' + p + '%');
  const mediaLav = Math.round(LAVORI.reduce((s, x) => s + x[1], 0) / LAVORI.length * 10) / 10;
  righe.push('- Media complessiva: ' + mediaLav + '%');
  righe.push('');
  righe.push('— rapporto automatico CARe (cloud, due volte al giorno)');
  const body = righe.join('\n');
  fs.writeFileSync(QUADRO, body + '\n');
  console.log(body);

  const CID = process.env.GMAIL_CLIENT_ID, CSEC = process.env.GMAIL_CLIENT_SECRET, RT = process.env.GMAIL_REFRESH_TOKEN;
  if (CID && CSEC && RT) {
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: CID, client_secret: CSEC, refresh_token: RT, grant_type: 'refresh_token' }) });
    const tj = await tr.json();
    if (!tr.ok) { console.error('refresh fallito:', tj.error); process.exit(1); }
    const H = { Authorization: 'Bearer ' + tj.access_token };
    const prof = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: H })).json();
    const subject = 'CARe — visite ' + nf(pvOggi) + ' pv (vs ieri ' + pctTxt(report.vsGiornoPrima.pv) + ', vs report ' + pctTxt(report.vsReportPrecedente.pv) + ')';
    const mime = ['From: ' + prof.emailAddress, 'To: ' + (process.env.MAIL_TO || prof.emailAddress),
      'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=',
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n');
    const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const s = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ raw }) })).json();
    console.log(s.id ? 'EMAIL INVIATA · id ' + s.id : 'invio fallito: ' + JSON.stringify(s));
  } else {
    console.log('(secret Gmail assenti: rapporto scritto in visite/QUADRO.md)');
  }
})().catch((e) => { console.error('errore:', e && e.message); process.exit(1); });
