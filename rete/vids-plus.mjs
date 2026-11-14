#!/usr/bin/env node
/**
 * VIDS+ v1 — collaudo video per Instagram/CARe.
 * Contratto: node vids-plus.mjs <file|url>; exit 0 PASS, 2 FAIL.
 * Richiede ffprobe (CI) o ffmpeg (fallback locale).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const src0 = process.argv[2] || process.env.VIDEO_URL || process.env.VIDEO_PATH || '';
if (!src0) { console.error('VIDS+: serve un file o URL'); process.exit(2); }

let src = src0;
if (/^https?:\/\//i.test(src0)) {
  const r = await fetch(src0, { headers: { 'User-Agent': 'CARe-VIDS/1.0' } });
  if (!r.ok) { console.error('VIDS+: download fallito HTTP ' + r.status); process.exit(2); }
  src = path.join('/tmp', 'vids-plus-' + Date.now() + '.mp4');
  fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
}
if (!fs.existsSync(src)) { console.error('VIDS+: file inesistente'); process.exit(2); }

function probe() {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src], { encoding: 'utf8' });
    const j = JSON.parse(out);
    const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
    const a = (j.streams || []).filter(s => s.codec_type === 'audio');
    const fr = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/');
    const fps = Number(fr[1]) ? Number(fr[0]) / Number(fr[1]) : Number(fr[0]) || 0;
    return { width: Number(v.width) || 0, height: Number(v.height) || 0, fps: +fps.toFixed(2), codec: v.codec_name || null, duration: Number(j.format?.duration) || 0, audio: a.length };
  } catch {
    // fallback: ffmpeg -i, niente ffprobe sul Mac
    const txt = (() => { try { return execFileSync(FFMPEG, ['-hide_banner', '-i', src], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stderr || ''); } })();
    const d = (txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/) || []);
    const duration = d.length ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0;
    const v = (txt.match(/Video:.*?(\d{2,5})x(\d{2,5})/) || []);
    const fpsM = (txt.match(/(\d+(?:\.\d+)?)\s*fps/) || []);
    return { width: v.length ? +v[1] : 0, height: v.length ? +v[2] : 0, fps: fpsM.length ? +(+fpsM[1]).toFixed(2) : 0, codec: /Video:\s*(\w+)/.exec(txt)?.[1] || null, duration: +duration.toFixed(2), audio: /Audio:/.test(txt) ? 1 : 0 };
  }
}

const info = probe();
function blackSeconds() {
  try {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-i', src, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
    return parseBlack(String(r.stderr || '') + String(r.stdout || ''));
  } catch (e) { return parseBlack(String(e.stderr || '')); }
  function parseBlack(txt) {
    let somma = 0; const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g; let m;
    while ((m = re.exec(txt))) somma += Math.max(0, Number(m[2]) - Number(m[1]));
    return +somma.toFixed(2);
  }
}
const nero = blackSeconds();
const checks = [
  { nome: 'durata >= 3s', ok: info.duration >= 3 },
  { nome: 'verticale (h > w)', ok: info.height > info.width },
  { nome: '2160x3840 (4K IG)', ok: info.width === 2160 && info.height === 3840 },
  { nome: '30 fps', ok: Math.abs(info.fps - 30) <= 0.6 },
  { nome: 'H.264', ok: String(info.codec || '').toLowerCase() === 'h264' },
  { nome: 'muto (IG)', ok: info.audio === 0 },
  { nome: 'nessun black-frame >= 0,5s', ok: nero < 0.5, black_seconds: nero },
];
const verdetto = checks.every(c => c.ok) ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ gate: 'VIDS+', src: src0, info, checks, verdetto }, null, 2));
process.exit(verdetto === 'PASS' ? 0 : 2);
