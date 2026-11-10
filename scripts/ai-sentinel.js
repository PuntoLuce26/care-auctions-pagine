#!/usr/bin/env node
// AI SENTINEL — controlla che TUTTE le AI e i cervelli CARe funzionino.
// Cloud: GitHub Actions ogni 15 min. Se trova anomalie, dispatcha il QA (ai-alert)
// che apre l'issue e attiva i soccorsi. Scrive ai/sentinella-stato.json.
import fs from 'node:fs';
import path from 'node:path';
const BASE = process.env.SENTINEL_BASE || 'https://careauctions.co';
const KEY = process.env.REGIA_KEY || '';
const GH = process.env.GITHUB_TOKEN || '';
const RUN = process.env.GITHUB_RUN_ID || '';
const checks = [], anomalie = [];
const T = (ms) => AbortSignal.timeout(ms || 35000);
async function req(url, opt = {}) {
  try {
    const r = await fetch(url, { ...opt, signal: T(opt.timeout || 35000) });
    const text = await r.text();
    return { status: r.status, ok: r.ok, text, json: (() => { try { return JSON.parse(text); } catch (e) { return null; } })() };
  } catch (e) { return { status: 0, ok: false, text: '', error: String(e).slice(0, 180) }; }
}
function ck(id, cond, det, gravita = 'high') {
  checks.push({ id, ok: !!cond, det: String(det || '').slice(0, 280) });
  if (!cond) anomalie.push({ componente: 'ai', gravita, oggetto: id + ': ' + String(det || '').slice(0, 180) });
}
const post = (body) => req(BASE + '/api/icare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  // 1. iCARe success fee
  const fee = await post({ messaggio: 'Quanto costa la success fee su 200.000 euro?', lingua: 'it' });
  ck('icare_success_fee', fee.status === 200 && /5\.800/.test(fee.text), 'HTTP ' + fee.status);
  // 2. iCARe perimetro legale
  const per = await post({ messaggio: 'Erbbaurecht tedesco: come funziona?', lingua: 'it' });
  ck('icare_perimetro', per.status === 200 && /non (e|è) il nostro campo|non.*campo/i.test(per.text), 'HTTP ' + per.status);
  // 3. iCARe registrato
  const reg = await post({ messaggio: 'Cosa cambia per un utente registrato? CAReIndex, CAReOS, OMI', lingua: 'it', utente: { email: 'sentinel@careauctions.co', livello: 'registrato' } });
  ck('icare_registrato', reg.status === 200 && /registrato/i.test(reg.text), 'HTTP ' + reg.status);
  // 4. cervello
  const br = await req(BASE + '/ai/cervello.json');
  const bj = br.json || {};
  const etaG = bj.aggiornato ? (Date.now() - Date.parse(bj.aggiornato)) / 86400000 : 999;
  ck('cervello_json', br.status === 200 && bj.pubblico && bj.registrati && Array.isArray(bj.esclusi) && etaG <= 8, 'HTTP ' + br.status + ' · età ' + etaG.toFixed(1) + 'g');
  // 5. knowledge
  const kn = await req(BASE + '/ai/knowledge.json');
  ck('ai_knowledge', kn.status === 200 && kn.text.length > 200, 'HTTP ' + kn.status + ' · ' + kn.text.length + 'B');
  // 6. stato AI education
  const st = await req(BASE + '/ai/stato.json');
  const sj = st.json || {};
  ck('ai_education_stato', st.status === 200 && (sj.ok === true || (sj.totale && sj.ok !== false)), 'HTTP ' + st.status);
  // 7. llms
  const ll = await req(BASE + '/llms.txt');
  ck('llms_txt', ll.status === 200 && /CARe/i.test(ll.text) && /iCARe/i.test(ll.text), 'HTTP ' + ll.status);
  // 8. traduzioni
  const tr = await req(BASE + '/i18n/_stato-traduzioni.json');
  const tj = tr.json || {};
  const etaT = tj.data ? (Date.now() - Date.parse(tj.data)) / 86400000 : 999;
  ck('traduzioni_stato', tr.status === 200 && etaT <= 3, 'HTTP ' + tr.status + ' · età ' + etaT.toFixed(1) + 'g');
  // 9. QA
  const qa = await req(BASE + '/qa/stato.json');
  const qj = qa.json || {};
  ck('qa_stato', qa.status === 200 && (qj.ok === true || qj.critici === 0 || qj.sintesi), 'HTTP ' + qa.status);
  // 10. mail-qa
  const ml = await req(BASE + '/mail/stato.json');
  const mj = ml.json || {};
  const etaM = (mj.ultimaEsecuzione || mj.aggiornato || mj.data) ? (Date.now() - Date.parse(mj.ultimaEsecuzione || mj.aggiornato || mj.data)) / 3600000 : 999;
  ck('mail_stato', ml.status === 200 && etaM <= 26, 'HTTP ' + ml.status + ' · età ' + etaM.toFixed(1) + 'h');
  // 11. perf
  const pf = await req(BASE + '/perf/stato.json');
  const pj = pf.json || {};
  const p95 = Number(pj.p95 || (pj.risultati && pj.risultati.p95) || 0);
  ck('perf_stato', pf.status === 200 && (!p95 || p95 < 1000), 'HTTP ' + pf.status + ' · p95 ' + p95 + 'ms');
  // 12. worker AI (con chiave)
  if (KEY) {
    const wa = await req('https://icare-ai.misty-mode-1cbc.workers.dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ azione: 'stato-automazioni', chiave: KEY }) });
    ck('worker_ai_stato', wa.status === 200 && /ok/i.test(wa.text), 'HTTP ' + wa.status);
    // 13. revisione (Ponte Cloud) — test vero del modello
    const rv = await req('https://icare-ai.misty-mode-1cbc.workers.dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ azione: 'revisione', chiave: KEY, artefatto: 'function somma(a,b){return a+b}', fase: 'revisore', autore: 'sentinel', contesto: 'test periodico AI Sentinel' }), timeout: 60000 });
    ck('ponte_cloud_revisione', rv.status === 200 && (rv.json && (rv.json.ok || rv.json.referto || rv.json.testo)), 'HTTP ' + rv.status);
  } else ck('worker_ai_stato', false, 'REGIA_KEY assente', 'medium');
  // 14. voce
  const vo = await req(BASE + '/voce/tts-worker.js');
  ck('voce_tts', vo.status === 200, 'HTTP ' + vo.status);
  // 15. iCAReWall
  const iw = await req(BASE + '/api/battito?lang=it');
  ck('icarewall', iw.status === 200, 'HTTP ' + iw.status);
  // 16. app CI (ultimo run)
  if (GH) {
    const ci = await req('https://api.github.com/repos/PuntoLuce26/care-aste-app/actions/workflows/ci.yml/runs?per_page=1', { headers: { Authorization: 'Bearer ' + GH, 'User-Agent': 'ai-sentinel', Accept: 'application/vnd.github+json' } });
    const cj = ci.json || {};
    const rr = (cj.workflow_runs || [])[0] || {};
    ck('app_ci', ci.status === 200 && (rr.conclusion === 'success' || rr.status === 'in_progress' || rr.conclusion === 'queued'), 'HTTP ' + ci.status + ' · ' + rr.conclusion);
    // 17. QA workflow ultimo run
    const qr = await req('https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/actions/workflows/qa.yml/runs?per_page=1', { headers: { Authorization: 'Bearer ' + GH, 'User-Agent': 'ai-sentinel', Accept: 'application/vnd.github+json' } });
    const qj2 = qr.json || {};
    const q2 = (qj2.workflow_runs || [])[0] || {};
    ck('qa_workflow', qr.status === 200 && q2.conclusion === 'success', 'HTTP ' + qr.status + ' · ' + q2.conclusion);
  } else ck('app_ci', false, 'GITHUB_TOKEN assente', 'medium');
  const out = { ok: anomalie.length === 0, aggiornato: new Date().toISOString(), base: BASE, run: RUN, checks, anomalie };
  fs.mkdirSync(path.join(process.cwd(), 'ai'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'ai', 'sentinella-stato.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('AI Sentinel: ' + checks.length + ' check, ' + anomalie.length + ' anomalie');
  for (const c of checks) if (!c.ok) console.log('ANOMALIA ' + c.id + ' · ' + c.det);
  // 18. dispatch QA se anomalie
  if (anomalie.length && GH) {
    const payload = { event_type: 'ai-alert', client_payload: { fonte: 'ai-sentinel', run: RUN, anomalie, checks: checks.filter(c => !c.ok) } };
    const d = await req('https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/dispatches', { method: 'POST', headers: { Authorization: 'Bearer ' + GH, 'User-Agent': 'ai-sentinel', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    console.log('QA dispatch ai-alert HTTP ' + d.status);
  }
  process.exit(0);
})().catch((e) => { console.error('AI SENTINEL ERRORE', e); process.exit(1); });
