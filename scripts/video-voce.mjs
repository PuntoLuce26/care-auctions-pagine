#!/usr/bin/env node
/**
 * video-voce.mjs — mette la VOCE italiana (Piper it_IT) sui video del lotto già generati.
 *
 * PERCHÉ QUI E NON NEL WORKER: la voce italiana non esiste su Workers AI (melotts: en/es/fr/jp/kr/zh,
 * deepgram: inglese). L'italiano passa dalla CI, dove girano già ffmpeg e i PDF delle perizie.
 * L'azione `tts` del worker `icare-ai` resta per l'inglese, i test e gli usi web.
 *
 * REGOLA DI BRAND (ferma, non rimuovere): la parola «iCARe» si pronuncia «ai ker». La sostituzione
 * avviene PRIMA della sintesi, con lo stesso replace dell'azione tts del worker.
 *
 * NON tocca gli originali: legge video-out/{vertical,orizzontale}.mp4 e scrive
 * video-out/{vertical,orizzontale}-voce.mp4 + voce.wav + campione-15s.wav + voce-meta.json,
 * poi pubblica su R2 `care-stato` sotto video/<id>/ (gli originali restano).
 *
 * Uso: PIPER_DIR=$HOME/piper-bin VOICE=$HOME/piper-voce/it_IT-paola-medium.onnx \
 *      node scripts/video-voce.mjs <lottoId>
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ID = String(process.argv[2] || '').trim();
if (!ID) { console.error('serve il lottoId'); process.exit(2); }
const OUT = process.env.VIDEO_OUT || 'video-out';
const PIPER_DIR = process.env.PIPER_DIR || `${process.env.HOME}/piper-bin`;
const VOICE = process.env.VOICE || `${process.env.HOME}/piper-voce/it_IT-paola-medium.onnx`;
const ACC = 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const BUCKET = process.env.R2_BUCKET || 'care-stato';
const TK = process.env.CLOUDFLARE_API_TOKEN || '';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')}… → ${String(r.stderr || r.error).slice(0, 300)}`);
  return String(r.stdout || '');
}
function shOut(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LD_LIBRARY_PATH: PIPER_DIR } });
  return r;
}
function durata(file) {
  const o = sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(String(o).trim());
}
function streams(file) {
  const o = sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', file]);
  return String(o).trim().split('\n').filter(Boolean);
}
async function r2put(chiave, file, contentType) {
  if (!TK) throw new Error('CLOUDFLARE_API_TOKEN assente: i video vanno su R2, non nel repo');
  const body = fs.readFileSync(file);
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/${BUCKET}/objects/${chiave.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${TK}`, 'Content-Type': contentType }, body,
  });
  if (!r.ok) throw new Error(`R2 ${chiave}: HTTP ${r.status} ${String(await r.text()).slice(0, 200)}`);
  return body.length;
}

const metaIn = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, 'utf8'));
const testata = metaIn.testata || {};
const titolo = String(testata.titolo || `Lotto ${ID}`).replace(/\s+/g, ' ').trim();
const tribunale = String(testata.tribunale || '').replace(/^Tribunale di\s*/i, '').trim();
const prezzoTxt = String(testata.prezzo || '').replace(/^Prezzo base:\s*/i, '').trim(); // es. "12.250 €"
const dataTxt = String(testata.data || '').replace(/^Data asta:\s*/i, '').trim();       // es. "25/02/2027"

// TESTO DEL VIDEO (20-25 s, tono sobrio, nessun aggettivo da venditore). Ogni numero ha la fonte
// accanto: la scheda ufficiale del PVP. Ordine: cosa è, dove, quanto, quando, da dove vengono le foto.
const righe = [
  `${titolo}.`,
  tribunale ? `Tribunale di ${tribunale}.` : '',
  prezzoTxt ? `Prezzo base ${prezzoTxt}, come indicato nella scheda della procedura sul PVP.` : '',
  dataTxt ? `Data dell'asta: ${dataTxt}, dalla scheda della procedura sul PVP.` : '',
  `Le immagini sono gli allegati pubblicati sulla procedura, fonte PVP.`,
  `CAReAuctions è consulente di parte del compratore: non fa mediazione e non prende provvigioni.`,
].filter(Boolean);
// REGOLA DI BRAND: «iCARe» → «ai ker» prima della sintesi (stesso replace dell'azione tts del worker)
const marchioPresente = /iCARe/i.test(righe.join(' '));
const testo = righe.join(' ').replace(/iCARe/gi, 'ai ker');
if (testo.length > 600) throw new Error(`testo troppo lungo per la voce: ${testo.length} caratteri`);
console.log(`  testo voce (${testo.length} caratteri): ${testo.slice(0, 120)}…`);

// 1) SINTESI (Piper it_IT, length_scale > 1 = più lento: il ritmo deve stare dietro ai sottotitoli)
const wav = `${OUT}/voce.wav`;
{
  const r = shOut(`${PIPER_DIR}/piper`, ['--model', VOICE, '--config', `${VOICE}.json`, '--output_file', wav, '--length_scale', process.env.VOCE_LENTEZZA || '1.15', '--sentence_silence', '0.35'], testo);
  if (r.status !== 0 || !fs.existsSync(wav)) throw new Error(`piper: ${String(r.stderr || r.error).slice(0, 300)}`);
  const d = durata(wav);
  console.log(`  voce.wav: ${fs.statSync(wav).size} B · ${d.toFixed(2)} s`);
  if (!(d > 1)) throw new Error('voce troppo corta: la sintesi non ha prodotto audio utile');
}

// 2) CAMPIONE 15 s da ascoltare (primo pezzo dello stesso wav, senza ricodifica)
sh('ffmpeg', ['-y', '-i', wav, '-t', '15', '-c', 'copy', `${OUT}/campione-15s.wav`]);

// 3) MUX: se la voce è più lunga del video si allunga il video con l'ultimo fotogramma (tpad),
//    così -shortest non taglia la frase; se è più corta, il video tiene la sua durata.
const risultati = [];
for (const f of [
  { nome: 'verticale', file: `${OUT}/vertical.mp4`, out: `${OUT}/vertical-voce.mp4`, chiave: `video/${ID}/vertical-voce.mp4` },
  { nome: 'orizzontale', file: `${OUT}/orizzontale.mp4`, out: `${OUT}/orizzontale-voce.mp4`, chiave: `video/${ID}/orizzontale-voce.mp4` },
]) {
  if (!fs.existsSync(f.file)) { console.log(`  ! ${f.nome}: assente, salto`); continue; }
  const dv = durata(f.file), da = durata(wav);
  const pad = Math.max(0, da - dv + 0.4);
  const filtro = `[0:v]tpad=stop_mode=clone:stop_duration=${pad.toFixed(2)}[v]`;
  sh('ffmpeg', ['-y', '-i', f.file, '-i', wav, '-filter_complex', filtro, '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-shortest', '-movflags', '+faststart', f.out]);
  // 4) VERIFICA sull artefatto: 1 stream audio e durata coerente (±0,5 s dal video finale)
  const st = streams(f.out);
  const audio = st.filter((x) => x === 'audio').length;
  const dvf = durata(f.out);
  const ok = audio === 1 && Math.abs(dvf - da) <= 0.5 + 0.05;
  console.log(`  ${f.nome}-voce.mp4: ${fs.statSync(f.out).size} B · audio=${audio} · durata=${dvf.toFixed(2)} s (voce ${da.toFixed(2)} s) ${ok ? 'OK' : 'KO'}`);
  if (!ok) throw new Error(`${f.nome}: verifica fallita (audio=${audio}, durata ${dvf.toFixed(2)} vs voce ${da.toFixed(2)})`);
  const byte = await r2put(f.chiave, f.out, 'video/mp4');
  console.log(`  R2 ${f.chiave}: ${byte} B`);
  risultati.push({ nome: f.nome, chiave: f.chiave, byte, durata: Number(dvf.toFixed(2)), audio });
}

// 5) voce.wav, campione e meta su R2 (così il campione è ascoltabile senza pescare l'artefatto)
await r2put(`video/${ID}/voce.wav`, wav, 'audio/wav');
await r2put(`video/${ID}/campione-15s.wav`, `${OUT}/campione-15s.wav`, 'audio/wav');
const meta = {
  lottoId: ID, voce: 'piper it_IT-paola-medium', marchio: marchioPresente ? 'ai ker (sostituito prima della sintesi)' : 'non presente',
  testo, testoLunghezza: testo.length, durataVoce: Number(durata(wav).toFixed(2)),
  file: risultati, generato: new Date().toISOString(),
};
fs.writeFileSync(`${OUT}/voce-meta.json`, JSON.stringify(meta, null, 1) + '\n');
await r2put(`video/${ID}/voce-meta.json`, `${OUT}/voce-meta.json`, 'application/json; charset=utf-8');
console.log(`  voce-meta su R2 · voce ${meta.durataVoce} s · ${risultati.length} video con audio`);
