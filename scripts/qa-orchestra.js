#!/usr/bin/env node
/**
 * qa-orchestra.js — il QA che interpella TUTTI i software e verifica che funzionino.
 * Produce qa/orchestra.json (macchina) e qa/orchestra.md (report leggibile).
 * Zero dipendenze. Gira su GitHub Actions: se c'è GH_TOKEN usa l'API per i run.
 */
const fs = require('fs');
const GH = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const UA = { 'User-Agent': 'CARe-QA-Orchestra' };
const out = [];
let KO = 0, WARN = 0;

function add(nome, ok, dettaglio, gravita = 'alta', skip = false) {
  if (!ok && !skip) { if (gravita === 'alta') KO++; else WARN++; }
  out.push({ nome, ok: !!ok, dettaglio, gravita, skip: !!skip });
}
async function get(url, opt = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, Object.assign({ headers: UA }, opt));
    const ms = Date.now() - t;
    return { ok: r.ok, status: r.status, ms, r };
  } catch (e) { return { ok: false, status: 0, ms: Date.now() - t, errore: e.message }; }
}
/* 12/11/2026 — gli stati interni (qa/stato.json, mail/stato.json, perf/stato.json) si leggono da
 * R2 (bucket care-stato), che è la fonte vera; la raw resta come ripiego senza token. */
let _statoMod = null;
async function daR2(percorso) {
  try {
    if (!_statoMod) _statoMod = await import('./stato-pubblica.mjs');
    const l = await _statoMod.leggiStato(percorso);
    return l.ok ? l.json : null;
  } catch (e) { return null; }
}
async function json(url) {
  const m = String(url).match(/\/(qa|mail|perf)\/(stato|ronda-notturna)\.json/);
  if (m) {
    const j = await daR2(`${m[1]}/${m[2]}.json`);
    if (j) return { ok: true, status: 200, json: j, fonte: 'r2' };
  }
  const g = await get(url);
  if (!g.ok) return { ...g, json: null };
  let j = null;
  try { j = await g.r.json(); } catch (e) {}
  return { ...g, json: j };
}
const BASE = 'https://careauctions.co';
const PAGES = 'https://puntoluce26.github.io/care-auctions-pagine';
const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main';
const tsa = (u) => u + (u.includes('?') ? '&' : '?') + 'ts=' + Date.now();

(async () => {
  // 1. Sito: rotte chiave
  for (const p of ['/', '/idati', '/osservatorio', '/aggiudicazioni', '/ilive']) {
    const g = await get(BASE + p);
    add('sito ' + p, g.ok, g.ok ? 'HTTP 200 · ' + g.ms + ' ms' : 'HTTP ' + g.status, 'alta');
  }
  // 2. Build allineata
  const home = await get(BASE + '/');
  const html = home.ok ? await home.r.text() : '';
  const sito = (html.match(/main\.[0-9a-f]{8}\.js/) || ['?'])[0];
  const orig = await get('https://care-aste.emergent.host/');
  const ho = orig.ok ? await orig.r.text() : '';
  const origine = (ho.match(/main\.[0-9a-f]{8}\.js/) || ['?'])[0];
  add('build sito = origine', sito === origine && sito !== '?', sito + ' / ' + origine, 'alta');
  // 3. QA cloud
  const qa = await json(tsa(RAW + '/qa/stato.json'));
  const qs = (qa.json && qa.json.summary) || {};
  const qaAgeH = qa.json && qa.json.generatedAt ? (Date.now() - Date.parse(qa.json.generatedAt)) / 3600e3 : 999;
  add('qa/stato.json', qa.ok && qa.json, qa.json ? 'run ' + qa.json.runId + ' · ' + Math.round(qaAgeH * 10) / 10 + ' h fa · ' + (qs.critical || 0) + 'C/' + (qs.high || 0) + 'A' : 'HTTP ' + qa.status, 'alta');
  add('QA recente (<8 h)', qaAgeH < 8, Math.round(qaAgeH * 10) / 10 + ' h', 'media');
  add('QA senza critici', (qs.critical || 0) === 0, (qs.critical || 0) + ' critici', 'alta');
  // 3b. Registrazione dei run QA nel Secondo Cervello (via stato pubblico dell'audit interno)
  const aud = await json(tsa(RAW + '/qa/audit-interno.json'));
  const audAge = aud.json && aud.json.generato ? (Date.now() - Date.parse(aud.json.generato)) / 3600e3 : 999;
  add('registrazione QA (audit interno)', !!(aud.json && aud.json.qaRunRegistrato),
      aud.json ? ('registrato · ' + Math.round(audAge * 10) / 10 + ' h fa · ' + String(aud.json.qaRunDettaglio || '')) : 'audit interno non ha ancora pubblicato lo stato',
      'media');
  // 4. Feed
  const st = await json(tsa(RAW + '/feed/statistiche.json'));
  const stAge = st.json && st.json.aggiornato ? (Date.now() - Date.parse(st.json.aggiornato)) / 3600e3 : 999;
  add('feed statistiche', st.ok && st.json && st.json.totale > 300000, st.json ? st.json.totale + ' lotti · ' + Math.round(stAge * 10) / 10 + ' h fa' : 'HTTP ' + st.status, 'alta');
  const agg = await json(tsa(RAW + '/feed/aggiudicazioni.json'));
  add('feed aggiudicazioni', agg.ok && Array.isArray(agg.json) && agg.json.length > 1000, Array.isArray(agg.json) ? agg.json.length + ' record' : 'HTTP ' + agg.status, 'alta');
  const es = await json(tsa(RAW + '/feed/esiti-statistiche.json'));
  add('esiti prezzi', es.ok && es.json && (es.json.tutti || 0) > 100, es.json ? (es.json.tutti || 0) + ' prezzi · ' + (es.json.copertura || '') : 'HTTP ' + es.status, 'media');
  // 5. AI education + llms
  const ai = await json(tsa(RAW + '/ai/stato.json'));
  add('AI education', ai.ok && ai.json && ai.json.ok !== false, ai.json ? (ai.json.checks ? ai.json.checks.length : (ai.json.ok ? 'ok' : '?')) + ' controlli' : 'HTTP ' + ai.status, 'media');
  for (const p of ['/llms.txt', '/robots.txt', '/sitemap.xml']) {
    const g = await get(BASE + p);
    add('AI/SEO ' + p, g.ok, 'HTTP ' + g.status + ' · ' + g.ms + ' ms', 'media');
  }
  // 6. Traduzioni
  const tr = await json(tsa(RAW + '/i18n/_stato-traduzioni.json'));
  add('traduzioni stato', tr.ok && tr.json, tr.json ? 'lingue ' + (Array.isArray(tr.json.lingue) ? tr.json.lingue.length : Object.keys(tr.json.lingue || {}).length) + ' · ' + (tr.json.data || '') : 'HTTP ' + tr.status, 'bassa');
  // 7. i18n fr
  const fr = await json(tsa(BASE + '/i18n/fr.json'));
  add('i18n fr', fr.ok && fr.json && Object.keys(fr.json).length > 3000, fr.json ? Object.keys(fr.json).length + ' chiavi' : 'HTTP ' + fr.status, 'bassa');
  // 8. PVP documenti
  const pvp = await json(BASE + '/api/pvp-documenti/512400');
  add('PVP documenti', pvp.ok && pvp.json, pvp.json ? ((pvp.json.allegati || []).length) + ' allegati' : 'HTTP ' + pvp.status, 'media');
  // 9. iCARe chat + wall + voce
  const chat = await get('https://icare-ai.misty-mode-1cbc.workers.dev', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, UA),
    body: JSON.stringify({ azione: 'ai-chat', messaggio: 'Quanto costa la success fee su 200.000 euro?', lingua: 'it' }),
  });
  let risposta = '';
  try { risposta = await chat.r.text(); } catch (e) {}
  add('iCARe chat', chat.ok && /5\.?800/.test(risposta), chat.ok ? ('HTTP 200 · ' + (/5\.?800/.test(risposta) ? 'risponde 5.800' : 'risposta senza importo')) : 'HTTP ' + chat.status, 'alta');
  const wall = await get('https://care-aste.emergent.host/api/battito?lang=it');
  add('iCAReWall', wall.ok, 'HTTP ' + wall.status, 'media');
  const voce = await get(BASE + '/voce/tts-worker.js');
  add('voce TTS', voce.ok, 'HTTP ' + voce.status, 'bassa');
  // 10. Posta (stato) + run GitHub
  const mail = await json(tsa(RAW + '/mail/stato.json'));
  const mailAge = mail.json && mail.json.ultimoControllo ? (Date.now() - Date.parse(mail.json.ultimoControllo)) / 3600e3 : 999;
  add('posta: ultima scansione (<6 h)', mailAge < 6, Math.round(mailAge * 10) / 10 + ' h · ' + ((mail.json && mail.json.allarmi) || []).length + ' allarmi', 'media');
  const PAT = process.env.QA_PAT || '';
  if (GH) {
    for (const [repo, wf, nome] of [
      ['PuntoLuce26/care-auctions-pagine', 'qa.yml', 'QA cloud'],
      ['PuntoLuce26/care-auctions-pagine', 'feed-sync.yml', 'feed-sync'],
      ['PuntoLuce26/care-auctions-pagine', 'traduzioni.yml', 'traduzioni'],
      ['PuntoLuce26/care-auctions-pagine', 'ai-education.yml', 'AI education'],
      ['PuntoLuce26/care-auctions-pagine', 'esiti-sync.yml', 'esiti-sync'],
    ]) {
      const tok = repo === 'PuntoLuce26/care-auctions-pagine' ? GH : PAT;
      if (!tok) { add('run ' + nome, true, 'serve QA_PAT (repo privato non leggibile col token del workflow)', 'bassa', true); continue; }
      const H = { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'User-Agent': 'CARe-QA-Orchestra' };
      try {
        const r = await fetch('https://api.github.com/repos/' + repo + '/actions/workflows/' + wf + '/runs?per_page=1', { headers: H });
        if (!r.ok) { add('run ' + nome, true, 'non verificabile (HTTP ' + r.status + ', il token del workflow vede solo questo repo)', 'bassa', true); continue; }
        const j = await r.json();
        const run = (j.workflow_runs || [])[0];
        const inCorso = run && run.status !== 'completed';
        add('run ' + nome, !!run && run.conclusion === 'success', run ? (inCorso ? 'in corso · ' + run.created_at : run.conclusion + ' · ' + run.created_at) : 'mai eseguito', 'bassa', !run || inCorso);
      } catch (e) { add('run ' + nome, false, e.message, 'bassa'); }
    }
  }
  // 11. App Emergent: risponde e serve lo stesso bundle dell'origine
  const appP = await get('https://care-aste.emergent.host/idati');
  let appH = '';
  try { appH = appP.ok ? await appP.r.text() : ''; } catch (e) {}
  const appb = (appH.match(/main\.[0-9a-f]{8}\.js/) || ['?'])[0];
  add('app Emergent /idati', appP.ok && appb === origine && appb !== '?', appP.ok ? ('HTTP 200 · ' + appb) : 'HTTP ' + appP.status, 'alta');
  // 12. Pages
  const pb = await get(PAGES + '/feed/statistiche.json');
  add('Pages serve i feed', pb.ok, 'HTTP ' + pb.status, 'bassa');

  const ora = new Date().toISOString();
  const okTot = KO === 0;
  const esito = okTot ? (WARN === 0 ? 'TUTTO OK' : 'OK CON AVVISI') : 'PROBLEMI';
  const fatti = out.filter((c) => !c.skip);
  const sintesi = fatti.length + ' controlli eseguiti · ' + fatti.filter((c) => !c.ok).length + ' non passati (' + KO + ' gravi, ' + WARN + ' avvisi) · ' + out.filter((c) => c.skip).length + ' non verificabili';

  fs.mkdirSync('qa', { recursive: true });
  fs.writeFileSync('qa/orchestra.json', JSON.stringify({ generato: ora, esito, sintesi, sito, origine, qaRun: qa.json && qa.json.runId, controlli: out }, null, 2));
  const md = ['# QA Orchestra — ' + ora, '',
    '**Esito: ' + esito + '** · ' + sintesi, '',
    '| Controllo | Esito | Dettaglio |', '|---|---|---|',
    ...out.map((c) => '| ' + c.nome + ' | ' + (c.skip ? 'n/v' : (c.ok ? 'ok' : '**KO**')) + ' | ' + String(c.dettaglio).replace(/\|/g, '/') + ' |'), ''].join('\n');
  fs.writeFileSync('qa/orchestra.md', md);
  console.log(md);
  if (!okTot) process.exitCode = 1;
})().catch((e) => { console.error('errore orchestra:', e); process.exit(2); });
