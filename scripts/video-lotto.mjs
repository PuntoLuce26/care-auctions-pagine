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

function filtriDrawtext({ W, H, durata, titolo, tribunale, prezzo, data, fonte, crediti }) {
  const f = font();
  if (!f) {
    console.warn('  ! nessun font trovato: si procede SENZA sovraimpressioni (dichiarato in meta.json)');
    return { filter: '', nota: 'sovraimpressioni saltate: nessun font' };
  }
  const t1 = scriviTesto(`${OUT}/t1.txt`, [titolo, tribunale]);
  const t2 = scriviTesto(`${OUT}/t2.txt`, [prezzo, data, fonte]);
  const comune = `fontfile=${f}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18`;
  const apertura = `drawtext=${comune}:textfile='${t1}':fontsize=${Math.round(W * 0.045)}:x=(w-text_w)/2:y=h*0.70:enable='between(t,0,3.4)'`;
  const chiusura = `drawtext=${comune}:textfile='${t2}':fontsize=${Math.round(W * 0.038)}:x=(w-text_w)/2:y=h*0.55:enable='between(t,${Math.max(0, durata - 5).toFixed(2)},${durata.toFixed(2)})'`;
  const creditiTxt = scriviTesto(`${OUT}/t3.txt`, [crediti]);
  const creditiFilter = `drawtext=${comune}:textfile='${creditiTxt}':fontsize=${Math.round(W * 0.026)}:x=(w-text_w)/2:y=h*0.68:enable='between(t,${Math.max(0, durata - 5).toFixed(2)},${durata.toFixed(2)})'`;
  const marchio = `drawtext=fontfile=${f}:text='CAReAuctions':fontcolor=white@0.85:fontsize=${Math.round(W * 0.026)}:x=w-text_w-24:y=h-text_h-20`;
  return { filter: [apertura, chiusura, creditiFilter, marchio].join(','), nota: 'sovraimpressioni con ' + f + ' · crediti fonti nel video' };
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
      const estratti = fs.readdirSync(OUT).filter((f) => /^pdfimg-\d+\.png$/.test(f)).sort();
      console.log(`  perizia: ${estratti.length} immagini estratte dal PDF`);
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
  const doc = await (await fetch(`${BASE}/api/pvp-documenti/${ID}`)).json();
  if (!doc || !doc.ok || !Array.isArray(doc.allegati)) throw new Error('documenti non leggibili per il lotto ' + ID);
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
      if (!w || !h || Math.min(w, h) < MIN_LATO) {
        console.log(`  - scarto ${a.n} (${w}x${h}, lato corto < ${MIN_LATO}) [${byte} B]`);
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

  // v1 — CREDITI FONTI nel video (da dove viene ogni foto) e SOTTOTITOLI BRUCIATI (leggibili senza audio).
  const daPdfN = usate.filter((u) => String(u.fonte || '').startsWith('perizia')).length;
  const crediti = daPdfN ? `Foto: perizia PDF (${daPdfN} immagini)` : 'Foto: allegati PVP';
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

  const formati = [
    { nome: 'verticale', W: 1080, H: 1920, file: `${OUT}/vertical.mp4`, chiave: `video/${ID}/vertical.mp4` },
    { nome: 'orizzontale', W: 1920, H: 1080, file: `${OUT}/orizzontale.mp4`, chiave: `video/${ID}/orizzontale.mp4` },
  ];

  for (const f of formati) {
    const { filter: draw, nota } = filtriDrawtext({ W: f.W, H: f.H, durata, titolo, tribunale, prezzo, data, fonte, crediti });
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
    catena.push(`[${ultimo}]${draw ? draw + ',' : ''}subtitles='${srt.replace(/\\/g, '/')}':force_style='FontName=DejaVu Sans,Fontsize=${Math.round(f.W * 0.032)},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=${Math.round(f.H * 0.12)}',format=yuv420p[vout]`);

    args.push('-filter_complex', catena.join(';'), '-map', '[vout]', '-t', String(durata),
      '-c:v', 'libx264', '-crf', '23', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f.file);
    sh('ffmpeg', args);
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

  const meta = {
    lottoId: ID,
    durata,
    byte: Object.fromEntries(formati.map((f) => [f.nome, f.byte])),
    formato: Object.fromEntries(formati.map((f) => [f.nome, { risoluzione: f.risoluzione, durata: f.durata, chiave: f.chiave }])),
    generato: new Date().toISOString(),
    fotoUsate: usate.map((u) => ({ nome: u.nome, w: u.w, h: u.h, fonte: u.fonte || 'allegato PVP' })),
    crediti,
    sottotitoli: righeVoce.length,
    voce: 'non inclusa: v1 senza endpoint TTS HTTP (vedi referto)',
    fonte: fonte,
    testata: { titolo, tribunale, prezzo, data },
    note: 'video cinematico (Ken Burns, dissolvenze 0,6 s), nessuna musica, nessun volto, nessun logo di terzi',
  };
  fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 1) + '\n');
  await r2put(`video/${ID}/meta.json`, `${OUT}/meta.json`, 'application/json; charset=utf-8');

  // verifica finale sull'artefatto: durata, risoluzione e byte su R2
  const verticale = await r2size(`video/${ID}/vertical.mp4`);
  const orizzontale = await r2size(`video/${ID}/orizzontale.mp4`);
  console.log(JSON.stringify({ esito: 'ok', meta, r2: { verticale, orizzontale } }, null, 1));
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
