#!/usr/bin/env node
/**
 * video-lotto.mjs — video cinematico dalle foto di un lotto (V0).
 *
 * PERCHÉ (18/11/2026): AviAste offre «un video 3D dalle foto dell'asta con voce e sottotitoli».
 * La funzione è buona e la facciamo nostra, ma NON si chiama 3D finché non c'è vero depth: per ora
 * è un **video cinematico** (Ken Burns + dissolvenza + sovraimpressioni), senza musica e senza volti.
 *
 * INGRESSI (i nostri endpoint, non il PVP diretto):
 *   · /api/pvp-documenti/<id>   elenco allegati (t, n, u) + procedura
 *   · /api/pvp-img?u=<url>      immagine con Content-Type corretto (il PVP serve octet-stream)
 *   · feed/aste-indice/<shard>  titolo, città, tribunale, prezzo base, data asta (id % 64, esadecimale)
 *
 * USCITA: due mp4 H.264 CRF 23 +faststart in R2 `care-stato`:
 *   video/<id>/vertical.mp4 (1080×1920) · video/<id>/orizzontale.mp4 (1920×1080) · video/<id>/meta.json
 *
 * REGOLE: nessuna foto di persone, nessun logo di terzi, nessuna musica; niente file nel repo pubblico.
 * Se le foto utilizzabili sono meno di 3 → esce 0 con {esito:'foto-insufficienti'}.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ID = String(process.argv[2] || process.env.LOTTO_ID || '').trim();
const BASE = process.env.VIDEO_BASE || 'https://careauctions.co';
const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/feed/aste-indice/';
const ACC = 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const BUCKET = 'care-stato';
const OUT = process.env.VIDEO_OUT || 'video-out';
const DURATA_FOTO = Number(process.env.VIDEO_DURATA_FOTO || 4.5); // v1: 4,5 s per foto (testo leggibile)
const XFADE = 0.6;
const MAX_FOTO = Number(process.env.VIDEO_MAX_FOTO || 10); // oltre 10 il video annoia
const MIN_LATO = Number(process.env.VIDEO_MIN_LATO || 560); // fallback allegati: 560 px (upscale Lanczos)
const MIN_LATO_PDF = Number(process.env.VIDEO_MIN_LATO_PDF || 800); // immagini da perizia: 800 px
const MIN_FOTO = 3;
const FONT_CANDIDATI = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];
const ff = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

function sh(cmd, args) {
  console.log('  $', cmd, args.join(' ').slice(0, 160));
  return ff(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function scarica(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': 'care-video-lotto/1.0 (+https://careauctions.co)' } });
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status} su ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf.length;
}

function dimensioni(file) {
  const out = ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]);
  const s = (JSON.parse(out).streams || [])[0] || {};
  return { w: s.width, h: s.height };
}

async function r2put(chiave, file, contentType) {
  const tk = process.env.CLOUDFLARE_API_TOKEN;
  if (!tk) throw new Error('CLOUDFLARE_API_TOKEN assente: il video va su R2, non nel repo');
  const body = fs.readFileSync(file);
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/${BUCKET}/objects/${chiave.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + tk, 'Content-Type': contentType, 'User-Agent': 'care-video-lotto/1.0' },
    body,
  });
  const testo = await r.text();
  if (!r.ok) throw new Error(`R2 ${chiave}: HTTP ${r.status} ${testo.slice(0, 200)}`);
  return body.length;
}

async function r2size(chiave) {
  const tk = process.env.CLOUDFLARE_API_TOKEN;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/${BUCKET}/objects/${chiave.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: 'Bearer ' + tk, 'User-Agent': 'care-video-lotto/1.0' },
  });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length;
}

const font = () => FONT_CANDIDATI.find((f) => fs.existsSync(f)) || null;

function scriviTesto(file, righe) {
  fs.writeFileSync(file, righe.join('\n') + '\n');
  return file.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function filtriDrawtext({ W, H, durata, titolo, tribunale, prezzo, data, fonte, crediti, fonteLineaTesto }) {
  const f = font();
  if (!f) {
    console.warn('  ! nessun font trovato: si procede SENZA sovraimpressioni (dichiarato in meta.json)');
    return { filter: '', nota: 'sovraimpressioni saltate: nessun font' };
  }
  const fonteTxt = scriviTesto(`${OUT}/t-fonte.txt`, [fonteLineaTesto]);
  const t1 = scriviTesto(`${OUT}/t1.txt`, [titolo, tribunale]);
  const t2 = scriviTesto(`${OUT}/t2.txt`, [prezzo, data, fonte]);
  const comune = `fontfile=${f}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18`;
  const apertura = `drawtext=${comune}:textfile='${t1}':fontsize=${Math.round(W * 0.045)}:x=(w-text_w)/2:y=h*0.70:enable='between(t,0,3.4)'`;
  const chiusura = `drawtext=${comune}:textfile='${t2}':fontsize=${Math.round(W * 0.038)}:x=(w-text_w)/2:y=h*0.55:enable='between(t,${Math.max(0, durata - 5).toFixed(2)},${durata.toFixed(2)})'`;
  const creditiTxt = scriviTesto(`${OUT}/t3.txt`, [crediti]);
  const creditiFilter = `drawtext=${comune}:textfile='${creditiTxt}':fontsize=${Math.round(W * 0.026)}:x=(w-text_w)/2:y=h*0.68:enable='between(t,${Math.max(0, durata - 5).toFixed(2)},${durata.toFixed(2)})'`;
  // REGOLA GENERALE (18/11/2026): OGNI IMMAGINE CHE NON È NOSTRA PORTA LA SUA FONTE, SEMPRE VISIBILE
  // NEL VIDEO — non solo nella chiusura e non solo nel meta.json. È la stessa regola delle foto sul
  // sito: la fonte è la condizione che rende lecita la pubblicazione, quindi sta in sovraimpressione
  // per tutta la durata, piccola e discreta (bianco al 65% con ombra per le foto chiare).
  const fontFonte = Math.round(W * 0.0125); // 1080×1920 → 14 px · 1920×1080 → 24? no: vedi sotto
  const fs1 = W === 1080 ? 13 : 16; // come da indicazione: 10-14 sul verticale, 14-18 sull'orizzontale
  const fs2 = W === 1080 ? 11 : 13; // firma più piccola della fonte
  const fonteLinea = `drawtext=fontfile=${f}:textfile='${fonteTxt}':fontcolor=white@0.65:shadowcolor=black@0.55:shadowx=1:shadowy=1:fontsize=${fs1}:x=24:y=h-text_h-24`;
  const marchio = `drawtext=fontfile=${f}:text='CAReAuctions':fontcolor=white@0.65:shadowcolor=black@0.55:shadowx=1:shadowy=1:fontsize=${fs2}:x=w-text_w-24:y=h-text_h-24`;
  // i sottotitoli stanno SOPRA la fonte, con 12 px di margine fra le due righe
  const margineSub = Math.round(fs1 * 1.6 + 24 + 12);
  return {
    filter: [apertura, chiusura, fonteLinea, marchio, creditiFilter].join(','),
    margineSub,
    nota: `sovraimpressioni con ${f} · fonte persistente ${fs1}px · firma ${fs2}px · sottotitoli a ${margineSub}px dal basso`,
  };
}


// 18/11/2026 — il prezzo nella voce si legge A PAROLE: «1.086.080» detto a cifre dal TTS suona male.
function numInParole(n) {
  const num = Math.round(Number(n) || 0);
  if (!num) return 'zero';
  const unita = ['', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
  const decine = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
  const sotto100 = (x) => {
    if (x < 20) return unita[x];
    const d = Math.floor(x / 10);
    const u = x % 10;
    let s = decine[d];
    if (u === 1 || u === 8) s = s.slice(0, -1);
    return s + unita[u];
  };
  const sotto1000 = (x) => {
    const c = Math.floor(x / 100);
    const r = x % 100;
    let s = '';
    if (c === 1) s = 'cento';
    else if (c > 1) s = unita[c] + 'cento';
    if (r) s += sotto100(r);
    return s;
  };
  const gruppi = [];
  let resto = num;
  const scala = ['', 'mila', 'milione', 'miliardo'];
  let i = 0;
  while (resto > 0 && i < scala.length) {
    const g = resto % 1000;
    if (g) {
      let parola = g === 1 && i === 1 ? '' : sotto1000(g);
      if (i === 1) parola += 'mila';
      else if (i === 2) parola += g === 1 ? 'milione' : 'milioni';
      else if (i === 3) parola += g === 1 ? 'miliardo' : 'miliardi';
      gruppi.unshift(parola);
    }
    resto = Math.floor(resto / 1000);
    i += 1;
  }
  return gruppi.join(' ').replace(/\s+/g, ' ').trim();
}

async function main() {
  if (!ID) throw new Error('manca il lottoId (argomento o LOTTO_ID)');
  fs.mkdirSync(OUT, { recursive: true });
  console.log('video-lotto · lotto', ID);

  // 1) testata del lotto dall'indice (t, c, tr, pb, d)
  const shard = (Number(ID) % 64).toString(16).padStart(2, '0');
  const lotto = (async () => {
    const r = await fetch(RAW + shard + '.json');
    if (!r.ok) throw new Error('indice lotti non leggibile: HTTP ' + r.status);
    const j = await r.json();
    return (j.lotti || {})[ID] || null;
  })();
  const L = await lotto;
  if (!L) console.log('  ! lotto assente dall indice: titolo/tribunale dal documento PVP');

  if (MIN_LATO !== 560) console.log('  ! VIDEO_MIN_LATO=' + MIN_LATO + ' (override dichiarato: la soglia di prodotto per gli allegati è 560)');
  const doc = await (await fetch(`${BASE}/api/pvp-documenti/${ID}`)).json();
  if (!doc || !doc.ok || !Array.isArray(doc.allegati)) throw new Error('documenti non leggibili per il lotto ' + ID);

  // 1-bis) v1 — IMMAGINI DENTRO LA PERIZIA PDF (la strada vera: nel PDF sono grandi).
  // poppler-utils è presente nel runner (lo usa già l'OCR delle perizie). Si estraggono con
  // `pdfimages -png`, si scartano le < 800 px e quelle che sono timbri/firme/righe, si tiene
  // l'ordine delle pagine. Se non resta niente utile, si ricade sulle foto degli allegati (560 px).
  const daPdf = [];
  const perizia = (doc.allegati || []).find((a) => String(a.t || '').toUpperCase() === 'PERIZ' && /\.pdf$/i.test(String(a.n || a.u || '')));
  if (perizia) {
    try {
      const pdfFile = `${OUT}/perizia.pdf`;
      const rPdf = await fetch(perizia.u, { headers: { 'User-Agent': 'care-video-lotto/1.0' } });
      if (!rPdf.ok) throw new Error('HTTP ' + rPdf.status);
      fs.writeFileSync(pdfFile, Buffer.from(await rPdf.arrayBuffer()));
      const lista = ff('pdfimages', ['-list', pdfFile]);
      const pagine = lista.split('\n').slice(2).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 3).map((c) => Number(c[0]));
      ff('pdfimages', ['-png', '-f', '1', '-l', '40', pdfFile, `${OUT}/pdfimg`]);
      const tuttiEstratti = fs.readdirSync(OUT).filter((f) => /^pdfimg-\d+\.png$/.test(f)).sort();
      console.log(`  perizia: ${tuttiEstratti.length} immagini estratte dal PDF`);
      // 18/11/2026 — MISURATO: la perizia di 1822566 è una scansione a strisce → pdfimages tira fuori
      // 38.216 PNG e nessuno utile. Oltre 200 immagini il PDF non è una raccolta di foto: si salta
      // la via perizia e si ricade sugli allegati (la decisione resta nel log).
      if (tuttiEstratti.length > 200) {
        console.log('  perizia: scansione a strisce (' + tuttiEstratti.length + ' immagini) — non è una raccolta di foto, salto la via PDF');
        for (const f of tuttiEstratti) fs.rmSync(`${OUT}/${f}`, { force: true });
        throw new Error('pdf-scansione');
      }
      const estratti = tuttiEstratti;
      estratti.forEach((f, i) => {
        const file = `${OUT}/${f}`;
        const byte = fs.statSync(file).size;
        const { w, h } = dimensioni(file);
        const pagina = pagine[i] || null;
        const ratio = w && h ? Math.max(w, h) / Math.min(w, h) : 99;
        // timbri/firme/righe: molto piccoli, o molto allungati, o quasi monocromatici (PNG minuscolo)
        if (!w || !h || Math.min(w, h) < MIN_LATO_PDF) { fs.rmSync(file, { force: true }); return; }
        if (ratio > 4) { fs.rmSync(file, { force: true }); return; }
        if (byte < 30 * 1024) { fs.rmSync(file, { force: true }); return; } // timbro/scritta: pochi byte
        daPdf.push({ file, nome: `pdf-pagina-${pagina || '?'}`, w, h, byte, fonte: `perizia PDF, pagina ${pagina || '?'}` });
      });
      console.log(`  perizia: ${daPdf.length} immagini utili (>= ${MIN_LATO_PDF} px, non timbri)`);
    } catch (e) {
      console.log('  perizia non estraibile (' + String((e && e.message) || e).slice(0, 140) + '): si usano le foto degli allegati');
    }
  }

  // 2) allegati e foto
  const candidati = doc.allegati.filter((a) => /\.(jpe?g|png|webp)$/i.test(String(a.n || a.u || '')));
  console.log(`  allegati: ${doc.allegati.length} · immagini candidate: ${candidati.length}`);

  const usate = [];
  for (const f of daPdf) {
    if (usate.length >= MAX_FOTO) break;
    console.log(`  + uso ${f.nome} (${f.w}x${f.h}, ${f.byte} B) — ${f.fonte}`);
    usate.push(f);
  }
  for (const a of candidati) {
    if (usate.length >= MAX_FOTO) break;
    const file = `${OUT}/foto-${usate.length + 1}.jpg`;
    try {
      const urlImg = `${BASE}/api/pvp-img?u=${encodeURIComponent(a.u)}`;
      const byte = await scarica(urlImg, file);
      const { w, h } = dimensioni(file);
      // 18/11/2026 — la soglia si misura sul LATO LUNGO: le foto PVP tipiche sono 577×433, e con
      // il lato corto a 560 nessuna passerebbe mai (misurato: 433 < 560). 577 ≥ 560 → passa.
      if (!w || !h || Math.max(w, h) < MIN_LATO) {
        console.log(`  - scarto ${a.n} (${w}x${h}, lato lungo < ${MIN_LATO}) [${byte} B]`);
        fs.rmSync(file, { force: true });
        continue;
      }
      console.log(`  + uso ${a.n} (${w}x${h}, ${byte} B) — allegato`);
      usate.push({ file, nome: a.n, w, h, byte, fonte: 'allegato PVP: ' + a.n });
    } catch (e) {
      console.log(`  - scarto ${a.n}: ${String((e && e.message) || e).slice(0, 140)}`);
    }
  }

  if (usate.length < MIN_FOTO) {
    const meta = { esito: 'foto-insufficienti', lottoId: ID, fotoUsate: usate.length, minime: MIN_FOTO, generato: new Date().toISOString() };
    fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1) + '\n');
    console.log('::notice title=video-lotto::foto insufficienti (' + usate.length + '/' + MIN_FOTO + ') — nessun video');
    return;
  }

  const durata = Number((usate.length * DURATA_FOTO - (usate.length - 1) * XFADE).toFixed(2));
  const titolo = String((L && L.t) || ('Lotto ' + ID));
  const tribunale = String((L && L.tr) || (doc.procedura && doc.procedura.tribunale) || '');
  const prezzo = L && L.pb ? 'Prezzo base: ' + new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(L.pb) : '';
  const data = L && L.d ? 'Data asta: ' + L.d.split('-').reverse().join('/') : '';
  const fonte = 'Fonte: PVP — ' + (tribunale || 'Tribunale');

  // v1 — POSTER (anteprima del player, senza scaricare il video): prima foto usata, lato 1080,
  // JPEG q85, sotto 200 KB. Se sfora si abbassa la qualità e si ritenta (una volta sola per passo).
  const posterFile = `${OUT}/poster.jpg`;
  {
    const scala = 'scale=1080:1080:force_original_aspect_ratio=decrease:flags=lanczos';
    for (const q of [3, 6, 10]) {
      sh('ffmpeg', ['-y', '-i', usate[0].file, '-vf', scala, '-q:v', String(q), '-frames:v', '1', posterFile]);
      const b = fs.statSync(posterFile).size;
      console.log(`  poster: q${q} → ${b} B`);
      if (b <= 200 * 1024) break;
    }
    if (fs.statSync(posterFile).size > 200 * 1024) throw new Error('poster oltre 200 KB anche a qualità bassa');
  }

  // v1 — CREDITI FONTI nel video (da dove viene ogni foto) e SOTTOTITOLI BRUCIATI (leggibili senza audio).
  const daPdfN = usate.filter((u) => String(u.fonte || '').startsWith('perizia')).length;
  const crediti = daPdfN ? `Foto: perizia PDF (${daPdfN} immagini)` : 'Foto: allegati PVP';
  // la riga persistente: se le foto vengono dagli allegati lo dice, altrimenti cita il PVP
  const soloAllegati = usate.every((u) => String(u.fonte || '').startsWith('allegato'));
  const fonteLineaTesto = (soloAllegati ? 'Foto: allegati PVP' : 'Fonte: PVP') + (tribunale ? ' — ' + tribunale : '');
  const righeVoce = [
    titolo + '.',
    tribunale ? tribunale + '.' : '',
    prezzo ? prezzo + '.' : '',
    data ? data + '.' : '',
    fonte + '.',
    crediti + '.',
  ].filter(Boolean);
  const srt = `${OUT}/subs.srt`;
  {
    const passo = durata / righeVoce.length;
    const ts = (x) => {
      const ms = Math.max(0, Math.round(x * 1000));
      const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
      const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
      const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, '0')}`;
    };
    fs.writeFileSync(
      srt,
      righeVoce.map((r, i) => `${i + 1}\n${ts(i * passo)} --> ${ts((i + 1) * passo - 0.05)}\n${r}\n`).join('\n'),
    );
    console.log(`  sottotitoli: ${righeVoce.length} righe · ${crediti}`);
  }

  // v1 — LA VOCE: testo 20-25 s, tono sobrio, numeri letti a parole e sempre con la fonte accanto.
  // «iCARe» → «ai ker» prima della sintesi (stessa sostituzione dell'azione tts del worker).
  const prezzoParole = L && L.pb ? numInParole(L.pb) + ' euro' : '';
  const dataParole = L && L.d ? (() => { const [a, m, g] = L.d.split('-'); return `${Number(g)} ${['', 'gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'][Number(m)]} ${a}`; })() : '';
  const testoVoce = [
    `${titolo}.`,
    tribunale ? `${tribunale}.` : '',
    prezzoParole ? `Prezzo base ${prezzoParole}, come risulta dal P V P.` : '',
    dataParole ? `Data dell'asta: ${dataParole}.` : '',
    'Foto e dati vengono dal P V P: la fonte è indicata nel video.',
  ].filter(Boolean).join(' ').replace(/iCARe/g, 'ai ker');

  let voceFile = null;
  let voceDurata = null;
  if (process.env.PIPER_MODEL && fs.existsSync(process.env.PIPER_MODEL) && process.env.PIPER_BIN !== 'no') {
    try {
      voceFile = `${OUT}/voice.wav`;
      fs.writeFileSync(`${OUT}/voce.txt`, testoVoce + '\n');
      const piper = process.env.PIPER_BIN || 'piper';
      console.log(`  voce: sintesi con ${piper} · modello ${process.env.PIPER_MODELLO || 'it_IT-paola-medium'}`);
      execFileSync(piper, ['-m', process.env.PIPER_MODEL, '-c', process.env.PIPER_CONFIG, '-f', voceFile, '--length_scale', process.env.PIPER_LENGTH_SCALE || '1.05'], {
        input: testoVoce + '\n',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
      const pr = JSON.parse(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', voceFile]));
      voceDurata = Number(Number(pr.format.duration).toFixed(2));
      console.log(`  voce: ${voceDurata} s · ${fs.statSync(voceFile).size} B`);
    } catch (e) {
      console.log('  voce NON generata (' + String((e && e.message) || e).slice(0, 160) + '): il video resta muto con i sottotitoli');
      voceFile = null;
    }
  } else {
    console.log('  voce: nessun modello Piper disponibile, video muto con sottotitoli');
  }

  const formati = [
    { nome: 'verticale', W: 1080, H: 1920, file: `${OUT}/vertical.mp4`, chiave: `video/${ID}/vertical.mp4` },
    { nome: 'orizzontale', W: 1920, H: 1080, file: `${OUT}/orizzontale.mp4`, chiave: `video/${ID}/orizzontale.mp4` },
  ];

  for (const f of formati) {
    const { filter: draw, nota, margineSub } = filtriDrawtext({ W: f.W, H: f.H, durata, titolo, tribunale, prezzo, data, fonte, crediti, fonteLineaTesto });
    if (nota) console.log('  ' + nota);

    const args = ['-y'];
    for (const u of usate) args.push('-loop', '1', '-t', String(DURATA_FOTO), '-i', u.file);
    const catena = [];
    usate.forEach((u, i) => {
      const grande = f.W > f.H ? `${f.W * 2}:${f.H * 2}` : `${f.W * 2}:${f.H * 2}`;
      catena.push(
        `[${i}:v]scale=${grande}:force_original_aspect_ratio=increase:flags=lanczos,crop=${f.W * 2}:${f.H * 2},unsharp=5:5:0.6,` +
          `zoompan=z='min(1.0+0.08*on/${DURATA_FOTO * 30},1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${DURATA_FOTO * 30}:s=${f.W}x${f.H}:fps=30,` +
          `setsar=1,format=yuv420p[v${i}]`,
      );
    });
    let ultimo = 'v0';
    for (let i = 1; i < usate.length; i += 1) {
      const off = (i * (DURATA_FOTO - XFADE)).toFixed(2);
      const label = i === usate.length - 1 ? 'vcat' : `x${i}`;
      catena.push(`[${ultimo}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${off}[${label}]`);
      ultimo = label;
    }
    catena.push(`[${ultimo}]${draw ? draw + ',' : ''}subtitles='${srt.replace(/\\/g, '/')}':force_style='FontName=DejaVu Sans,Fontsize=${Math.round(f.W * 0.032)},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=${margineSub}',format=yuv420p[vout]`);

    args.push('-filter_complex', catena.join(';'), '-map', '[vout]', '-t', String(durata),
      '-c:v', 'libx264', '-crf', '23', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f.file);
    sh('ffmpeg', args);
    // mux: se c'è la voce si aggiunge l'audio con -shortest e si verifica che resti UN solo stream audio
    if (voceFile) {
      const muto = f.file.replace(/\.mp4$/, '-muto.mp4');
      fs.renameSync(f.file, muto);
      sh('ffmpeg', ['-y', '-i', muto, '-i', voceFile, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', f.file]);
      fs.rmSync(muto, { force: true });
      const audio = ff('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', f.file]);
      const nAudio = (JSON.parse(audio).streams || []).length;
      const pr2 = JSON.parse(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', f.file]));
      const dVideo = Number(pr2.format.duration);
      console.log(`  audio: ${nAudio} stream · durata finale ${dVideo.toFixed(2)} s (voce ${voceDurata} s)`);
      if (nAudio !== 1) throw new Error('il video ' + f.nome + ' non ha esattamente 1 stream audio');
      if (voceDurata && Math.abs(dVideo - voceDurata) > 0.5 && Math.abs(dVideo - durata) > 0.5) {
        throw new Error('durata video/voce disallineata di oltre 0,5 s (' + dVideo + ' vs ' + voceDurata + ')');
      }
    }
    const size = fs.statSync(f.file).size;
    const probe = JSON.parse(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', f.file]));
    const st = (probe.streams || [])[0] || {};
    console.log(`  ${f.nome}: ${size} B · ${Number(probe.format.duration).toFixed(1)} s · ${st.width}x${st.height}`);
    f.byte = size;
    f.durata = Number(Number(probe.format.duration).toFixed(2));
    f.risoluzione = `${st.width}x${st.height}`;
  }

  // upload su R2 (niente file nel repo pubblico)
  for (const f of formati) {
    f.byteR2 = await r2put(f.chiave, f.file, 'video/mp4');
    console.log(`  R2 ${f.chiave}: ${f.byteR2} B`);
  }

  await r2put(`video/${ID}/poster.jpg`, posterFile, 'image/jpeg');
  // 18/11/2026 — I BYTE SI LEGGONO DA R2, non dal file locale: la meta dichiarava 266/380 B in più
  // del file realmente servito, e un player che usa `byte` per la barra arriva al 100% e resta lì.
  // Qui si rilegge l'oggetto appena scritto: quello che la meta dichiara è quello che il player scarica.
  const posterByte = await r2size(`video/${ID}/poster.jpg`);
  const byteVert = await r2size(`video/${ID}/vertical.mp4`);
  const byteOrizz = await r2size(`video/${ID}/orizzontale.mp4`);
  console.log(`  R2 (misurato adesso): poster ${posterByte} B · verticale ${byteVert} B · orizzontale ${byteOrizz} B`);
  if (!posterByte || !byteVert || !byteOrizz) throw new Error('oggetti non leggibili su R2 dopo l upload');

  const meta = {
    lottoId: ID,
    durata,
    byte: { verticale: byteVert, orizzontale: byteOrizz },
    formato: Object.fromEntries(formati.map((f) => [f.nome, { risoluzione: f.risoluzione, durata: f.durata, chiave: f.chiave }])),
    generato: new Date().toISOString(),
    fotoUsate: usate.map((u) => ({ nome: u.nome, w: u.w, h: u.h, fonte: u.fonte || 'allegato PVP' })),
    crediti,
    creditInVideo: true,
    // il player monta subito l'anteprima senza scaricare il video; `posterKey` è la chiave R2,
    // così l'edge può servirlo anche da un'altra rotta se la forma con query non piace.
    poster: `https://careauctions.co/video/${ID}?poster=1`,
    posterKey: `video/${ID}/poster.jpg`,
    posterByte,
    sottotitoli: righeVoce.length,
    voce: voceFile
      ? { motore: 'piper', modello: process.env.PIPER_MODELLO || 'it_IT-paola-medium', durata: voceDurata, testo: testoVoce }
      : { motore: null, modello: null, durata: null, motivo: 'modello Piper non disponibile: video muto con sottotitoli' },
    fonte: fonte,
    testata: { titolo, tribunale, prezzo, data },
    note: 'video cinematico (Ken Burns, dissolvenze 0,6 s), nessuna musica, nessun volto, nessun logo di terzi',
  };
  fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1) + '\n');
  await r2put(`video/${ID}/meta.json`, `${OUT}/meta.json`, 'application/json; charset=utf-8');

  // campione da ascoltare (12 s di voce) — serve al Lead per giudicare il timbro
  let campione = null;
  if (voceFile) {
    const camp = `${OUT}/voce-campione.mp3`;
    sh('ffmpeg', ['-y', '-i', voceFile, '-t', '12', '-c:a', 'libmp3lame', '-b:a', '128k', camp]);
    campione = await r2put(`video/${ID}/voce-campione.mp3`, camp, 'audio/mpeg');
    console.log(`  campione voce su R2: video/${ID}/voce-campione.mp3 · ${campione} B`);
  }

  // verifica finale sull'artefatto: durata, risoluzione e byte su R2
  const verticale = byteVert;
  const orizzontale = byteOrizz;
  const poster = posterByte;
  // 18/11/2026 — LA PROVA È LA ROTTA PUBBLICA, non R2: `meta.byte` deve combaciare col Content-Length
  // servito a chi guarda. Se non combacia, il giro è rosso (la meta non è un'etichetta decorativa).
  const contentLength = async (url) => {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'care-video-lotto/1.0' } });
    return { stato: r.status, tipo: r.headers.get('content-type'), byte: Number(r.headers.get('content-length') || 0) };
  };
  const cls = {
    verticale: await contentLength(`${BASE}/video/${ID}?f=vertical`),
    orizzontale: await contentLength(`${BASE}/video/${ID}?f=orizzontale`),
    poster: await contentLength(`${BASE}/video/${ID}?poster=1`),
  };
  console.log('  rotta pubblica: ' + JSON.stringify(cls));
  const incoerenti = [];
  if (cls.verticale.byte && cls.verticale.byte !== meta.byte.verticale) incoerenti.push(`verticale meta ${meta.byte.verticale} ≠ rotta ${cls.verticale.byte}`);
  if (cls.orizzontale.byte && cls.orizzontale.byte !== meta.byte.orizzontale) incoerenti.push(`orizzontale meta ${meta.byte.orizzontale} ≠ rotta ${cls.orizzontale.byte}`);
  if (cls.poster.byte && cls.poster.byte !== meta.posterByte) incoerenti.push(`poster meta ${meta.posterByte} ≠ rotta ${cls.poster.byte}`);
  if (incoerenti.length) {
    console.error('::error title=video-lotto::meta e rotta pubblica NON combaciano — ' + incoerenti.join(' · '));
    console.error('  (se la rotta non è ancora deployata per questo lotto, i campi a 0 sono tollerati: nessun confronto possibile)');
    if (incoerenti.some((x) => /≠ rotta [1-9]/.test(x))) process.exitCode = 1;
  }
  if (!poster || poster > 200 * 1024) {
    console.error('::error title=video-lotto::poster assente o oltre 200 KB su R2');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ esito: 'ok', meta, r2: { verticale, orizzontale, poster } }, null, 1));
  if (!verticale || verticale <= 500 * 1024 || !orizzontale || orizzontale <= 500 * 1024) {
    console.error('::error title=video-lotto::file su R2 assenti o sotto 500 KB');
    process.exitCode = 1;
    return;
  }
  if (Math.abs(formati[0].durata - formati[1].durata) > 0.2) {
    console.error('::error title=video-lotto::durate diverse fra i due formati');
    process.exitCode = 1;
    return;
  }
  console.log('::notice title=video-lotto::video pubblicati su R2 per il lotto ' + ID);
}

main().catch((e) => {
  console.error('[fatal] ' + String((e && e.stack) || e));
  process.exitCode = 1;
});
