#!/usr/bin/env node
// RETE+ — DOPPIO ESECUTORE (rete-doppio-esecutore)
//
// Esegue LO STESSO LAVORO su due esecutori indipendenti e confronta gli esiti:
//   A) GitHub Actions  — ffmpeg del runner ubuntu (processo locale, questo script)
//   B) Cloudflare Containers — container `esecutore-b` con ffmpeg, via HTTPS
//
// Il lavoro (uno solo, fisso, deterministico):
//   1) 1 secondo di video `testsrc` 320x240 @ 25 fps (H.264)
//   2) frame a 0,5 s estratto in pixel grezzi RGB24 (230.400 byte)
//   3) sha256 sui byte del frame → è la grandezza che si confronta
//
// Perché i pixel grezzi e non il PNG/JPEG: l'encoder PNG può cambiare byte fra
// versioni di zlib/ffmpeg, i pixel no. Così un'eventuale divergenza è vera
// divergenza del decodificatore, non del formato di uscita.
//
// Verdetto:
//   COERENTE           → i due sha256 sono uguali
//   INCOERENTE         → sha256 diversi (dichiarato, con le DUE versioni di ffmpeg)
//   B_NON_DISPONIBILE  → il container non ha risposto: la ridondanza è 0 su 1, dichiarato
//
// Scrive `rete/doppio-esecutore.json` (e lo stampa). Zero dipendenze: solo Node 22 + ffmpeg.
//
// Uso:
//   node scripts/rete-doppio-esecutore.mjs
//   ESECUTORE_B_URL=https://... node scripts/rete-doppio-esecutore.mjs
//   node scripts/rete-doppio-esecutore.mjs --url=https://... --out=percorso.json

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, readFile as rf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const JOB = 'testsrc-320x240-25fps-1s-frame0.5s-rgb24';
const TIMEOUT_FFMPEG_MS = 60_000;
const TIMEOUT_HTTP_MS = 120_000;

function arg(nome) {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p ? p.slice(nome.length + 3) : undefined;
}

async function leggiConfig() {
  if (process.env.ESECUTORE_B_URL) return process.env.ESECUTORE_B_URL.trim();
  const daArg = arg('url');
  if (daArg) return daArg.trim();
  try {
    const j = JSON.parse(await rf('rete/esecutore-b.json', 'utf8'));
    if (j && typeof j.url === 'string' && j.url.trim()) return j.url.trim();
  } catch {
    /* nessun file di configurazione: si dichiara sotto */
  }
  return '';
}

function esegui(cmd, args, timeout) {
  return new Promise((ok) => {
    const t0 = Date.now();
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      ok({
        err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        ms: Date.now() - t0,
      });
    });
  });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function lavoroA() {
  const dir = await mkdtemp(join(tmpdir(), 'rete-a-'));
  const out = join(dir, 'out.mp4');
  const frame = join(dir, 'frame.rgb');
  try {
    const ver = await esegui('ffmpeg', ['-version'], 15_000);
    if (ver.err && (ver.err.code === 'ENOENT' || /ENOENT|not found/i.test(String(ver.err.message)))) {
      return { eseguito: false, esecutore: 'github-actions', errore: 'ffmpeg-assente', dettaglio: 'ffmpeg non è installato su questo esecutore', versione: null };
    }
    const versione = ver.err ? null : ver.stdout.split('\n')[0].trim();

    const t0 = Date.now();
    const enc = await esegui('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=1',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-movflags', '+faststart', '-f', 'mp4', out,
    ], TIMEOUT_FFMPEG_MS);
    if (enc.err) {
      return { eseguito: false, errore: 'ffmpeg-encode', dettaglio: enc.stderr.slice(-600), versione };
    }

    const ext = await esegui('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', '0.5', '-i', out, '-frames:v', '1',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', frame,
    ], TIMEOUT_FFMPEG_MS);
    if (ext.err) {
      return { eseguito: false, errore: 'ffmpeg-frame', dettaglio: ext.stderr.slice(-600), versione };
    }

    const raw = await readFile(frame);
    return {
      eseguito: true,
      esecutore: 'github-actions',
      sha: sha256(raw),
      versione,
      durataMs: Date.now() - t0,
      frameBytes: raw.length,
      job: JOB,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function lavoroB(url) {
  if (!url) {
    return { eseguito: false, esecutore: 'cloudflare-containers', errore: 'url-non-configurata' };
  }
  const t0 = Date.now();
  let salute;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/salute`, { signal: AbortSignal.timeout(30_000) });
    salute = { http: r.status, body: await r.text() };
  } catch (e) {
    return { eseguito: false, esecutore: 'cloudflare-containers', url, errore: 'salute-irraggiungibile', dettaglio: String(e && e.message) };
  }
  let saluteJson = null;
  try { saluteJson = JSON.parse(salute.body); } catch { /* non json */ }
  if (salute.http !== 200) {
    return { eseguito: false, esecutore: 'cloudflare-containers', url, errore: `salute-http-${salute.http}`, dettaglio: salute.body.slice(0, 300) };
  }
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/lavoro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job: 'default' }),
      signal: AbortSignal.timeout(TIMEOUT_HTTP_MS),
    });
    const testo = await r.text();
    let j;
    try { j = JSON.parse(testo); } catch { return { eseguito: false, url, errore: 'risposta-non-json', dettaglio: testo.slice(0, 300) }; }
    if (r.status !== 200 || !j.ok) {
      return { eseguito: false, esecutore: 'cloudflare-containers', url, errore: `lavoro-http-${r.status}`, dettaglio: testo.slice(0, 300) };
    }
    return {
      eseguito: true,
      esecutore: 'cloudflare-containers',
      url,
      sha: j.sha256,
      versione: j.ffmpeg,
      durataMs: j.durataMs,
      durataHttpMs: Date.now() - t0,
      frameBytes: j.frameBytes,
      job: j.job || JOB,
      salute: saluteJson,
    };
  } catch (e) {
    return { eseguito: false, esecutore: 'cloudflare-containers', url, errore: 'lavoro-irraggiungibile', dettaglio: String(e && e.message) };
  }
}

function verdetto(A, B) {
  if (!A.eseguito) return 'A_NON_ESEGUITO';
  if (!B.eseguito) return 'B_NON_DISPONIBILE';
  return A.sha && B.sha && A.sha === B.sha ? 'COERENTE' : 'INCOERENTE';
}

const url = await leggiConfig();
const [A, B] = await Promise.all([lavoroA(), lavoroB(url)]);
const v = verdetto(A, B);

const out = {
  eseguito: new Date().toISOString(),
  cadenza: 'giornaliera (schedule 0 4 * * *) + workflow_dispatch',
  lavoro: JOB,
  confronto: 'sha256 dei byte RGB24 del frame a 0,5 s (320x240x3 = 230.400 byte)',
  A,
  B,
  verdetto: v,
  nota:
    v === 'COERENTE'
      ? 'stesso lavoro, stesso esito sui due esecutori: la ridondanza è verificata, non dichiarata'
      : v === 'A_NON_ESEGUITO'
        ? 'esecutore A (GitHub Actions) non ha eseguito il lavoro: il confronto non esiste. Motivo esatto in A.errore.'
        : v === 'INCOERENTE'
        ? 'sha256 diversi: gli esecutori NON sono equivalenti su questo lavoro. Le due versioni di ffmpeg sono nel record. Un verdetto INCOERENTE non si nasconde e non si "aggiusta": si dichiara.'
        : 'esecutore B non disponibile: la Rete+ ha UN solo esecutore su due, cioè ridondanza 0 su 1. Il motivo esatto è nel campo B.errore.',
};

const percorso = resolve(arg('out') || 'rete/doppio-esecutore.json');
await mkdir(dirname(percorso), { recursive: true });
await writeFile(percorso, JSON.stringify(out, null, 2) + '\n');

console.log(`A (github-actions)      sha=${A.sha || '-'} ${A.durataMs != null ? A.durataMs + ' ms' : ''} ${A.versione || A.errore || ''}`);
console.log(`B (cloudflare-container) sha=${B.sha || '-'} ${B.durataMs != null ? B.durataMs + ' ms' : ''} ${B.versione || B.errore || ''}`);
console.log(`VERDETTO: ${v}`);
console.log(`scritto: ${percorso}`);

if (!A.eseguito) process.exit(1);
process.exit(B.eseguito ? 0 : 2);
