#!/usr/bin/env node
/** omi-zone-geo.mjs — i POLIGONI delle zone OMI, semplificati, pronti per una mappa.
 *  L'indice `feed/omi-zone-centroidi.json` ha solo centro e riquadro: per disegnare le zone
 *  servono i confini, che stanno nei KML dentro gli ZIP ufficiali.
 *  Uscita: feed/omi-zone-geo/<CODCOM>.json — GeoJSON FeatureCollection, una feature per zona,
 *  con properties { linkZona, zona, fascia, microzona, areaKmq } e coordinate a 4 decimali (~11 m).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const DEC = 4;
const OUT = 'feed/omi-zone-geo';
const RAW = process.argv[2] || path.join(os.homedir(), 'Downloads');
const solo = process.argv[3] || null;   // se passato, fa solo quel CODCOM

const aste = JSON.parse(fs.readFileSync('feed/aste-zone.json', 'utf8'));
const codici = [...new Set(aste.zone.map((z) => z.codcom))].filter(Boolean);
const daFare = solo ? [solo] : codici;
console.log('comuni da disegnare:', daFare.length);

// lo ZIP più recente che contiene i KML (i nazionali QIP*)
const zip = fs.readdirSync(RAW).filter((f) => /^QIP\d+.*\.zip$/i.test(f))
  .map((f) => ({ f, m: fs.statSync(path.join(RAW, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0]?.f;
if (!zip) { console.error('nessun ZIP QIP* in', RAW); process.exit(1); }
console.log('ZIP zone:', zip);

const r = (n) => Math.round(n * 10 ** DEC) / 10 ** DEC;
function polyCoords(testo) {
  // i poligoni sono dentro <coordinates> … "lon,lat,0 lon,lat,0 …"
  const out = [];
  const re = /<coordinates>([\s\S]*?)<\/coordinates>/g;
  let m;
  while ((m = re.exec(testo)) !== null) {
    const punti = m[1].trim().split(/\s+/).map((p) => {
      const [lon, lat] = p.split(',');
      const x = Number(lon), y = Number(lat);
      return isFinite(x) && isFinite(y) ? [r(x), r(y)] : null;
    }).filter(Boolean);
    if (punti.length >= 4) out.push(punti);
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
let tot = 0;
for (const cod of daFare) {
  const kml = (() => { try { return execFileSync('unzip', ['-p', path.join(RAW, zip), cod + '.kml'], { maxBuffer: 40 * 1024 * 1024, encoding: 'latin1' }); } catch (e) { return null; } })();
  if (!kml) { console.log(' senza KML:', cod); continue; }
  const placemark = kml.split(/<Placemark>/i).slice(1);
  const features = [];
  for (const pm of placemark) {
    const name = (pm.match(/<name>([\s\S]*?)<\/name>/i) || [, ''])[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const parti = polyCoords(pm);
    if (!parti.length) continue;
    // nome del Placemark: contiene la zona, tipo "Zona B1" o "B1"
    const mz = name.match(/\b([A-Z]{1,2}\d{1,3})\b/);
    const zona = mz ? mz[1] : name.slice(0, 12);
    features.push({ type: 'Feature', properties: { zona, nome: name.slice(0, 60) },
      geometry: { type: parti.length === 1 ? 'Polygon' : 'MultiPolygon', coordinates: parti.length === 1 ? [parti[0]] : parti.map((p) => [p]) } });
  }
  if (!features.length) { console.log(' nessun poligono:', cod); continue; }
  fs.writeFileSync(path.join(OUT, cod + '.json'), JSON.stringify({ type: 'FeatureCollection',
    meta: { codcom: cod, fonte: 'Agenzia delle Entrate – OMI, perimetri di zona (KML)', semestre: '2026/1', decimali: DEC,
      nota: 'Confini semplificati per la mappa. I poligoni originali restano negli ZIP ufficiali.' },
    features }));
  tot += features.length;
  console.log(' ', cod, '·', features.length, 'zone ·', (fs.statSync(path.join(OUT, cod + '.json')).size / 1024).toFixed(0), 'KB');
}
console.log('totale zone disegnate:', tot);
