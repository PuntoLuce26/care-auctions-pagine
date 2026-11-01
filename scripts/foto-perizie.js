#!/usr/bin/env node
// scripts/foto-perizie.js — estrae FOTO REALI dai PDF delle perizie e le pubblica.
// Costo zero: gira in GitHub Actions (ubuntu-latest) con poppler-utils + webp.
//
// Input : feed/perizie-ocr.json   (array {id, url, mq, ...})
// Stato : feed/foto-perizie-stato.json ({fatti, falliti, ultimoGiro})
// Output: foto/<id>/<n>.webp  (n = 1..3)  +  feed/foto-ricavate.json
//
// Filtro che scarta loghi/timbri/planimetrie vettoriali:
//   - pdfimages -list per le dimensioni in PIXEL prima di estrarre (affidabile)
//   - butta < 400x300 px e file estratto < 20 KB
//   - butta le immagini 1-bit bianco/nero (scansioni di testo, mai foto)
//   - massimo 3 foto per lotto, larghezza max 900 px, WebP q78
//
// Zero dipendenze: solo fs/path/crypto/child_process + fetch nativo (Node 22).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const IN = 'feed/perizie-ocr.json';
const OUT = 'feed/foto-ricavate.json';
const STATO = 'feed/foto-perizie-stato.json';
const CARTELLA = 'foto';

const CDN = 'https://cdn.jsdelivr.net/gh/PuntoLuce26/care-auctions-pagine@main/foto/';

const N_GIRO = Math.max(1, Number(process.env.FOTO_N || 60)); // PDF per giro
const MAX_FOTO = 3; // foto per lotto
const MAX_MB = 30; // limite download
const TIMEOUT_MS = 60000; // timeout download
const MIN_BYTES = 20 * 1024; // butta i file estratti < 20 KB
const MIN_W = 400; // butta le immagini < 400 px di larghezza
const MIN_H = 300; // butta le immagini < 300 px di altezza
const LARGHEZZA = 900; // larghezza massima finale
const QUALITA = 78;
const MAX_PAGINE = 6; // pagine estratte al massimo per PDF
const TENTATIVI = 3; // tentativi per PDF prima di dichiararlo fallito
const TMP = '/tmp';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const ora = () => new Date().toISOString();
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- download --
async function scarica(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'application/pdf,image/*,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
    });
    if (!r.ok) return { errore: 'http ' + r.status };
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_MB * 1024 * 1024) {
      try { await r.body?.cancel(); } catch (e) {}
      return { errore: 'file troppo grande (' + Math.round(len / 1048576) + ' MB)' };
    }
    const chunks = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.length;
      if (n > MAX_MB * 1024 * 1024) return { errore: 'oltre ' + MAX_MB + ' MB in streaming' };
      chunks.push(Buffer.from(c));
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 2048) return { errore: 'file vuoto (' + buf.length + ' B)' };
    const testa = buf.toString('latin1', 0, Math.min(2048, buf.length));
    if (!testa.includes('%PDF')) return { errore: 'non e\' un PDF' };
    return { buf };
  } catch (e) {
    return { errore: 'rete: ' + (e && e.name === 'AbortError' ? 'timeout 60s' : (e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------- pdfimages -list (pixel) --
// Output: "page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio"
function listaImmagini(pdf) {
  const out = execFileSync('pdfimages', ['-list', pdf], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const righe = [];
  for (const riga of String(out).split('\n')) {
    const m = riga.match(/^\s*(\d+)\s+(\d+)\s+image\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)/);
    if (!m) continue;
    righe.push({
      pagina: Number(m[1]),
      num: Number(m[2]),
      w: Number(m[3]),
      h: Number(m[4]),
      colore: String(m[5]),
      comp: Number(m[6]),
      bpc: Number(m[7]),
      enc: String(m[8]),
    });
  }
  return righe;
}

// Estrae una pagina con pdfimages; ritorna i file prodotti (ordinati).
function estraiPagina(pdf, pagina, dir, modo) {
  const base = 'p' + String(pagina).padStart(3, '0');
  const pref = path.join(dir, base);
  const args = [
    modo === 'png' ? '-png' : '-j',
    '-f', String(pagina),
    '-l', String(pagina),
    pdf,
    pref,
  ];
  try {
    execFileSync('pdfimages', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 150000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // pdfimages esce != 0 anche quando ha scritto immagini su PDF malformati: si continua.
  }
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base) && !f.endsWith('~'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch (e) {}
  return files;
}

function convertiWebp(src, dst, w) {
  const args = ['-quiet', '-q', String(QUALITA)];
  if (w > LARGHEZZA) args.push('-resize', String(LARGHEZZA), '0');
  args.push(src, '-o', dst);
  execFileSync('cwebp', args, { timeout: 90000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const st = fs.statSync(dst);
  if (!st.size) throw new Error('webp vuoto');
  return st.size;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// ---------------------------------------------------------------- un PDF ----
// Scarica, estrae e scrive fino a MAX_FOTO webp in foto/<id>/.
// Ritorna {n, motivo?}.
async function lavoraPdf(voce, id, nIniziale, maxFoto) {
  const dir = fs.mkdtempSync(path.join(TMP, 'fotop-'));

  // ---------- download con retry ----------
  let scaricato = null;
  let ultimoErrore = '';
  for (let t = 1; t <= TENTATIVI; t++) {
    scaricato = await scarica(voce.url);
    if (scaricato.buf) break;
    ultimoErrore = scaricato.errore || 'errore sconosciuto';
    if (t < TENTATIVI) await new Promise((r) => setTimeout(r, 1500 * t));
  }
  if (!scaricato || !scaricato.buf) {
    pulisci(dir);
    return { n: 0, motivo: 'download: ' + (ultimoErrore || 'fallito') };
  }

  const pdf = path.join(dir, 'p.pdf');
  fs.writeFileSync(pdf, scaricato.buf);
  const pesoPdf = scaricato.buf.length;

  // ---------- dimensioni in pixel PRIMA di estrarre ----------
  let immagini;
  try {
    immagini = listaImmagini(pdf);
  } catch (e) {
    pulisci(dir);
    return { n: 0, motivo: 'pdfimages -list: ' + String((e && e.message) || e).slice(0, 90) };
  }

  const candidati = immagini.filter(
    (r) =>
      r.w >= MIN_W &&
      r.h >= MIN_H &&
      !(r.bpc <= 1 && r.comp <= 1) && // scansioni 1-bit: mai foto
      r.w / Math.max(1, r.h) < 6 && // strisce panoramiche: non sono foto
      r.h / Math.max(1, r.w) < 6
  );

  if (!candidati.length) {
    pulisci(dir);
    return { n: 0, motivo: 'nessuna immagine >= ' + MIN_W + 'x' + MIN_H + ' px (' + immagini.length + ' immagini nel PDF)', vuoto: true };
  }

  // le più grandi prima; al massimo MAX_PAGINE pagine distinte
  candidati.sort((a, b) => b.w * b.h - a.w * a.h);
  const pagine = [];
  for (const c of candidati) {
    if (!pagine.includes(c.pagina)) {
      if (pagine.length >= MAX_PAGINE) continue;
      pagine.push(c.pagina);
    }
  }

  const destinazione = path.join(CARTELLA, id);
  fs.mkdirSync(destinazione, { recursive: true });

  const scelti = [];
  const visti = new Set();
  let n = nIniziale;

  for (const pagina of pagine) {
    if (scelti.length >= maxFoto) break;
    const dellaPagina = candidati.filter((c) => c.pagina === pagina);

    let files = estraiPagina(pdf, pagina, dir, 'j');
    // fallback: certe immagini (jp2, jbig2, ccitt, png) non escono con -j
    const utiliJ = files.filter((f) => /\.(jpe?g)$/i.test(f));
    if (utiliJ.length < Math.min(dellaPagina.length, maxFoto)) {
      const filesPng = estraiPagina(pdf, pagina, dir, 'png');
      const utiliPng = filesPng.filter((f) => /\.png$/i.test(f));
      if (utiliPng.length) files = files.concat(utiliPng);
    }
    if (!files.length) continue;

    // indicizza i file per (numero immagine nella pagina) quando possibile
    for (let i = 0; i < files.length && scelti.length < maxFoto; i++) {
      const f = files[i];
      let st;
      try {
        st = fs.statSync(f);
      } catch (e) {
        continue;
      }
      if (st.size < MIN_BYTES) continue; // butta loghi e timbri
      let buf;
      try {
        buf = fs.readFileSync(f);
      } catch (e) {
        continue;
      }
      const h = sha1(buf);
      if (visti.has(h)) continue; // stessa foto ripetuta in piu' pagine
      visti.add(h);

      const voceCand = dellaPagina[Math.min(i, dellaPagina.length - 1)] || dellaPagina[0];
      const dst = path.join(destinazione, n + '.webp');
      try {
        convertiWebp(f, dst, voceCand ? voceCand.w : MIN_W);
      } catch (e) {
        try { fs.unlinkSync(dst); } catch (e2) {}
        continue;
      }
      scelti.push({ n, file: dst, da: path.basename(f), px: (voceCand ? voceCand.w + 'x' + voceCand.h : '?'), kb: Math.round(st.size / 1024) });
      n++;
    }
  }

  pulisci(dir);

  if (!scelti.length) {
    return { n: 0, motivo: 'nessuna foto utile (' + candidati.length + ' candidate, tutte < 20 KB o non convertibili)', vuoto: true, pesoPdf };
  }
  return { n: scelti.length, scelti, pesoPdf };
}

function pulisci(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
}

// ------------------------------------------------------------------ main ----
(async () => {
  // strumenti: se mancano in locale si esce con un messaggio chiaro (la CI li installa)
  for (const bin of ['pdfimages', 'cwebp']) {
    try {
      execFileSync(bin, bin === 'cwebp' ? ['-version'] : ['-v'], { stdio: 'ignore', timeout: 20000 });
    } catch (e) {
      console.error('::error::' + bin + ' non disponibile: installa poppler-utils e webp (apt-get install -y poppler-utils webp).');
      process.exit(1);
    }
  }

  if (!fs.existsSync(IN)) {
    console.error('::error::' + IN + ' mancante');
    process.exit(1);
  }
  const feed = JSON.parse(fs.readFileSync(IN, 'utf8'));
  if (!Array.isArray(feed) || !feed.length) {
    console.error('::error::' + IN + ' vuoto o non e\' un array');
    process.exit(1);
  }

  let stato = { fatti: {}, falliti: {}, ultimoGiro: null };
  try {
    const s = JSON.parse(fs.readFileSync(STATO, 'utf8'));
    if (s && typeof s === 'object') {
      stato.fatti = s.fatti && typeof s.fatti === 'object' ? s.fatti : {};
      stato.falliti = s.falliti && typeof s.falliti === 'object' ? s.falliti : {};
      stato.ultimoGiro = s.ultimoGiro || null;
    }
  } catch (e) {}

  let ricavate = [];
  try {
    const r = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (Array.isArray(r)) ricavate = r;
  } catch (e) {}
  const perId = new Map(ricavate.map((x) => [String(x.id), x]));

  // coda: un elemento per PDF non ancora fatto
  const coda = [];
  const vistiOra = new Set();
  for (const voce of feed) {
    if (!voce || !voce.url) continue;
    const id = String(voce.id);
    const key = id + '|' + String(voce.url).slice(-24);
    if (vistiOra.has(key)) continue;
    vistiOra.add(key);
    if (stato.fatti[key]) continue;
    const fall = stato.falliti[key];
    if (fall && Number(fall.volte || 0) >= TENTATIVI) continue; // rinunciato
    coda.push({ key, id, url: String(voce.url) });
  }

  // un lotto ha al massimo MAX_FOTO foto: se e' gia' completo, i suoi PDF si saltano
  let completi = 0;
  const daFare = coda.filter((c) => {
    const ha = (perId.get(c.id) || {}).foto || [];
    if (ha.length >= MAX_FOTO) {
      completi++;
      return false;
    }
    return true;
  });
  const giro = daFare.slice(0, N_GIRO);
  log(
    'perizie: ' + feed.length + ' righe, ' + new Set(feed.map((x) => String(x && x.id))).size + ' lotti distinti' +
      ' | PDF fatti: ' + Object.keys(stato.fatti).length +
      ' | da fare: ' + coda.length +
      ' | questo giro: ' + giro.length
  );

  let ok = 0;
  let falliti = 0;
  let fotoTot = 0;
  let pdfVuoti = 0;
  const iniziato = Date.now();

  for (let i = 0; i < giro.length; i++) {
    const voce = giro[i];
    if (((perId.get(voce.id) || {}).foto || []).length >= MAX_FOTO) continue; // lotto gia' a 3 foto
    const t0 = Date.now();

    // numerazione per lotto: continua dopo i file gia' presenti
    let n0 = 1;
    try {
      const esistenti = fs
        .readdirSync(path.join(CARTELLA, voce.id))
        .filter((f) => /^\d+\.webp$/.test(f))
        .map((f) => Number(f.replace('.webp', '')));
      if (esistenti.length) n0 = Math.max(...esistenti) + 1;
    } catch (e) {}
    const nelFeed = (perId.get(voce.id) || {}).foto || [];
    if (nelFeed.length && n0 < nelFeed.length + 1) n0 = nelFeed.length + 1;

    let esito;
    try {
      esito = await lavoraPdf(voce, voce.id, n0, MAX_FOTO - (n0 - 1));
    } catch (e) {
      esito = { n: 0, motivo: 'eccezione: ' + String((e && e.message) || e).slice(0, 100) };
    }

    const durata = ((Date.now() - t0) / 1000).toFixed(1);

    if (esito.motivo) {
      // fallito o "nessuna foto": in entrambi i casi lo marchiamo per non riprovare all'infinito
      const volte = Number((stato.falliti[voce.key] || {}).volte || 0) + 1;
      stato.falliti[voce.key] = { motivo: esito.motivo, quando: ora(), volte };
      falliti++;
      if (esito.vuoto) pdfVuoti++;
      log('[' + (i + 1) + '/' + giro.length + '] ' + voce.id + ' 0 foto — ' + esito.motivo + ' (' + durata + 's)');
    } else {
      ok++;
      fotoTot += esito.n;
      stato.fatti[voce.key] = { n: esito.n, quando: ora() };
      delete stato.falliti[voce.key];

      // aggiorna il feed delle foto
      const prima = perId.get(voce.id) || { id: voce.id, foto: [] };
      const foto = Array.from(new Set((prima.foto || []).concat(
        esito.scelti.map((s) => CDN + encodeURIComponent(voce.id) + '/' + s.n + '.webp')
      )));
      perId.set(voce.id, { id: voce.id, foto, quando: ora() });

      log(
        '[' + (i + 1) + '/' + giro.length + '] ' + voce.id + ' ' + esito.n + ' foto' +
          ' — ' + esito.scelti.map((s) => s.n + ':' + s.px + '/' + s.kb + 'K').join(' ') +
          ' (' + durata + 's)'
      );
    }

    // scrittura periodica dello stato: se il runner muore, non si riparte da zero
    if ((i + 1) % 10 === 0) salvaTutto(stato, perId);
  }

  stato.ultimoGiro = ora();
  const aggiunte = salvaTutto(stato, perId);

  const totaleFile = contaFoto();
  const minuti = ((Date.now() - iniziato) / 60000).toFixed(1);
  log(
    '--- giro finito in ' + minuti + ' min: ' + ok + ' PDF con foto (' + fotoTot + ' nuove), ' +
      pdfVuoti + ' PDF senza foto utili, ' + falliti + ' falliti/rimandati' +
      ' | foto in repo: ' + totaleFile + ' | lotti nel feed: ' + ricavateCount(perId) +
      ' | feed scritto: ' + aggiunte
  );
})().catch((e) => {
  console.error('::error::errore imprevisto: ' + ((e && e.stack) || e));
  process.exit(1);
});

// ---------------------------------------------------------------- utility ---
function ricavateCount(perId) {
  let c = 0;
  for (const v of perId.values()) if ((v.foto || []).length) c++;
  return c;
}

function contaFoto() {
  let n = 0;
  try {
    for (const d of fs.readdirSync(CARTELLA)) {
      try {
        n += fs.readdirSync(path.join(CARTELLA, d)).filter((f) => f.endsWith('.webp')).length;
      } catch (e) {}
    }
  } catch (e) {}
  return n;
}

function salvaTutto(stato, perId) {
  fs.mkdirSync(CARTELLA, { recursive: true });
  fs.mkdirSync('feed', { recursive: true });

  const elenco = Array.from(perId.values())
    .filter((v) => (v.foto || []).length && v.id)
    .map((v) => ({ id: String(v.id), foto: v.foto, quando: v.quando || ora() }))
    .sort((a, b) => (a.id === b.id ? 0 : a.id.localeCompare(b.id, 'it', { numeric: true })));

  fs.writeFileSync(OUT, JSON.stringify(elenco, null, 0) + '\n');
  fs.writeFileSync(STATO, JSON.stringify(stato, null, 0) + '\n');
  return elenco.length;
}
