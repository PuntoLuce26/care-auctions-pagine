// scripts/comunicato-mensile.js — 5.932 (31/10/2026)
// Genera il comunicato mensile CAReIndex dai dati vivi: Markdown + HTML (stampabile).
// Gira in GitHub Actions il 1° del mese (o a mano). Nessun numero inventato: ogni cifra ha fonte e data.
const fs = require('fs');
const https = require('https');

function get(url) {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch (e) { return res(null); }
    https.get({ host: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CAReComunicato/1.0)' } }, (r) => {
      let t = ''; r.on('data', (c) => t += c); r.on('end', () => { try { res(JSON.parse(t)); } catch (e) { res(null); } });
    }).on('error', () => res(null)).setTimeout(30000, function () { this.destroy(); res(null); });
  });
}
const n = (v) => (v == null ? 'non disponibile' : Number(v).toLocaleString('it-IT'));
const eur = (v) => (v == null ? 'non disponibile' : Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }));

(async () => {
  const mese = process.env.MESE || new Date().toISOString().slice(0, 7);
  const base = 'https://puntoluce26.github.io/care-auctions-pagine/feed/';
  const [stats, indice, esiti, aziende, confronto] = await Promise.all([
    get(base + 'statistiche.json'), get(base + 'indice-completo.json'),
    get(base + 'esiti-monitor.json'), get(base + 'aste-aziende.json'),
    get(base + 'confronto-mercato.json')
  ]);
  const conf = (confronto && confronto.meta && confronto.meta.copertura) ? confronto : null;
  const imm = (indice && indice.settori && indice.settori.immobiliare) || {};
  const mob = (indice && indice.settori && indice.settori.mobiliare) || {};
  const e = (esiti && (esiti.copertura || esiti.esiti)) || {};
  const az = (aziende && aziende.meta) || {};
  const tot = (indice && indice.totaleLotti) || (stats && stats.totale);
  const agg = e.aggiudicate || (stats && stats.esiti && stats.esiti.aggiudicate);
  const importo = e.importoTotale || e.importo || (esiti && esiti.importo);
  const righe = [
    ['Aste totali', n(tot)],
    ['Immobiliari', n(imm.lotti)],
    ['Mobiliari', n(mob.lotti)],
    ['Prezzo medio immobiliare', eur(imm.prezzoMedio)],
    ['Sconto mediano vs OMI', (conf && conf.nazionale && conf.nazionale.scontoMedianoPct != null && conf.meta.copertura.lottiConMq)
      ? (String(conf.nazionale.scontoMedianoPct).replace('.', ',') + '% su ' + conf.meta.copertura.lottiConMq + ' lotti confrontabili in ' + conf.meta.copertura.comuniPubblicati + ' comuni')
      : 'non disponibile'],
    ['Aggiudicazioni monitorate', n(agg)],
    ['Importo aggiudicato', eur(importo)],
    ['Aste di aziende e crediti', n(az.totale)],
    ['Valore base attivo (aziende)', az.valoreAttive ? eur(az.valoreAttive) : 'non disponibile']
  ];
  const data = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  const md = `# CAReIndex — comunicato ${mese}\n\n**${data}** — I numeri del mercato delle aste immobiliari italiane, dai sistemi CARe.\n\n` +
    righe.map(([k, v]) => `- **${k}**: ${v}`).join('\n') +
    `\n\nFonti: PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia), Agenzia delle Entrate — OMI, CAReIndex. Metodo e copertura: https://careauctions.co/metodo. Nessun numero inventato: i dati sono calcolati dai giri automatici e aggiornati ogni 15 minuti.\n\nCARe Auctions è consulente di parte: non fa mediazione e non percepisce provvigioni. Success fee: 3,9% fino a 150.000 €, 2,9% fino a 300.000 €, 1,9% oltre, minimo 1.900 €, entro 24 ore dall'aggiudicazione.\n\nContatti stampa: info@careauctions.co\n`;
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>CAReIndex — comunicato ${mese}</title><style>
  body{margin:0;background:#F4F1EA;color:#0F1E3A;font-family:-apple-system,system-ui,sans-serif;line-height:1.6}
  .wrap{max-width:820px;margin:40px auto;padding:0 24px}
  h1{font-size:32px;margin:0 0 6px}.kicker{color:#A8811F;font-size:12px;letter-spacing:.14em;text-transform:uppercase}
  .lead{font-size:19px;color:#3C4A65}.card{background:#fff;border:1px solid #E3D9C0;border-radius:14px;padding:20px;margin:18px 0}
  table{width:100%;border-collapse:collapse;font-size:15px}td{padding:9px 10px;border-bottom:1px solid #EFE7D2}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
  .nota{font-size:13px;color:#5a6a85;border-top:1px solid #E3D9C0;padding-top:14px;margin-top:24px}
  </style></head><body><div class="wrap"><div class="kicker">CAReIndex · comunicato mensile</div><h1>${mese}</h1>
  <p class="lead">I numeri del mercato delle aste immobiliari italiane, dai sistemi CARe. Dati vivi, fonti citate, nessun numero inventato.</p>
  <div class="card"><table>${righe.map(([k, v]) => `<tr><td>${k}</td><td><strong>${v}</strong></td></tr>`).join('')}</table></div>
  <p class="nota">Fonti: PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia), Agenzia delle Entrate — OMI, CAReIndex. Metodo e copertura: https://careauctions.co/metodo. CARe Auctions è consulente di parte: non fa mediazione. Success fee 3,9% / 2,9% / 1,9%, minimo 1.900 €, entro 24 ore. Contatti: info@careauctions.co</p></div></body></html>`;
  fs.mkdirSync('comunicati', { recursive: true });
  fs.writeFileSync(`comunicati/${mese}.md`, md);
  fs.writeFileSync(`comunicati/${mese}.html`, html);
  console.log('comunicato', mese, 'scritto — aste', n(tot), '| aggiudicate', n(agg));
})().catch((e) => { console.error('ERRORE:', e.message); process.exit(1); });
