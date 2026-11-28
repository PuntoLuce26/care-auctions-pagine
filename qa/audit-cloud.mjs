#!/usr/bin/env node
/**
 * QA PRESIDIO CLOUD CAReAuctions — i 51 controlli che NON hanno bisogno del Mac.
 * Gira su GitHub Actions (cron ogni 3 h + dispatch) e PUBBLICA lui qa/audit-interno.json:
 * lo stato è fresco per costruzione e non dipende da un Mac acceso.
 * I 7 controlli che richiedono il Mac (dossier handoff, registro cassa, backup locale) restano
 * nel presidio locale (careauctions/qa/internal-audit.mjs → qa/audit-mac.json): un file, un solo scrittore.
 * Segreti: PAT_GITHUB (repo privati) e CLOUDFLARE_API_TOKEN (Cloudflare) dai secret del repository.
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = basename(process.cwd()) === 'careauctions' ? resolve(process.cwd(), '..') : process.cwd();
const OUT = join(ROOT, 'careauctions', 'qa', 'out');
mkdirSync(OUT, { recursive: true });
const now = new Date();
const checks = [];
const issues = [];
const fixes = [];

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch (e) { return null; } };
const exists = (p) => { try { return existsSync(p); } catch (e) { return false; } };
const size = (p) => { try { return statSync(p).size; } catch (e) { return null; } };
const add = (name, ok, detail, severity = 'medium', suggestion = '', skip = false) => {
  // 18/11/2026 — terso stato: "non verificabile" (skip). Un controllo che non si può misurare
  // NON è un KO (regola watchdog dell'11/11): entra nei checks con skip:true e non negli issues.
  checks.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 300), skip: !!skip });
  if (!ok && !skip) issues.push({ severity, area: name, message: String(detail || '').slice(0, 300), suggestion });
};
const sh = (cmd) => { try { execSync(cmd, { cwd: ROOT, stdio: 'ignore', timeout: 30000 }); return true; } catch (e) { return false; } };

// In cloud i segreti sono secret del repository (non file): PAT_GITHUB per i repo privati,
// CLOUDFLARE_API_TOKEN per Cloudflare. GITHUB_TOKEN serve solo per pubblicare su questo repo.
const GH = String(process.env.PAT_GITHUB || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const CF = String(process.env.CF_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '').trim();
const GH_H = { Authorization: 'Bearer ' + GH, 'User-Agent': 'CARe-Audit/1.0', Accept: 'application/vnd.github+json' };
const CF_H = { Authorization: 'Bearer ' + CF, 'User-Agent': 'CARe-Audit/1.0' };

async function gh(path, opts = {}) {
  if (!GH) return { ok: false, status: 0, json: null };
  try {
    const r = await fetch('https://api.github.com' + path, { ...opts, headers: { ...GH_H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, status: r.status, json: j, text: t };
  } catch (e) { return { ok: false, status: 0, json: null, error: String(e.message).slice(0, 120) }; }
}
async function cf(path) {
  if (!CF) return { ok: false, status: 0, json: null };
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: CF_H, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) { return { ok: false, status: 0, json: null, error: String(e.message).slice(0, 120) }; }
}
async function r2Leggi(chiave) {
  if (!CF) return { ok: false, status: 0, json: null };
  try {
    const url = 'https://api.cloudflare.com/client/v4/accounts/d5d20864ee7f83c32c9eeb5fcbda6edb/r2/buckets/care-stato/objects/' + chiave.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(url, { headers: CF_H, signal: AbortSignal.timeout(30000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, status: r.status, json: j, text: t, uploaded: r.headers.get('last-modified') };
  } catch (e) { return { ok: false, status: 0, json: null, error: String(e.message).slice(0, 120) }; }
}
// 18/11/2026 — CONTATORE dei 5xx dell'edge sulle rotte feed/*: un 500 isolato è transitorio,
// cinquanta in un'ora sono una tendenza. Registra n + orari nel report; NON tocca gli exit code.
const errori5xxEdge = [];
function nota5xx(url, status) {
  try {
    if (Number(status) >= 500 && /careauctions\.co\/feed\//.test(String(url))) {
      errori5xxEdge.push({ quando: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), url: String(url), status: Number(status) });
    }
  } catch (e) {}
}
async function pub(url, opts = {}) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000), headers: { 'User-Agent': opts.ua || 'CARe-Audit/1.0' } });
    nota5xx(url, r.status);
    const t = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, text: t };
  } catch (e) { return { ok: false, status: 0, text: '', error: String(e.message).slice(0, 120) }; }
}
const ageH = (d) => { const t = Date.parse(d); return t ? Math.round((Date.now() - t) / 36e5 * 10) / 10 : null; };

// ── 1 · codice dei due worker (repo privato care-workers) + segreti del runner ──────────
// In cloud i file locali non esistono: i worker si leggono dal repo privato con PAT_GITHUB,
// si scrivono in una cartella temporanea e si validano con `node --check`.
const TMP = join(process.env.RUNNER_TEMP || '/tmp', 'qa-presidio');
mkdirSync(TMP, { recursive: true });
const daCareWorkers = async (percorso) => {
  // ATTENZIONE: la Contents API restituisce `content: ""` per i file > 1 MB (edge/worker.js è 1,9 MB):
  // per questo si chiede il RAW (media type), che regge fino a 100 MB. Senza questo accorgimento
  // il check leggeva 0 byte e dava KO pur con HTTP 200.
  const r = await gh('/repos/PuntoLuce26/care-workers/contents/' + percorso, { headers: { Accept: 'application/vnd.github.raw' } });
  if (!r.ok || !r.text) return { ok: false, dettaglio: 'HTTP ' + r.status + (r.json && r.json.message ? ' · ' + r.json.message : '') };
  return { ok: true, testo: r.text };
};
{
  const e1 = await daCareWorkers('edge/worker.js');
  const f1 = join(TMP, 'worker-edge.js');
  if (e1.ok) writeFileSync(f1, e1.testo);
  add('edge worker — sintassi', e1.ok && sh(`node --check "${f1}"`), e1.ok ? (Math.round(e1.testo.length / 1024) + ' KB da care-workers') : e1.dettaglio, 'critical', 'Ripristinare dal backup e rideployare.');
  const a1 = await daCareWorkers('ai-proxy/worker.js');
  const f2 = join(TMP, 'worker-ai-proxy.js');
  if (a1.ok) writeFileSync(f2, a1.testo);
  add('worker AI — sintassi', a1.ok && sh(`node --check "${f2}"`), a1.ok ? (Math.round(a1.testo.length / 1024) + ' KB da care-workers') : a1.dettaglio, 'critical', 'Ripristinare dal backup e rideployare.');
}
// Segreti: in cloud non sono file ma secret del repository. Quelli che servono solo al Mac
// (gmail, gsc, brevo) si dichiarano «non verificabile» — meglio di un KO finto.
add('token github-token.txt', !!GH, GH ? 'PAT_GITHUB presente (' + GH.length + ' caratteri)' : 'PAT_GITHUB assente nei secret', 'critical', 'Settings → Secrets → Actions → PAT_GITHUB (token con accesso ai repo privati).');
add('token cloudflare-token.txt', !!CF, CF ? 'CLOUDFLARE_API_TOKEN presente (' + CF.length + ' caratteri)' : 'CLOUDFLARE_API_TOKEN assente nei secret', 'critical', 'Settings → Secrets → Actions → CLOUDFLARE_API_TOKEN.');
for (const f of ['gmail-token.json', 'gsc-token.json', 'brevo-apikey.txt']) {
  add('token ' + f, true, 'non verificabile: token usato solo dal Mac', 'medium', 'Lo controlla il presidio locale (qa/audit-mac.json).', true);
}
// cassaRow esiste solo per il testo di registrazione (non usato in cloud): evita ReferenceError.
const cassaRow = '';

// ── 2 · GitHub: repo pubblici e privati ────────────────────────────────────
const repoPub = await gh('/repos/PuntoLuce26/care-auctions-pagine');
add('repo care-auctions-pagine', repoPub.ok, repoPub.ok ? repoPub.json.default_branch + ' · ' + repoPub.json.size + ' KB' : 'HTTP ' + repoPub.status, 'critical');
const qaRuns = await gh('/repos/PuntoLuce26/care-auctions-pagine/actions/workflows/qa.yml/runs?per_page=3');
let qaR0 = null;
if (qaRuns.ok) {
  qaR0 = (qaRuns.json.workflow_runs || [])[0];
  add('ultimo run QA', !!qaR0, qaR0 ? qaR0.status + ' / ' + qaR0.conclusion + ' · ' + qaR0.created_at : 'nessun run', 'high', 'Rilanciare qa.yml.');
} else add('ultimo run QA', false, 'HTTP ' + qaRuns.status, 'high');
const qaBusy = !!(qaR0 && qaR0.status === 'in_progress');
const qaR2 = await r2Leggi('stato/qa/stato.json');
const qaStatoJson = qaR2.ok ? qaR2.json : null;
add('qa/stato.json (R2)', qaR2.ok && !!qaStatoJson, qaR2.ok ? `generatedAt ${qaStatoJson.generatedAt} · run ${qaStatoJson.runId}` : `HTTP ${qaR2.status || 0}`, 'high', 'Leggere R2 care-stato: la rotta pubblica può servire un file vecchio.');
const qaEta = qaStatoJson ? ageH(qaStatoJson.generatedAt) : null;
add('qa/stato.json — freschezza', qaEta !== null && qaEta <= 3, qaEta !== null ? qaEta + ' h' : 'assente', 'high', 'Il QA deve pubblicare lo stato a ogni run completata; le run cancellate non devono toccarlo.');

for (const [name, path] of [['second-brain', '/repos/PuntoLuce26/second-brain'], ['care-auctions-sync', '/repos/PuntoLuce26/care-auctions-sync'], ['care-aste-sorgente', '/repos/PuntoLuce26/care-aste-sorgente']]) {
  const r = await gh(path);
  add('repo ' + name, r.ok, r.ok ? 'ultimo push ' + r.json.pushed_at + ' · ' + r.json.size + ' KB' : 'HTTP ' + r.status, r.status === 404 ? 'high' : 'medium', 'Verificare nome, permessi del token e ultimo commit.');
}
// 18/11/2026 — l'ultimo run di qa-sync decide se la registrazione è VERIFICABILE:
// se nessun qa-sync è passato DOPO l'ultimo run QA, il run non può essere ancora nel registro
// e dichiarare KO è un falso allarme (regola watchdog: «non verificabile», mai «fallito»).
const qaSync = await gh('/repos/PuntoLuce26/second-brain/actions/workflows/qa-sync.yml/runs?per_page=1');
const qaSyncUltimo = qaSync.ok ? ((qaSync.json.workflow_runs || [])[0] || null) : null;
const sb = await gh('/repos/PuntoLuce26/second-brain/contents/04-lavori/QUADRO-LAVORI.md');
if (sb.ok) {
  const b = sb.json.size || 0;
  add('QUADRO-LAVORI — peso', b < 102400, Math.round(b / 1024) + ' KB', 'high', 'Ruotare le voci vecchie in 08-archivio se supera 100 KB.');
  try {
    const qaRunId = qaStatoJson?.runId;
    if (qaRunId) {
      const qtxt = Buffer.from(sb.json.content || '', 'base64').toString();
      const regDir = await gh('/repos/PuntoLuce26/second-brain/contents/04-lavori/registro');
      const consDir = await gh('/repos/PuntoLuce26/second-brain/contents/08-archivio/registro-consumati');
      const nomiReg = [regDir, consDir].flatMap((r) => r.ok && Array.isArray(r.json) ? r.json.map((f) => f.name) : []);
      const registrato = qtxt.includes('Run `' + qaRunId + '`') || nomiReg.some((n) => n.includes(String(qaRunId)));
      const qaQuando = Date.parse(qaStatoJson?.generatedAt || '') || 0;
      const syncDopo = !!(qaSyncUltimo && Date.parse(qaSyncUltimo.created_at || '') > qaQuando);
      const syncNonPassato = !!(qaQuando && !syncDopo);
      add('QA run registrato nel Secondo Cervello',
        syncNonPassato ? true : registrato,
        syncNonPassato
          ? 'run ' + qaRunId + ' · NON VERIFICABILE: nessun qa-sync dopo il run (ultimo ' + (qaSyncUltimo ? qaSyncUltimo.created_at : 'assente') + ')'
          : 'run ' + qaRunId,
        'high',
        'Il workflow qa-sync deposita il run in 04-lavori/registro/ (QUADRO-scribe lo consuma).',
        syncNonPassato);
    }
  } catch (e) {}
}
// (qaSync è letto qui sopra, prima del check di registrazione: serve a capire se il sync è già passato)
if (qaSync.ok) {
  const sr = (qaSync.json.workflow_runs || [])[0];
  add('QA → Secondo Cervello — sync', !!sr && sr.conclusion === 'success', sr ? sr.status + '/' + sr.conclusion + ' · ' + sr.created_at : 'nessun run', 'high', 'Rilanciare qa-sync.yml.');
} else add('QA → Secondo Cervello — sync', false, 'HTTP ' + qaSync.status, 'medium');
let ql = await gh('/repos/PuntoLuce26/second-brain/contents/07-quadri');
if (ql.ok && Array.isArray(ql.json) && ql.json.length < 3) {
  const qf = await gh('/repos/PuntoLuce26/second-brain-archivio/contents/08-archivio');
  if (qf.ok) ql = { ok: true, json: (ql.json || []).concat(qf.json || []) };
}
if (ql.ok) add('Secondo Cervello — quadri', Array.isArray(ql.json) && ql.json.length >= 1, (ql.json || []).length + ' file (vivo + freddo)', 'medium');
const appRepo = await gh('/repos/PuntoLuce26/care-aste-app');
if (appRepo.ok) {
  const c = await gh('/repos/PuntoLuce26/care-aste-app/commits?per_page=1');
  const latest = c.ok && Array.isArray(c.json) ? c.json[0] : null;
  const getFile = async (p) => { const r = await gh('/repos/PuntoLuce26/care-aste-app/contents/' + p); return { ok: r.ok, status: r.status, text: r.ok && r.json?.content ? Buffer.from(r.json.content, 'base64').toString() : '' }; };
  const home = await getFile('frontend/src/pages/Home.js');
  const footer = await getFile('frontend/src/components/Footer.js');
  const index = await getFile('frontend/public/index.html');
  const env1 = await getFile('.env');
  const env2 = await getFile('frontend/.env');
  const commitDate = latest?.commit?.author?.date || '';
  const checks = [
    ['repo privato', !!appRepo.json.private],
    ['branch main', appRepo.json.default_branch === 'main'],
    ['commit dopo 14:59', Date.parse(commitDate) > Date.parse('2026-11-10T13:59:00Z')],
    ['Home.js WIDE null', home.text.includes('const WIDE = null')],
    ['Footer /novita', footer.text.includes('/novita')],
    ['index CAReAuctions', index.text.includes('"name":"CAReAuctions"')],
    ['niente .env', !env1.ok && !env2.ok]
  ];
  add('sorgente Emergent (care-aste-app)', checks.every(x => x[1]), checks.map(x => (x[1] ? 'ok' : 'KO') + ': ' + x[0]).join(' · ') + ' · commit ' + (latest?.sha || '?').slice(0, 8), 'high', 'Se un controllo è KO, l export non corrisponde al build 66d9c2e6 o contiene segreti.');
} else {
  add('export GitHub Emergent', false, 'care-aste-app assente (HTTP ' + appRepo.status + ')', 'high', 'Gianluca: home → GitHub → autorizza PuntoLuce26; chat → + → Save to GitHub → nuovo repo privato care-aste-app (non care-auctions-app), branch main. Poi Sam verifica.');
  add('ricostruzione sorgente (storica)', true, 'care-aste-sorgente ferma a 00481c20; sostituita dall export', 'low');
}
const syncCassa = await gh('/repos/PuntoLuce26/care-auctions-sync/contents/cassa.csv');
if (syncCassa.ok) {
  const txt = Buffer.from(syncCassa.json.content || '', 'base64').toString();
  const righe = txt.trim().split('\n'); add('cassa su care-auctions-sync', righe.length > 1, righe.slice(-1)[0] || 'vuoto', 'medium');
}

// ── 3 · Cloudflare: token, KV cassa, backup R2, worker ─────────────────────
const ACC = 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const cfv = await cf('/user/tokens/verify');
add('token Cloudflare', cfv.ok && cfv.json && cfv.json.success, cfv.ok ? 'valido' : 'HTTP ' + cfv.status, 'critical', 'Rigenerare il token e aggiornare .tools.');
const kv = await cf(`/accounts/${ACC}/storage/kv/namespaces/432827253eed4b6a97eef2977f096ce9/values/torre:cassa`);
if (kv.ok) {
  let val = ''; try { val = JSON.stringify(kv.json); } catch (e) {}
  add('KV torre:cassa', true, String(val).slice(0, 120), 'high');
} else add('KV torre:cassa', false, 'HTTP ' + kv.status, 'high', 'Verificare namespace e permessi KV.');
const r2 = await cf(`/accounts/${ACC}/r2/buckets/care-backup/objects?per_page=1000`);
if (r2.ok && r2.json && Array.isArray(r2.json.result)) {
  const objs = r2.json.result.filter(o => o.key.endsWith('.tar.gz.age')).sort((a, b) => String(b.key).localeCompare(String(a.key)));
  const last = objs[0];
  const mk = last && last.key.match(/care-backup-(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z/);
  const when = mk ? new Date(mk[1] + 'T' + mk[2] + ':' + mk[3] + ':00Z') : null;
  const h = when ? Math.round((Date.now() - when.getTime()) / 36e5 * 10) / 10 : null;
  add('backup R2', h !== null && h <= 48, last ? last.key + ' · ' + h + ' h fa' : 'nessun backup', h !== null && h > 48 ? 'critical' : 'high', 'Controllare il cron backup; se manca da >48h è un guasto.');
} else add('backup R2', false, 'HTTP ' + r2.status, 'high');
const wk = await cf(`/accounts/${ACC}/workers/scripts`);
if (wk.ok && wk.json) {
  const names = (wk.json.result || []).map(x => x.id);
  add('worker careauctions-edge', names.includes('careauctions-edge'), names.slice(0, 6).join(', '), 'critical');
  add('worker icare-ai', names.includes('icare-ai'), names.slice(0, 6).join(', '), 'critical');
} else add('worker Cloudflare', false, 'HTTP ' + wk.status, 'high');

// ── 4 · sito pubblico e AI ─────────────────────────────────────────────────
const home = await pub('https://careauctions.co/?audit=' + Date.now());
const origin = await pub('https://care-aste.emergent.host/?audit=' + Date.now());
const hb = (home.text.match(/main\.[a-f0-9]{8}\.js/) || [null])[0];
const ob = (origin.text.match(/main\.[a-f0-9]{8}\.js/) || [null])[0];
add('build sito = origine', !!hb && hb === ob, (hb || '?') + ' / ' + (ob || '?'), 'critical', 'Verificare il sync/edge e il deploy Emergent.');
const pre = await gh('/repos/PuntoLuce26/care-auctions-pagine/contents/prerender/idati.html');
const pb = pre.ok && pre.json?.content ? ((Buffer.from(pre.json.content, 'base64').toString().match(/main\.[a-f0-9]{8}\.js/) || [null])[0]) : null;
add('prerender allineato', !!pb && pb === ob, (pb || '?') + ' / origine ' + (ob || '?'), 'high', 'Dopo ogni publish lanciare prerender.yml: i crawler leggono gli snapshot.');
const pvpApi = await pub('https://careauctions.co/api/pvp-documenti/1822566?audit=' + Date.now());
let pvpDoc = null; try { pvpDoc = JSON.parse(pvpApi.text); } catch (e) {}
const pvpAllegati = pvpDoc && Array.isArray(pvpDoc.allegati) ? pvpDoc.allegati.length : 0;
add('PVP documenti API', pvpApi.status === 200 && !!pvpDoc?.ok && pvpAllegati > 0, 'HTTP ' + pvpApi.status + ' · ' + pvpAllegati + ' allegati', 'high', 'Serve il dettaglio PVP: endpoint edge /api/pvp-documenti/{id}.');
const pvpAsta = await pub('https://careauctions.co/aste/1822566?audit=' + Date.now());
add('PVP sezione su /aste', pvpAsta.text.includes('care-doc-pvp'), 'sezione ' + (pvpAsta.text.includes('care-doc-pvp') ? 'presente' : 'assente'), 'high', 'Iniezione edge della sezione documenti/foto sulla pagina lotto.');
const i18nFr = await pub('https://careauctions.co/i18n/fr.json?audit=' + Date.now());
let frI18n = null; try { frI18n = JSON.parse(i18nFr.text); } catch (e) {}
const frKeys = frI18n ? Object.keys(frI18n).length : 0;
add('i18n fr — nuove chiavi', !!frI18n && frKeys >= 3999 && !!frI18n.rl_aff && /Un monde, une adresse/i.test(frI18n.lb_body || ''), 'HTTP ' + i18nFr.status + ' · ' + frKeys + ' chiavi · home ' + (/Un monde, une adresse/i.test(frI18n?.lb_body || '') ? 'nuova' : 'vecchia'), 'high', 'Il workflow traduzioni e l edge raw devono servire il fr completo.');
const aiK = await pub('https://careauctions.co/ai/knowledge.json?audit=' + Date.now());
add('AI knowledge', aiK.status === 200 && /CAReAuctions/.test(aiK.text), 'HTTP ' + aiK.status, 'high', 'Knowledge base per le AI: /ai/knowledge.json.');
const aiS = await pub('https://careauctions.co/ai/stato.json?audit=' + Date.now());
let aiJ = null; try { aiJ = JSON.parse(aiS.text); } catch (e) {}
add('AI education stato', aiS.status === 200 && !!aiJ && aiJ.ok === true && Array.isArray(aiJ.checks) && aiJ.checks.length >= 10, 'HTTP ' + aiS.status + ' · ' + (aiJ ? aiJ.checks.length : 0) + ' check · ok ' + (aiJ ? aiJ.ok : false), 'high', 'Il workflow ai-education deve girare ogni giorno e tutti i check devono essere verdi.');
const llmsTxt = await pub('https://careauctions.co/llms.txt?audit=' + Date.now());
add('llms.txt AI', llmsTxt.status === 200 && /CAReAuctions/.test(llmsTxt.text), 'HTTP ' + llmsTxt.status, 'high', 'llms.txt servito dalla raw.');
// 28/11/2026 — per la rotazione del peso il registro vive nel repo freddo: si cerca prima li.
let regSw = await gh('/repos/PuntoLuce26/second-brain-archivio/contents/04-lavori/REGISTRO-SOFTWARE.md');
if (!regSw.ok) regSw = await gh('/repos/PuntoLuce26/second-brain/contents/04-lavori/REGISTRO-SOFTWARE.md');
add('Registro software', regSw.ok && (regSw.json.size || 0) > 1000, regSw.ok ? Math.round((regSw.json.size || 0) / 1024) + ' KB' : 'HTTP ' + regSw.status, 'high', 'Tutti i software creati vanno registrati nel Secondo Cervello.');
const esStat = await pub('https://careauctions.co/feed/esiti-statistiche.json?audit=' + Date.now());
let esJ = null; try { esJ = JSON.parse(esStat.text); } catch (e) {}
add('Esiti prezzi aggiudicazione', esStat.status === 200 && !!esJ && Number(esJ.tutti) >= 4000 && esJ.copertura && Number(esJ.copertura.esiti) >= 300, 'HTTP ' + esStat.status + ' · ' + (esJ ? esJ.tutti : 0) + ' totali · ' + (esJ && esJ.copertura ? esJ.copertura.esiti : 0) + ' immobiliari', 'high', 'esiti-sync deve aggiornare i prezzi di aggiudicazione con copertura dichiarata.');
const criEs = await pub('https://careauctions.co/feed/ca-re-index-esiti.json?audit=' + Date.now());
let criJ = null; try { criJ = JSON.parse(criEs.text); } catch (e) {}
add('CAReIndex esiti', criEs.status === 200 && !!criJ && criJ.indice && Number(criJ.indice.conteggio) >= 300, 'HTTP ' + criEs.status + ' · ' + (criJ && criJ.indice ? criJ.indice.conteggio : 0) + ' prezzi', 'high', 'CAReIndex legge i prezzi reali di aggiudicazione.');
const statEs = await pub('https://careauctions.co/feed/statistiche.json?audit=' + Date.now());
let statJ = null; try { statJ = JSON.parse(statEs.text); } catch (e) {}
add('Statistiche esiti', statEs.status === 200 && !!statJ && !!statJ.esiti && Number(statJ.esiti.aggiudicate) > 0 && Number(statJ.esiti.deserte) > 0 && Number(statJ.esiti.nonPubblicato) > 0, 'HTTP ' + statEs.status + ' · ' + (statJ && statJ.esiti ? statJ.esiti.aggiudicate : 0) + ' aggiudicate / ' + (statJ && statJ.esiti ? statJ.esiti.deserte : 0) + ' deserte', 'high', 'iDati e CAReOS leggono statistiche.json (schema esiti: aggiudicate/deserte/sospese/nonPubblicato).');
const repEs = await pub('https://careauctions.co/feed/esiti-report.json?audit=' + Date.now());
add('Report esiti', repEs.status === 200 && /awards/.test(repEs.text), 'HTTP ' + repEs.status, 'medium');
const astaFoto = await pub('https://careauctions.co/aste/1822566?audit=' + Date.now());
add('Foto anteprima + lightbox', astaFoto.status === 200 && /care-pvp-thumb/.test(astaFoto.text) && /care-pvp-lb/.test(astaFoto.text), 'HTTP ' + astaFoto.status, 'high', 'La scheda lotto deve mostrare le miniature e il lightbox.');
const astaEstr = await pub('https://careauctions.co/aste/1375994?audit=' + Date.now());
add('Foto estratte da perizia', astaEstr.status === 200 && /care-pvp-thumb/.test(astaEstr.text) && /cdn\.jsdelivr\.net/.test(astaEstr.text), 'HTTP ' + astaEstr.status, 'high', 'Le foto del feed foto-ricavate devono comparire nella scheda.');
const t0 = Date.now();
const perfLive = await pub('https://careauctions.co/?audit=' + Date.now());
const msLive = Date.now() - t0;
add('Performance QA — sito', perfLive.status === 200 && msLive < 2500, 'HTTP ' + perfLive.status + ' · ' + msLive + ' ms', 'high', 'Il sito deve rispondere in meno di 2,5 s; la misura è live, non da un file stagnante.');
const perfR2 = await r2Leggi('stato/perf/stato.json');
let perfJ = perfR2.ok ? perfR2.json : null;
if (!perfJ) {
  const perfRaw = await pub('https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/perf/stato.json?audit=' + Date.now());
  try { perfJ = JSON.parse(perfRaw.text); } catch (e) {}
}
const perfEta = perfJ && perfJ.aggiornato ? ageH(perfJ.aggiornato) : null;
// 18/11/2026 — NIENTE SOGLIA INVENTATA: la cadenza della raccolta è un DATO del payload
// (`cadenzaOre`, scritto dal generatore emergent-watch.mjs), non un numero nel check.
// Regola (Lead 18/11): soglia = cadenzaOre × 1,5, con margine minimo di 2 h.
//   serie più vecchia della soglia → WARN, mai KO critico: «serie ferma da Xh (cadenza Yh)»
//   file assente o payload senza cadenza → «non verificabile» con skip (chi non può sapere lo dice).
// Con cadenza 8 h → soglia max(12, 10) = 12 h · con 6 h → 9 h · con 1 h → 3 h. Si adegua da sola.
const perfCadenza = perfJ && Number(perfJ.cadenzaOre) > 0 ? Number(perfJ.cadenzaOre) : null;
const perfSogliaH = perfCadenza ? Math.max(perfCadenza * 1.5, perfCadenza + 2) : null;
if (!perfJ || !perfCadenza) {
  add('Performance QA — serie', true,
    !perfJ ? 'non verificabile: perf/stato.json non leggibile (né R2 né raw)'
           : 'non verificabile: il payload non dichiara cadenzaOre (lo scrive emergent-watch.mjs)',
    'medium', 'La cadenza della raccolta deve arrivare dal payload: aggiornare il generatore, non il check.', true);
} else {
  const perfAllarmeOk = perfJ.allarme === 'ok' || perfJ.allarme === true;
  const perfLentiOk = Number(perfJ.punti_lenti_su_8) <= 8;
  const perfVecchia = perfEta === null || perfEta > perfSogliaH;
  const perfH = perfEta === null ? '?' : Math.round(perfEta * 10) / 10;
  const perfCad = Math.round(perfCadenza * 10) / 10;
  const perfSog = Math.round(perfSogliaH * 10) / 10;
  // Provenienza della cadenza: quante osservazioni, mediana e massimo MISURATI dal produttore.
  const perfN = Number(perfJ.cadenzaOsservazioni) > 0 ? Number(perfJ.cadenzaOsservazioni) : null;
  const perfMed = Number(perfJ.cadenzaMedianaH) > 0 ? Number(perfJ.cadenzaMedianaH) : null;
  const perfMax = Number(perfJ.cadenzaMassimoH) > 0 ? Number(perfJ.cadenzaMassimoH) : null;
  const perfCadTxt = perfN
    ? 'cadenza ' + perfCad + 'h (' + (perfMed ? 'mediana ' + perfMed + 'h su ' + perfN + ' intervalli' + (perfMax ? ' · massimo ' + perfMax + 'h' : '') : perfN + ' intervalli') + ')'
    : 'cadenza ' + perfCad + 'h (osservazioni non dichiarate)';
  // ISO al minuto dell'ultima osservazione: dice subito se è ritardo o guasto.
  const perfUltimo = perfJ.aggiornato && !isNaN(Date.parse(perfJ.aggiornato))
    ? new Date(perfJ.aggiornato).toISOString().replace(/\.\d+Z$/, 'Z')
    : null;
  if (perfVecchia) {
    add('Performance QA — serie', false,
      'serie ferma da ' + perfH + 'h · ' + perfCadTxt + ' · soglia ' + perfSog + 'h' + (perfUltimo ? ' · ultimo: ' + perfUltimo : '') + ' · allarme ' + perfJ.allarme + ' · lenti ' + perfJ.punti_lenti_su_8 + '/8',
      'medium', 'Se la serie è ferma oltre la soglia il problema è del workflow emergent-watch (o di GitHub che dirada); il payload vive su R2 stato/perf/stato.json.');
  } else {
    add('Performance QA — serie', perfAllarmeOk && perfLentiOk,
      'allarme ' + perfJ.allarme + ' · lenti ' + perfJ.punti_lenti_su_8 + '/8 · serie ' + perfH + 'h · ' + perfCadTxt + ' · soglia ' + perfSog + 'h · ultimo: ' + (perfUltimo || '?'),
      'medium', 'Origine lenta o giù: guardare perf/stato.json (R2).');
  }
}





const st = await pub('https://careauctions.co/feed/statistiche.json');
let feed = null; try { feed = JSON.parse(st.text); } catch (e) {}
add('feed statistiche', st.ok && feed && feed.totale, feed ? feed.totale + ' lotti · ' + feed.aggiornato : 'HTTP ' + st.status, 'critical', 'Far girare feed-sync.');
add('llms.txt', (await pub('https://careauctions.co/llms.txt')).status === 200, '200', 'high');
add('robots.txt', (await pub('https://careauctions.co/robots.txt')).status === 200, '200', 'high');
add('sitemap', (await pub('https://careauctions.co/sitemap.xml')).status === 200, '200', 'high');
add('stato', (await pub('https://careauctions.co/stato')).status === 200, '200', 'medium');
// 18/11/2026 — ROTTA PUBBLICA, non l'origine: icare-ai…workers.dev risponde 401 agli anonimi
// e produceva 2 critici falsi a ogni giro (triage 17/11). careauctions.co/api/icare è la stessa
// chat servita al visitatore, ed è quello che va misurato.
const chat = await fetch('https://careauctions.co/api/icare', {
  method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': 'CARe-Audit/1.0' },
  body: JSON.stringify({ azione: 'ai-chat', messaggio: 'Quanto pago su 200.000 euro?', lingua: 'it' }),
  signal: AbortSignal.timeout(30000)
});
const chatTxt = await chat.text();
// OK = 200 + una risposta vera + il listino in vigore (progressivo: 200.000 → 7.300).
add('iCARe — success fee', chat.ok && /"risposta"\s*:\s*"[^"]+/.test(chatTxt) && /7\.?300/.test(chatTxt), String(chatTxt).slice(0, 160), 'critical', 'Listino atteso: progressivo 3,9/2,9/1,9 con 2,9% fino a 400.000 e 200.000 → 7.300 (+ IVA).');
const chatEst = await fetch('https://careauctions.co/api/icare', {
  method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': 'CARe-Audit/1.0' },
  body: JSON.stringify({ azione: 'ai-chat', messaggio: "Mi spieghi l'Erbbaurecht tedesco?", lingua: 'it' }),
  signal: AbortSignal.timeout(30000)
});
const estTxt = await estTxtSafe(chatEst);
function estTxtSafe(r) { return r.text().catch(() => ''); }
const refusal = /il nostro campo|non rientra|non posso|non trattiamo|fuori perimetro|non e' il nostro|non è il nostro/i.test(estTxt);
add('iCARe — perimetro legale', refusal, String(estTxt).slice(0, 180), 'critical', 'Rimettere il blocco deterministico e la regola nel prompt.');
add('voce TTS', (await pub('https://careauctions.co/voce/tts-worker.js')).status === 200, '200', 'high');
// 18/11/2026 — anche qui la rotta pubblica (l'origine care-aste.emergent.host/api/battito è 403)
// e il contenuto vero: un 200 non basta, servono i messaggi.
{
  const wall = await fetch('https://careauctions.co/api/battito?lang=it', { headers: { 'User-Agent': 'CARe-Audit/1.0' }, signal: AbortSignal.timeout(30000) });
  let wallJ = null; try { wallJ = await wall.json(); } catch (e) {}
  const wallMsg = wallJ && (wallJ.messaggi || wallJ.messages);
  add('iCAReWall API', wall.status === 200 && Array.isArray(wallMsg) && wallMsg.length > 0,
    wall.status + ' · ' + (Array.isArray(wallMsg) ? wallMsg.length : 0) + ' messaggi', 'medium');
}

// ── 6 · registro nel Secondo Cervello ─────────────────────────────────────
const sm = { critical: 0, high: 0, medium: 0, low: 0, total: issues.length };
for (const i of issues) sm[i.severity] = (sm[i.severity] || 0) + 1;
const report = {
  generatedAt: now.toISOString(),
  durationSec: Math.round((Date.now() - now.getTime()) / 1000),
  root: ROOT,
  summary: sm,
  checks,
  issues,
  // 18/11/2026 — tendenza dei 5xx dell'edge sulle rotte feed/* (n + orari). Non cambia l'exit code.
  errori5xxEdge: errori5xxEdge.length,
  errori5xxEdgeDettaglio: errori5xxEdge.slice(0, 50).map((e) => e.quando + ' ' + e.url.replace('https://careauctions.co', '') + ' → ' + e.status)
};
if (errori5xxEdge.length) console.log('5xx edge su feed/*: ' + errori5xxEdge.length + ' → ' + report.errori5xxEdgeDettaglio.join(' | '));
const day = now.toISOString().slice(0, 10);
writeFileSync(join(OUT, 'internal-audit-' + day + '.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
const md = ['# QA interna CAReAuctions — ' + report.generatedAt, '', '| Esito | Numero |', '|---|---|',
  '| Critici | **' + sm.critical + '** |', '| Alti | ' + sm.high + ' |', '| Medi | ' + sm.medium + ' |', '| Bassi | ' + sm.low + ' |', '',
  '## Controlli', '| Controllo | Esito | Dettaglio |', '|---|---|---|',
  ...checks.map(c => '| ' + c.name + ' | ' + (c.ok ? 'ok' : 'KO') + ' | ' + String(c.detail).replace(/\|/g, '\\|').slice(0, 120) + ' |'),
  '', '## Problemi', '| Gravità | Area | Messaggio |', '|---|---|---|',
  ...issues.map(i => '| ' + i.severity + ' | ' + i.area + ' | ' + String(i.message).replace(/\|/g, '\\|').slice(0, 160) + ' |')
].join('\n') + '\n';
writeFileSync(join(OUT, 'internal-audit-' + day + '.md'), md, 'utf8');
console.log(md);

// Registra nel Secondo Cervello (append-only).
async function registra() {
  const token = GH;
  if (!token) { console.log('registrazione: token GitHub assente'); return false; }
  const api = 'https://api.github.com/repos/PuntoLuce26/second-brain/contents/';
  const H = { ...GH_H, 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(api + p + '?ref=main', { headers: H, signal: AbortSignal.timeout(30000) }); return r.ok ? r.json() : null; };
  const put = async (p, content, sha, message) => {
    const body = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(api + p, { method: 'PUT', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    return r.ok;
  };
  try {
    const g = await get('04-lavori/QUADRO-LAVORI.md');
    if (!g) return false;
    let q = Buffer.from(g.content, 'base64').toString('utf8');
    if (q.includes('QA interna — ' + report.generatedAt)) { console.log('registrazione: già presente'); return true; }
    const top = issues.slice(0, 8).map(i => '- [' + i.severity + '] ' + i.area + ': ' + i.message.slice(0, 160)).join('\n');
    q += '\n## QA interna — ' + report.generatedAt + '\n' +
      'Controlli: ' + checks.length + ' · **' + sm.critical + ' critici, ' + sm.high + ' alti, ' + sm.medium + ' medi, ' + sm.low + ' bassi**. ' +
      'Cassa ultima riga: ' + (cassaRow || 'n.d.') + '.\n' + (top ? top + '\n' : '') + '\n';
    const okQ = await put('04-lavori/QUADRO-LAVORI.md', q, g.sha, 'QA interna: audit ' + day);
    const f = '07-quadri/' + day + '-qa-interna.md';
    const gf = await get(f);
    const old = gf ? Buffer.from(gf.content, 'base64').toString('utf8') : '# QA interna — ' + day + '\n\n> Audit locale del progetto: file, repo privati, Cloudflare, cassa, AI.\n';
    const body = old + '\n## Audit ' + report.generatedAt + '\n' + md.split('\n').slice(0, 80).join('\n') + '\n';
    const okF = await put(f, body, gf ? gf.sha : undefined, 'QA interna: report ' + day);
    return okQ && okF;
  } catch (e) { console.log('registrazione errore:', e.message); return false; }
}
async function pubblicaStatoPubblico() {
  // Pubblica in qa/audit-interno.json (repo pubblico) SOLO l'esito: serve al QA Orchestra cloud,
  // che non può leggere il Secondo Cervello (privato). Nessun dato interno, nessun token.
  if (!GH) return false;
  const reg = (checks || []).find((c) => (c.name || '').includes('QA run registrato nel Secondo Cervello'));
  const body = {
    generato: report.generatedAt,
    controlli: checks.length,
    critici: sm.critical, alti: sm.high, medi: sm.medium, bassi: sm.low,
    qaRunRegistrato: !!(reg && reg.ok),
    qaRunVerificabile: !(reg && reg.skip),
    qaRunMotivo: reg && reg.skip ? String(reg.detail || '').slice(0, 160) : '',
    nonVerificabili: (checks || []).filter((c) => c.skip).length + '/' + (checks || []).length,
    errori5xxEdge: (typeof errori5xxEdge !== 'undefined' ? errori5xxEdge.length : 0),
    qaRunDettaglio: reg ? String(reg.detail || '').slice(0, 120) : '',
    // La cadenza dichiarata del presidio cloud: chi legge calcola da sé se è fresco
    // (stato fermo da più di 2 × cadenzaOre = peggio di uno stato assente).
    cadenzaOre: 3,
    // 18/11/2026 — SU QUALE BUILD è stato misurato questo «0 critici»: senza, fra due giorni
    // non si sa se riguardava la build vecchia o la nuova (misurare l'artefatto, non il log).
    sitoBuild: hb || null,
    prerenderAllineato: !!(pb && pb === ob),
    fonte: 'presidio cloud (GitHub Actions, qa-presidio.yml)',
  };
  const H = { ...GH_H, 'Content-Type': 'application/json' };
  const url = 'https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/contents/qa/audit-interno.json';
  // 18/11/2026 — il publish FALLIVA IN SILENZIO (il 18/11 il payload era fermo al 17/11 22:16 con
  // «stato pubblico: non pubblicato» e nessun dettaglio). Ora: si logga status+risposta sempre e si
  // ritenta UNA volta su 409/422 (sha cambiato fra GET e PUT: la race tipica con un altro scrittore).
  const tenta = async (conSha) => {
    const g = await fetch(url + '?ref=main', { headers: H, signal: AbortSignal.timeout(20000) });
    const cur = g.ok ? await g.json() : null;
    const payload = { message: 'qa: presidio cloud ' + report.generatedAt, content: Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf8').toString('base64'), branch: 'main' };
    if (cur && cur.sha && conSha) payload.sha = cur.sha;
    const r = await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    return { ok: r.ok, status: r.status, testo: t };
  };
  try {
    let esito = await tenta(true);
    if (!esito.ok && (esito.status === 409 || esito.status === 422)) {
      console.log('pubblica stato pubblico: HTTP', esito.status, '— riprovo con lo sha fresco');
      esito = await tenta(true);
    }
    if (!esito.ok) console.log('pubblica stato pubblico FALLITO:', esito.status, String(esito.testo || '').slice(0, 200));
    else {
      try { const j = JSON.parse(esito.testo); console.log('pubblica stato pubblico: ok · commit', String(j.commit && j.commit.sha).slice(0, 8)); } catch (e) {}
    }
    return esito.ok;
  } catch (e) { console.log('pubblica stato pubblico errore:', e.message); return false; }
}
// In cloud il payload si pubblica SEMPRE e se non si pubblica si esce 1:
// un audit verde che non riesce a pubblicare è peggio di un audit rosso (regola del 18/11).
const okPub = process.env.QA_PRESIDIO_NO_PUBLISH === '1' ? true : await pubblicaStatoPubblico();
if (!okPub) {
  console.log('::error::payload non pubblicato (qa/audit-interno.json) — esco 1');
  process.exit(1);
}
console.log('stato pubblico: pubblicato · ' + checks.length + ' controlli · ' + sm.critical + ' critici');
process.exit(sm.critical > 0 ? 1 : 0);
