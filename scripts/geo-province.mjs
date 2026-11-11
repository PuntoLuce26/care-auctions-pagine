#!/usr/bin/env node
/** geo-province.mjs — confini delle province italiane, snelliti per la mappa delle rendite.
 *  Fonte: openpolis/geojson-italy (limiti amministrativi ISTAT, licenza CC-BY 4.0).
 *  Uscita: feed/geo-province.json — properties {sigla, nome, regione}, coordinate a 3 decimali
 *  (~100 m: più che sufficiente per una coropleta) e poligoni minuscoli scartati.
 *  Serve alla mappa rendite: si unisce a omi-indice.json → provinceInfo[sigla].renditaMedianaPct. */
import fs from 'node:fs';

const SRC = 'https://raw.githubusercontent.com/openpolis/geojson-italy/master/geojson/limits_IT_provinces.geojson';
const OUT = process.argv[2] || 'feed/geo-province.json';
const DEC = Number(process.argv[3] || 3);        // decimali delle coordinate
const MIN_PUNTI = Number(process.argv[4] || 8);  // poligoni con meno punti si scartano

const r = (n) => Math.round(n * 10 ** DEC) / 10 ** DEC;
const semplifica = (ring) => {
  const out = [];
  for (const [lon, lat] of ring) {
    const p = [r(lon), r(lat)];
    const ultimo = out[out.length - 1];
    if (!ultimo || ultimo[0] !== p[0] || ultimo[1] !== p[1]) out.push(p);
  }
  return out.length >= MIN_PUNTI ? out : null;
};

const risposta = await fetch(SRC, { headers: { 'User-Agent': 'CARe-geo' } });
if (!risposta.ok) { console.error('sorgente non raggiungibile', risposta.status); process.exit(1); }
const geo = await risposta.json();

const features = [];
for (const f of geo.features) {
  const p = f.properties || {};
  const sigla = (p.prov_acr || '').trim().toUpperCase();
  if (!sigla) continue;
  const g = f.geometry;
  let geometria = null;
  if (g.type === 'Polygon') {
    const anelli = g.coordinates.map(semplifica).filter(Boolean);
    if (anelli.length) geometria = { type: 'Polygon', coordinates: anelli };
  } else if (g.type === 'MultiPolygon') {
    const poli = g.coordinates.map((poly) => poly.map(semplifica).filter(Boolean)).filter((poly) => poly.length && poly[0].length);
    if (poli.length) geometria = { type: 'MultiPolygon', coordinates: poli };
  }
  if (!geometria) continue;
  features.push({ type: 'Feature', properties: { sigla, nome: p.prov_name || '', regione: p.reg_name || '' }, geometry: geometria });
}

const out = { type: 'FeatureCollection', meta: { fonte: 'openpolis/geojson-italy — limiti ISTAT (CC-BY 4.0)', elaborato: new Date().toISOString(), decimali: DEC, province: features.length, nota: 'Confini semplificati per la mappa delle rendite OMI di CAReIndex.' }, features };
fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('province:', features.length, '· decimali', DEC, '·', (fs.statSync(OUT).size / 1024).toFixed(0), 'KB →', OUT);
