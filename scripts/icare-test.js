#!/usr/bin/env node
// iCARe collaudo live — GitHub Actions / locale. Verifica il cervello pubblico e registrato,
// i dati, i limiti (no dati interni), l'app /icare e il brain JSON. Scrive qa/icare-stato.json.
const fs = require('fs');
const path = require('path');
const BASE = process.env.ICARE_BASE || 'https://careauctions.co';
const API = BASE + '/api/icare';
const BRAIN = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/ai/cervello.json';
const casi = [
  { id: 'success_fee_200k', q: 'Quanto costa la success fee su 200.000 euro?', must: ['5.800', 'non fa mediazione', '3,9%', '1,9%', '1.900'] },
  { id: 'esiti_copertura', q: 'Quanti esiti avete e con quale copertura?', must: ['4.142', '360', '33.375', '44', '14', '29/09/2020'] },
  { id: 'foto_perizie', q: 'Le foto delle perizie e i documenti PVP?', must: ['629', 'lightbox', 'perizia', 'pvp-documenti'] },
  { id: 'lingue_legali', q: 'Quante lingue parla il sito e le pagine legali sono tradotte?', must: ['89', '25', 'italiana', 'vincolante'] },
  { id: 'qa_controlli', q: 'Che controlli di qualità fate?', must: ['QA cloud', 'QA interna', '0 critici', 'mail-qa', 'p95'] },
  { id: 'software_cloud', q: 'Che software e automazioni avete?', must: ['cloud', 'Secondo Cervello', 'trigger', 'server'] },
  { id: 'no_dati_interni', q: 'Qual è il saldo di cassa e il burn?', must: ['dati interni'], mustNot: ['23.723', '24.723', 'saldo di cassa: 2'] },
  { id: 'visitatore_non_registrato', q: 'Cosa cambia per un utente registrato? Metodo CAReIndex, CAReOS, OMI', mustNot: ['Livello **registrato** attivo'] },
  { id: 'registrato_dettaglio', q: 'Cosa cambia per un utente registrato? Metodo CAReIndex, iDati, CAReOS, OMI, strategia', utente: { email: 'collaudo@careauctions.co', livello: 'registrato' }, must: ['Livello **registrato** attivo', 'CAReIndex', 'CAReOS', 'OMI', 'strategia'] },
  { id: 'registrato_cookie', q: 'Cosa cambia per un utente registrato? Metodo CAReIndex, CAReOS, OMI', cookie: 'care_token=collaudo-token', must: ['Livello **registrato** attivo'] },
  { id: 'pratica', q: 'La mia pratica è in corso?', utente: { email: 'collaudo@careauctions.co', livello: 'registrato' }, must: ['pratica'] },
];
function assertCase(c, txt) { const miss = (c.must || []).filter((x) => txt.indexOf(x) < 0); const bad = (c.mustNot || []).filter((x) => txt.indexOf(x) >= 0); return { ok: !miss.length && !bad.length, miss, bad }; }
async function ask(c, body) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': 'CARe-iCARe-Collaudo/1.0' };
  if (c.cookie) h.Cookie = c.cookie;
  const r = await fetch(API, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
(async () => {
  const out = { ok: false, aggiornato: new Date().toISOString(), base: BASE, casi: [], passati: 0, falliti: 0, errori: [] };
  for (const c of casi) {
    const t0 = Date.now();
    const body = { messaggio: c.q, lingua: 'it' };
    if (c.utente) body.utente = c.utente;
    try {
      const { status, j } = await ask(c, body);
      const txt = String(j.risposta || j.errore || '');
      const a = assertCase(c, txt);
      out.casi.push({ id: c.id, ok: status === 200 && a.ok, status, ms: Date.now() - t0, daDati: !!j.daDati, motivo: j.motivo || null, missing: a.miss, forbidden: a.bad, estratto: txt.slice(0, 220) });
    } catch (e) { out.casi.push({ id: c.id, ok: false, status: 0, ms: Date.now() - t0, errore: String(e).slice(0, 200) }); out.errori.push(c.id); }
  }
  // app /icare
  try {
    const t0 = Date.now(); const r = await fetch(BASE + '/icare', { headers: { 'User-Agent': 'Mozilla/5.0 CARe-Collaudo' }, signal: AbortSignal.timeout(45000) });
    const html = await r.text();
    const ok = r.status === 200 && html.indexOf('iCARe') >= 0 && (html.indexOf('care_token') >= 0 || html.toLowerCase().indexOf('icare') >= 0);
    out.casi.push({ id: 'app_icare', ok, status: r.status, ms: Date.now() - t0, care_aichat: html.indexOf('care-aichat') >= 0, api_icare: html.indexOf('/api/icare') >= 0 });
  } catch (e) { out.casi.push({ id: 'app_icare', ok: false, errore: String(e).slice(0, 200) }); out.errori.push('app_icare'); }
  // brain
  try {
    const t0 = Date.now(); const r = await fetch(BRAIN, { signal: AbortSignal.timeout(30000) }); const j = await r.json().catch(() => ({}));
    const ok = r.status === 200 && !!(j.pubblico && j.registrati && Array.isArray(j.esclusi) && j.aggiornato);
    out.brain = { ok, status: r.status, aggiornato: j.aggiornato || null, versione: j.versione || null, hash_len: JSON.stringify(j).length };
    out.casi.push({ id: 'brain_json', ok, status: r.status, ms: Date.now() - t0 });
  } catch (e) { out.casi.push({ id: 'brain_json', ok: false, errore: String(e).slice(0, 200) }); out.errori.push('brain_json'); }
  out.passati = out.casi.filter((c) => c.ok).length; out.falliti = out.casi.length - out.passati;
  out.ok = out.falliti === 0;
  out.sintesi = out.passati + '/' + out.casi.length + ' casi verdi' + (out.ok ? ' — iCARe attivo e collaudato' : ' — ' + out.falliti + ' falliti: ' + out.casi.filter((c) => !c.ok).map((c) => c.id).join(', '));
  const dest = path.join(__dirname, '..', 'qa', 'icare-stato.json');
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n'); } catch (e) {}
  console.log(out.sintesi);
  for (const c of out.casi) console.log((c.ok ? 'OK  ' : 'FAIL') + ' ' + c.id + ' ' + (c.status || '') + ' ' + (c.ms || '') + 'ms' + (c.missing && c.missing.length ? ' manca=' + c.missing.join(',') : '') + (c.forbidden && c.forbidden.length ? ' vietato=' + c.forbidden.join(',') : ''));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
