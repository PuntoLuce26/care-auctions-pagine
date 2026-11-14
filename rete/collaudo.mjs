#!/usr/bin/env node
/**
 * Collaudo della Rete+ v1: esegue i 4 gate su casi buoni e cattivi.
 * Verde = tutti i gate passano sui casi attesi E EMERGENT+ passa in produzione.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, 'fixtures');
const TMP = '/tmp/rete-vids';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
fs.mkdirSync(TMP, { recursive: true });
const esiti = [];
function run(gate, script, args = [], atteso = 0) {
  const r = spawnSync(process.execPath, [path.join(DIR, script), ...args], { encoding: 'utf8', env: process.env, timeout: 120000 });
  const ok = r.status === atteso;
  esiti.push({ gate, caso: args[0] ? path.basename(args[0]) : 'produzione', atteso, esito: r.status, ok, stdout: (r.stdout || '').slice(0, 1200), stderr: (r.stderr || '').slice(0, 400) });
  console.log(`${ok ? 'OK ' : 'KO '} ${gate} ${args[0] ? path.basename(args[0]) : 'produzione'} → exit ${r.status} (atteso ${atteso})`);
  return ok;
}
// Fixture video: buono 4K verticale muto 3s; cattivo 720p con audio.
const buono = path.join(TMP, 'buono.mp4');
const cattivo = path.join(TMP, 'cattivo.mp4');
execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x0F1E3A:s=2160x3840:d=3:r=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', buono], { stdio: 'ignore' });
execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x0F1E3A:s=1280x720:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', cattivo], { stdio: 'ignore' });

run('VIDS+', 'vids-plus.mjs', [buono], 0);
run('VIDS+', 'vids-plus.mjs', [cattivo], 2);
run('EINSTEIN+', 'einstein-plus.mjs', [path.join(FIX, 'brief-ok.json')], 0);
run('EINSTEIN+', 'einstein-plus.mjs', [path.join(FIX, 'brief-ko.json')], 2);
run('GREEN2+', 'green2-plus.mjs', [path.join(FIX, 'claims-ok.json')], 0);
run('GREEN2+', 'green2-plus.mjs', [path.join(FIX, 'claims-ko.json')], 2);
run('EMERGENT+', 'emergent-plus.mjs', [], 0);

const stato = { generatoIl: new Date().toISOString(), rete: 'RETE+ v1', gate: 4, esiti, verdetto: esiti.every(e => e.ok) ? 'VERDE' : 'ROSSO' };
const uscita = path.join(process.cwd(), 'rete/stato.json');
fs.mkdirSync(path.dirname(uscita), { recursive: true });
fs.writeFileSync(uscita, JSON.stringify(stato, null, 2) + '\n');
console.log('\n' + JSON.stringify({ verdetto: stato.verdetto, esiti: esiti.map(e => `${e.gate}:${e.ok ? 'OK' : 'KO'}`) }, null, 2));
process.exit(stato.verdetto === 'VERDE' ? 0 : 1);
