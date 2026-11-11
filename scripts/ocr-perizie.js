// scripts/ocr-perizie.js — 5.931 (31/10/2026)
// OCR incrementale delle perizie raccolte: estrae i mq per lo Sconto Reale Certificato.
// Legge feed/foto-procedure.json (gia' nel repo), processa N perizie non ancora fatte,
// scrive feed/perizie-ocr.json + feed/ocr-stato.json. Gira in GitHub Actions (cloud, costo 0).
const fs = require('fs');
const { execFileSync } = require('child_process');
const https = require('https');

const FEED = 'feed/foto-procedure.json';
const OUT = 'feed/perizie-ocr.json';
const STATO = 'feed/ocr-stato.json';
const N = Number(process.env.OCR_N || 80);

function scarica(url, redirect = 0) {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch (e) { return res(null); }
    const r = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CAReOCR/1.0)' } }, (x) => {
      if (x.statusCode >= 300 && x.statusCode < 400 && x.headers.location && redirect < 3) { x.resume(); return res(scarica(new URL(x.headers.location, url).toString(), redirect + 1)); }
      if (x.statusCode !== 200) { x.resume(); return res(null); }
      const chunks = []; let n = 0;
      x.on('data', (c) => { n += c.length; if (n > 30 * 1024 * 1024) { r.destroy(); return res(null); } chunks.push(c); });
      x.on('end', () => res(Buffer.concat(chunks)));
    });
    r.on('error', () => res(null));
    r.setTimeout(30000, () => { r.destroy(); res(null); });
    r.end();
  });
}

function testoPdf(buf, tmp) {
  fs.writeFileSync(tmp, buf);
  let testo = '';
  try { testo = execFileSync('pdftotext', ['-layout', tmp, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 45000 }); } catch (e) { testo = ''; }
  if (String(testo).replace(/\s/g, '').length > 300) return { testo: String(testo), metodo: 'pdftotext' };
  try {
    execFileSync('pdftoppm', ['-r', '200', '-f', '1', '-l', '1', '-png', tmp, tmp + '-p'], { timeout: 60000 });
    const png = fs.readdirSync('/tmp').filter(f => f.startsWith(tmp.split('/').pop() + '-p') && f.endsWith('.png')).map(f => '/tmp/' + f)[0];
    if (png) {
      const ocr = execFileSync('tesseract', [png, 'stdout', '-l', 'ita'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 90000 });
      try { fs.unlinkSync(png); } catch (e) {}
      return { testo: String(ocr || ''), metodo: 'tesseract' };
    }
  } catch (e) {}
  return { testo: String(testo || ''), metodo: 'testo-scarso' };
}

function estraiMq(t) {
  const re = /(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:m2|m²|mq|metri\s+quadrati)\b/gi;
  const trovati = [];
  let m;
  while ((m = re.exec(t)) !== null && trovati.length < 20) {
    const v = Number(String(m[1]).replace(/\./g, '').replace(',', '.'));
    if (v >= 10 && v <= 5000) trovati.push({ mq: v, contesto: t.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, ' ').trim() });
  }
  if (!trovati.length) return null;
  const mq = Math.max(...trovati.map(x => x.mq));
  return { mq, trovati: trovati.length, contesto: trovati[0].contesto };
}

(async () => {
  const feed = JSON.parse(fs.readFileSync(FEED, 'utf8'));
  let stato = { fatti: [], aggiornato: null };
  try { stato = JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (e) {}
  const fatti = new Set((stato.fatti || []).map(String));
  const out = [];
  try { out.push(...JSON.parse(fs.readFileSync(OUT, 'utf8'))); } catch (e) {}
  const gia = new Set(out.map(x => String(x.id)));

  const coda = [];
  for (const lotto of feed) {
    for (const url of (lotto.perizia || [])) {
      const key = String(lotto.id) + '|' + String(url).slice(-24);
      if (!fatti.has(key) && !gia.has(key)) coda.push({ key, id: String(lotto.id), url });
    }
  }
  // 11/11/2026 — LA CODA HA UNA PRIORITÀ: i lotti ATTIVI residenziali, quelli che servono
  // per calcolare lo sconto sulla stessa popolazione della quota (job superfici-lotti.mjs).
  // Senza priorità l'OCR consumava i giri sulle perizie vecchie e i lotti in asta restavano
  // senza superficie (5 su 889 al primo controllo).
  try {
    const prio = JSON.parse(fs.readFileSync('feed/ocr-priorita.json', 'utf8'));
    const urgenti = new Set((prio.ids || []).map(String));
    if (urgenti.size) {
      coda.sort((a, b) => (urgenti.has(b.id) ? 1 : 0) - (urgenti.has(a.id) ? 1 : 0));
      console.log('priorità: lotti attivi senza superficie =', urgenti.size, '| primi in coda:', coda.slice(0, 3).map(x => x.id).join(','));
    }
  } catch (e) { console.log('nessuna lista di priorità (feed/ocr-priorita.json assente)'); }
  console.log('perizie totali:', coda.length + fatti.size, '| da fare:', coda.length, '| giro:', Math.min(N, coda.length));
  const giro = coda.slice(0, N);
  let ok = 0, mqTrovati = 0, errori = 0;
  for (let i = 0; i < giro.length; i++) {
    const x = giro[i];
    const buf = await scarica(x.url);
    if (!buf || buf.length < 1000) { errori++; fatti.add(x.key); continue; }
    const tmp = '/tmp/ocr-' + process.pid + '-' + i + '.pdf';
    const { testo, metodo } = testoPdf(buf, tmp);
    try { fs.unlinkSync(tmp); } catch (e) {}
    const r = estraiMq(testo || '');
    if (r) { mqTrovati++; out.push({ id: x.id, url: x.url, mq: r.mq, metodo, trovati: r.trovati, contesto: r.contesto, quando: new Date().toISOString() }); }
    fatti.add(x.key); ok++;
    if ((i + 1) % 10 === 0) console.log('fatte:', i + 1, '/', giro.length, '| mq trovati:', mqTrovati);
  }
  stato = { fatti: Array.from(fatti), aggiornato: new Date().toISOString(), ultimoGiro: giro.length };
  fs.writeFileSync(STATO, JSON.stringify(stato));
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('FINE OCR: processate', ok, '| con mq:', mqTrovati, '| errori:', errori, '| totale risultati:', out.length, '| restano:', Math.max(0, coda.length - giro.length));
})().catch((e) => { console.error('ERRORE:', e.message); process.exit(1); });
