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
const n = (v) => (v == null ? null : Number(v).toLocaleString('it-IT'));
const eur = (v) => (v == null ? null : Number(v).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }));

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
  // 11/11/2026 — l'importo aggiudicato non è un campo piatto: esiti-monitor.json lo tiene
  // dentro `giorni` come [tipo, conteggio, importo]. Lo si somma, invece di scrivere «non disponibile».
  const importoDaGiorni = (() => {
    try {
      let s = 0;
      for (const [, arr] of ((esiti && esiti.giorni) || [])) for (const t of arr) s += Number(t[2]) || 0;
      return s > 0 ? s : null;
    } catch (_) { return null; }
  })();
  const importo = e.importoTotale || e.importo || (esiti && esiti.importo) || importoDaGiorni || null;
  const righe = [
    ['Aste totali', n(tot)],
    ['Immobiliari', n(imm.lotti)],
    ['Mobiliari', n(mob.lotti)],
    ['Prezzo medio immobiliare', eur(imm.prezzoMedio)],
    ['Sconto mediano vs OMI', (conf && conf.nazionale && conf.nazionale.scontoMedianoPct != null && conf.meta.copertura.lottiConMq)
      ? (String(conf.nazionale.scontoMedianoPct).replace('.', ',') + '% su ' + Number(conf.meta.copertura.lottiConMq).toLocaleString('it-IT') + ' lotti confrontabili in ' + conf.meta.copertura.comuniPubblicati + ' comuni')
      : null],
    ['Aggiudicazioni monitorate', n(agg)],
    ['Importo aggiudicato', eur(importo)],
    ['Aste di aziende e crediti', n(az.totale)],
    ['Valore base attivo (aziende)', az.valoreAttive ? eur(az.valoreAttive) : null]
  ];
  const righeValide = righe.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 'non disponibile');
  const data = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  let mdPro = `# CAReIndex — comunicato ${mese}\n\n**${data}** — I numeri del mercato delle aste immobiliari italiane, dai sistemi CARe.\n\n` +
    righeValide.map(([k, v]) => `- **${k}**: ${v}`).join('\n') +
    `\n\nFonti: PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia), Agenzia delle Entrate — OMI, CAReIndex. Metodo e copertura: https://careauctions.co/metodo. Nessun numero inventato: i dati sono calcolati dai giri automatici e aggiornati ogni 15 minuti.\n\nCARe Auctions è consulente di parte: non fa mediazione e non percepisce provvigioni. Success fee: 3,9% fino a 150.000 €, 2,9% fino a 300.000 €, 1,9% oltre, minimo 1.900 €, entro 24 ore dall'aggiudicazione.\n\nContatti stampa: info@careauctions.co\n`;
  // 11/11/2026 — ogni comunicato mensile ha la sua foto a tema, creata da Emergent
  // in stile sito e salvata in img/newsletter/<AAAA-MM>.webp. Se manca, il comunicato
  // esce senza foto: mai un'immagine segnaposto.
  let heroFile = null;
  for (const ext of ['webp', 'jpg', 'png']) {
    const p = `img/newsletter/${mese}.${ext}`;
    if (fs.existsSync(p)) { heroFile = p; break; }
  }
  const heroUrl = heroFile ? 'https://careauctions.co/' + heroFile : null;
  if (heroUrl) {
    mdPro = mdPro.replace('\n\n', `\n\n![${mese}](${heroUrl})\n\n`);
  }
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CAReIndex — comunicato ${mese}</title><style>
  body{margin:0;background:#FBF9F4;color:#0F1E3A;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;line-height:1.6}
  .wrap{max-width:640px;margin:0 auto;padding:56px 28px 44px}
  .kicker{color:#A2977E;font-size:10px;letter-spacing:.22em;text-transform:uppercase;font-weight:600;margin:0 0 14px}
  h1{font-size:44px;font-weight:300;letter-spacing:-.02em;line-height:1;margin:0 0 26px}
  .hero{width:100%;height:auto;display:block;border-radius:2px;margin:0 0 30px}
  .lead{font-size:18px;color:#3C4A65;margin:0 0 34px;max-width:520px}
  table{width:100%;border-collapse:collapse;margin:0 0 30px}
  td{padding:15px 0;border-bottom:1px solid #E7DFCF;font-size:16px;vertical-align:baseline}
  td:first-child{color:#5A6478}
  td:last-child{text-align:right;font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  .nota{font-size:12px;color:#8A7F68;border-top:1px solid #E7DFCF;padding-top:18px;margin:36px 0 0;line-height:1.7}
  .firma{margin-top:26px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#A2977E}
  @media(max-width:480px){.wrap{padding:36px 20px}h1{font-size:34px}td{font-size:15px}}
</style></head><body><div class="wrap">
  <p class="kicker">CAReIndex · comunicato mensile</p>
  <h1>${mese}</h1>
  ${heroUrl ? `<img class="hero" src="${heroUrl}" alt="Comunicato ${mese} — immagine a tema" />` : ''}
  <p class="lead">I numeri del mercato delle aste immobiliari italiane, dai sistemi CARe.</p>
  <table>${righeValide.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
  <p class="nota">Fonti: PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia), Agenzia delle Entrate — OMI, CAReIndex. Metodo e copertura: careauctions.co/metodo. Success fee 3,9% / 2,9% / 1,9%, minimo 1.900 €, entro 24 ore dall'aggiudicazione.</p>
  <p class="firma">CAReAuctions · Italian Property Auctions</p>
</div></body></html>`;
  fs.mkdirSync('comunicati', { recursive: true });
  fs.writeFileSync(`comunicati/${mese}.md`, mdPro);
  fs.writeFileSync(`comunicati/${mese}.html`, html);
  console.log('comunicato', mese, 'scritto — aste', n(tot), '| aggiudicate', n(agg));
})().catch((e) => { console.error('ERRORE:', e.message); process.exit(1); });
