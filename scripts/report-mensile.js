#!/usr/bin/env node
/**
 * report-mensile.js — 5.915 · IL REPORT MENSILE CERTIFICATO (citabile da banche e giornali)
 *
 * Legge i nostri dataset e scrive nel repo due file per il mese di riferimento:
 *   report-YYYY-MM.json   i numeri, la versione, la copertura, le fonti, cosa è stimato
 *   report-YYYY-MM.html   lo stesso report in pagina leggibile e citabile
 * Mese di riferimento: l'ultimo mese con esiti pubblicati (feed/esiti-monitor.json).
 * Gira nel cloud una volta al giorno (feed-sync.yml, ore 02 UTC). Nessuna modifica all'edge:
 * la pagina è pubblicata su GitHub Pages e linkata da /dati.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FEED = path.join(ROOT, 'feed');
const leggi = (n) => { try { return JSON.parse(fs.readFileSync(path.join(FEED, n), 'utf8')); } catch (e) { return null; } };

function settimanaISO(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dn = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dn + 3);
  const g = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); const gd = (g.getUTCDay() + 6) % 7; g.setUTCDate(g.getUTCDate() - gd + 3);
  return t.getUTCFullYear() + '-W' + String(1 + Math.round((t - g) / (7 * 86400000))).padStart(2, '0');
}
const num = (v) => Number(v || 0).toLocaleString('it-IT');
const eur = (v) => '€ ' + Math.round(Number(v || 0)).toLocaleString('it-IT');
const meseIt = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

const monitor = leggi('esiti-monitor.json');
const mercato = leggi('statistiche-mercato.json');
const stat = leggi('statistiche.json') || {};
const esiti = leggi('andamento-esiti.json') || {};
const dati = leggi('dati-indice.json') || {};
const indice = leggi('indice.json') || {};

if (!monitor || !monitor.copertura || !monitor.giorni) {
  console.error('report mensile: esiti-monitor.json assente — niente report');
  process.exit(0);
}

const rif = monitor.copertura.al || new Date().toISOString().slice(0, 10);
const mese = rif.slice(0, 7);
const [anno, mm] = mese.split('-').map(Number);
const etichetta = meseIt[mm - 1] + ' ' + anno;
const versione = 'CAReIndex ' + settimanaISO(new Date(rif + 'T12:00:00Z'));

// aggrega il mese dagli shard giorno x tribunale del monitor esiti
let n = 0, incasso = 0;
const perTrib = new Map(), perGiorno = new Map();
for (const [d, celle] of monitor.giorni) {
  if (d.slice(0, 7) !== mese) continue;
  for (const c of celle) {
    const nome = c[0] >= 0 ? monitor.tribunali[c[0]][0] : 'Non indicato';
    const nn = Number(c[1]) || 0, ss = Number(c[2]) || 0;
    n += nn; incasso += ss;
    perTrib.set(nome, (perTrib.get(nome) || { n: 0, s: 0 }));
    const t = perTrib.get(nome); t.n += nn; t.s += ss;
    perGiorno.set(d, (perGiorno.get(d) || 0) + nn);
  }
}
const medio = n ? incasso / n : 0;
const tribOrdinati = [...perTrib.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, 10).map(([nome, v]) => ({ tribunale: nome, esiti: v.n, incasso: Math.round(v.s), medio: Math.round(v.s / (v.n || 1)) }));
const giorniOrdinati = [...perGiorno.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, q]) => ({ giorno: d, esiti: q }));
const settimane = {};
for (const g of giorniOrdinati) { const s = settimanaISO(new Date(g.giorno + 'T12:00:00Z')); settimane[s] = (settimane[s] || 0) + g.esiti; }

const sn = (mercato && mercato.sconto && mercato.sconto.nazionale) || null;
const rap = {
  versione,
  mese,
  etichetta,
  dataRiferimento: rif,
  generato: new Date().toISOString(),
  fonte: 'PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia) · Agenzia delle Entrate — OMI',
  metodo: 'Aggiudicazioni: solo vendite aggiudicate con prezzo finale pubblicato, sommate per data di vendita; nessun prezzo ricostruito. Sconto: mediana del ribasso tra prezzo base e offerta minima pubblicati sul medesimo lotto. Esiti: stati dichiarati dal PVP.',
  stimato: 'nulla: ogni numero è un conteggio o un rapporto tra dati pubblicati',
  copertura: {
    esitiNelMese: n,
    tribunaliNelMese: perTrib.size,
    giorniConEsiti: giorniOrdinati.length,
    tribunaliTotaliArchivio: monitor.copertura.tribunali || 0,
    coperturaArchivio: { dal: monitor.copertura.dal, al: monitor.copertura.al, giorni: monitor.copertura.giorni },
    esclusi: monitor.esclusi || {},
    lottiAttivi: indice.totali || stat.totale || 0,
    esitiMercato: esiti.esiti || {},
    scontoMedioNazionale: sn ? { medio: sn.medio, mediano: sn.mediano, lotti: sn.lotti } : null
  },
  kpi: { aggiudicazioni: n, incasso: Math.round(incasso), prezzoMedio: Math.round(medio), tribunali: perTrib.size },
  settimane,
  topTribunali: tribOrdinati,
  giorni: giorniOrdinati
};

const outJson = 'report-' + mese + '.json';
const outHtml = 'report-' + mese + '.html';
fs.writeFileSync(path.join(ROOT, outJson), JSON.stringify(rap, null, 1));

const righeTrib = tribOrdinati.map((t) => '<tr><td>' + t.tribunale + '</td><td class="n">' + num(t.esiti) + '</td><td class="n">' + eur(t.incasso) + '</td><td class="n">' + eur(t.medio) + '</td></tr>').join('');
const righeSett = Object.entries(settimane).sort().map(([s, q]) => '<tr><td>' + s + '</td><td class="n">' + num(q) + '</td></tr>').join('');
const righeGiorni = giorniOrdinati.map((g) => '<tr><td>' + g.giorno.split('-').reverse().join('/') + '</td><td class="n">' + num(g.esiti) + '</td></tr>').join('');
const es = esiti.esiti || {};
const html = '<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Report mensile ' + etichetta + ' — versione ' + versione + ' | CARe Auctions</title><meta name="description" content="Report mensile certificato del mercato delle aste giudiziarie italiane: ' + num(n) + ' aggiudicazioni, ' + eur(incasso) + ' di incasso, ' + perTrib.size + ' tribunali. Versione ' + versione + ', copertura e fonti dichiarate. PVP Ministero della Giustizia."><link rel="canonical" href="https://puntoluce26.github.io/care-auctions-pagine/' + outHtml + '"><link rel="alternate" hreflang="it" href="https://puntoluce26.github.io/care-auctions-pagine/' + outHtml + '"><link rel="alternate" hreflang="x-default" href="https://puntoluce26.github.io/care-auctions-pagine/' + outHtml + '"><style>' +
'body{margin:0;background:#F4F1EA;color:#0F1E3A;font-family:-apple-system,system-ui,sans-serif;line-height:1.6}.top{background:#0F1E3A;color:#F4F1EA;padding:14px 18px;font-weight:600}.wrap{max-width:900px;margin:34px auto;padding:0 18px}h1{font-size:30px;line-height:1.15;margin:6px 0 8px}h2{color:#A8811F;margin-top:32px;font-size:19px}.lead{font-size:17px;color:#3C4A65}.cert{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:18px 0}.card{border:1px solid #E3D9C0;border-radius:14px;padding:15px 17px;background:#fff}.card .num{font-size:24px;font-weight:650}.card .lab{font-size:11px;text-transform:uppercase;letter-spacing:.11em;color:#6B7690;margin:2px 0 5px}.card .sub{font-size:12px;color:#7A839A}table{width:100%;border-collapse:collapse;font-size:13.5px;background:#fff;border:1px solid #E3D9C0;border-radius:12px;overflow:hidden;margin-top:8px}th,td{padding:8px 10px;border-bottom:1px solid #EFE7D2;text-align:left}th{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:#6B7690;background:#FBF8F1}td.n,th.n{text-align:right}.ver{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.nota{font-size:12.5px;color:#5A6A85;margin-top:24px;border-top:1px solid #E3D9C0;padding-top:12px}.src{font-size:12px;color:#7A839A}a{color:#0F1E3A}@media print{.top{background:#fff;color:#0F1E3A}}' +
'</style></head><body><div class="top">CARe Auctions — report mensile certificato</div><div class="wrap">' +
'<h1>Report mensile — ' + etichetta + '</h1><p class="lead">I numeri del mese delle aste giudiziarie italiane, con copertura, metodo e versione dichiarati. Citabile con la versione <span class="ver">' + versione + '</span>.</p>' +
'<div class="cert"><div class="card"><div class="lab">Versione</div><div class="num ver">' + versione + '</div><div class="sub">mese ' + mese + ' · riferimento ' + rif + '</div></div>' +
'<div class="card"><div class="lab">Aggiudicazioni</div><div class="num">' + num(n) + '</div><div class="sub">con prezzo finale pubblicato</div></div>' +
'<div class="card"><div class="lab">Incasso del mese</div><div class="num">' + eur(incasso) + '</div><div class="sub">somma dei prezzi finali</div></div>' +
'<div class="card"><div class="lab">Prezzo medio</div><div class="num">' + eur(medio) + '</div><div class="sub">media delle aggiudicazioni</div></div>' +
'<div class="card"><div class="lab">Tribunali</div><div class="num">' + num(perTrib.size) + '</div><div class="sub">con almeno un esito nel mese</div></div></div>' +
'<h2>Copertura</h2><p class="lead">' + num(n) + ' aggiudicazioni su <strong>' + num(perTrib.size) + ' tribunali</strong> e <strong>' + giorniOrdinati.length + ' giorni</strong> con esiti. Archivio esiti disponibile: ' + (monitor.copertura.dal || '—') + ' → ' + (monitor.copertura.al || '—') + ' (' + num(monitor.copertura.giorni) + ' giorni, ' + num(monitor.copertura.esiti) + ' aggiudicazioni su ' + num(monitor.copertura.tribunali) + ' tribunali). Lotti attivi nel feed: ' + num(rap.copertura.lottiAttivi) + '.</p>' +
'<p class="lead">Esclusi e dichiarati: ' + num(rap.copertura.esclusi.prezzoBase || 0) + ' lotti con solo prezzo base, ' + num(rap.copertura.esclusi.senzaData || 0) + ' senza data, ' + num(rap.copertura.esclusi.altreFonti || 0) + ' record di altre fonti senza prezzo finale.</p>' +
'<h2>Mercato (stato del feed)</h2><p class="lead">Aggiudicate ' + num(es.aggiudicate) + ' · deserte ' + num(es.deserte) + ' · sospese ' + num(es.sospese) + ' · non pubblicate ' + num(es.nonPubblicato) + (sn ? (' · sconto medio nazionale (prezzo base vs offerta minima) ' + (Math.round(sn.medio * 10) / 10) + '% su ' + num(sn.lotti) + ' lotti') : '') + '.</p>' +
'<h2>Top tribunali del mese</h2><table><tr><th>Tribunale</th><th class="n">Esiti</th><th class="n">Incasso</th><th class="n">Prezzo medio</th></tr>' + righeTrib + '</table>' +
'<h2>Andamento per settimana ISO</h2><table><tr><th>Settimana</th><th class="n">Aggiudicazioni</th></tr>' + righeSett + '</table>' +
'<h2>Giorni con esiti</h2><table><tr><th>Giorno</th><th class="n">Aggiudicazioni</th></tr>' + righeGiorni + '</table>' +
'<p class="nota"><strong>Versione:</strong> ' + versione + ' · <strong>generato:</strong> ' + rap.generato + ' · <strong>data di riferimento:</strong> ' + rif + '<br><strong>Fonti:</strong> ' + rap.fonte + '<br><strong>Metodo:</strong> ' + rap.metodo + '<br><strong>Stimato:</strong> ' + rap.stimato + '<br><strong>Licenza e citazione:</strong> dati aperti per giornalisti, banche e ricercatori — citare "CARe Auctions, ' + versione + '". Dataset completi: info@careauctions.co · <a href="metodo.html">Metodo e copertura</a> · <a href="https://careauctions.co/dati">/dati</a> · <a href="https://careauctions.co/esiti">monitor esiti</a></p>' +
'</div></body></html>';
fs.writeFileSync(path.join(ROOT, outHtml), html);
console.log('report mensile:', outJson, '|', outHtml, '|', etichetta, '|', num(n), 'aggiudicazioni |', eur(incasso), '|', versione);
