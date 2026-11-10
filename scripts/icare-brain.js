#!/usr/bin/env node
// iCARe brain — cloud generator (GitHub Actions). Reads public feeds + optional Second Brain
// registry; writes ai/cervello.json with public/registered knowledge. NEVER writes internal data.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const BASE = 'https://puntoluce26.github.io/care-auctions-pagine/';
const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/';
async function get(u, opt) {
  try { const r = await fetch(u, Object.assign({ headers: { 'User-Agent': 'CARe-iCARe-Brain/1.0' } }, opt || {})); if (!r.ok) return null; return await r.text(); } catch (e) { return null; }
}
async function j(u) { const t = await get(u); if (!t) return null; try { return JSON.parse(t); } catch (e) { return null; } }
(async () => {
  const st = await j(BASE + 'feed/statistiche.json');
  const es = await j(BASE + 'feed/esiti-statistiche.json');
  const fo = await j(BASE + 'feed/foto-ricavate.json');
  const knowledge = await j(BASE + 'ai/knowledge.json');
  const now = new Date();
  const foto = Array.isArray(fo) ? fo.length : (fo && Array.isArray(fo.lotti) ? fo.lotti.length : 629);
  const lotti = (st && (st.lotti || st.totale || st.totaleLotti)) || 321232;
  const esiti = (es && (es.totale || es.esiti || es.aggiudicazioni)) || (st && st.esiti) || 4142;
  const imm = (es && (es.immobiliari || es.immobiliare)) || 360;
  const mediana = (es && (es.mediana || es.medianaImmobiliare)) || 33375;
  const copertura = (es && (es.copertura || es.periodo)) || '2020-09-29/2026-11-09';
  const trib = (es && (es.tribunali || es.tribunaliDistinti)) || 44;
  const reg = (es && (es.regioni || es.regioniDistinte)) || 14;
  const brain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai', 'cervello.json'), 'utf8'));
  brain.aggiornato = now.toISOString();
  brain.pubblico.dati.lotti_banca_dati = Number(lotti) || brain.pubblico.dati.lotti_banca_dati;
  brain.pubblico.dati.esiti_verificati = Number(esiti) || brain.pubblico.dati.esiti_verificati;
  brain.pubblico.dati.esiti_immobiliari = Number(imm) || brain.pubblico.dati.esiti_immobiliari;
  brain.pubblico.dati.mediana_esiti_immobiliari = Number(mediana) || brain.pubblico.dati.mediana_esiti_immobiliari;
  brain.pubblico.dati.copertura = String(copertura);
  brain.pubblico.dati.tribunali = Number(trib) || brain.pubblico.dati.tribunali;
  brain.pubblico.dati.regioni = Number(reg) || brain.pubblico.dati.regioni;
  brain.pubblico.pvp.foto_estratte = Number(foto) || brain.pubblico.pvp.foto_estratte;
  if (knowledge && knowledge.statistiche) brain.pubblico.dati.nota = 'knowledge live aggiornata ' + (knowledge.aggiornato || now.toISOString().slice(0, 10));
  // Optional: Second Brain registry (private). Only headers/public facts, never internal numbers.
  const sbt = process.env.SECOND_BRAIN_TOKEN;
  let sbInfo = null;
  if (sbt) {
    try {
      const r = await fetch('https://api.github.com/repos/PuntoLuce26/second-brain/contents/04-lavori/REGISTRO-SOFTWARE.md', { headers: { Authorization: 'Bearer ' + sbt, 'User-Agent': 'CARe-iCARe-Brain/1.0', Accept: 'application/vnd.github.raw' } });
      if (r.ok) { const txt = await r.text(); const secs = (txt.match(/^##+\s+.*$/gm) || []).slice(0, 24); sbInfo = { sezioni: secs.length, sha: crypto.createHash('sha256').update(txt).digest('hex').slice(0, 16) }; }
    } catch (e) {}
  }
  brain.fonti = brain.fonti.filter((f) => !/^https:\/\/github\.com\/PuntoLuce26\/second-brain/.test(f));
  brain.fonti.push('https://github.com/PuntoLuce26/second-brain (parte pubblica/registrata' + (sbInfo ? ', sha ' + sbInfo.sha : '') + ')');
  const payload = JSON.stringify(brain, null, 2) + '\n';
  fs.writeFileSync(path.join(__dirname, '..', 'ai', 'cervello.json'), payload);
  const h = crypto.createHash('sha256').update(payload).digest('hex');
  console.log('iCARe brain scritto: ' + payload.length + ' byte, hash ' + h.slice(0, 16) + ', lotti ' + brain.pubblico.dati.lotti_banca_dati + ', esiti ' + brain.pubblico.dati.esiti_verificati + '/' + brain.pubblico.dati.esiti_immobiliari + ', foto ' + brain.pubblico.pvp.foto_estratte);
})().catch((e) => { console.error(e); process.exit(1); });
