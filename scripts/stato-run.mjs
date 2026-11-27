#!/usr/bin/env node
/**
 * stato-run.mjs — riassunto REDATTO dei run GitHub, leggibile senza token.
 * Per ogni repo elencato prende gli ultimi run; per i falliti scrive quale passo è caduto
 * e le prime righe d'errore, PASSATE AL FILTRO: nessun token, email, IBAN, chiave o percorso locale.
 * Output: qa/run-riassunto.json + qa/RUN.md (nel repo PUBBLICO care-auctions-pagine).
 */
import fs from 'node:fs';

const TOKEN = process.env.GH_TOKEN || '';
const API = 'https://api.github.com';
const REPOS = (process.env.REPOS || 'care-auctions-pagine,green,care-workers,second-brain').split(',');
const OUT_JSON = 'qa/run-riassunto.json';
const OUT_MD = 'qa/RUN.md';

const RE_TESTI = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[token]'],
  [/\bsk-[A-Za-z0-9]{10,}/g, '[chiave]'],
  [/AKIA[0-9A-Z]{16}/g, '[chiave]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[iban]'],
  [/\b[0-9a-f]{32,}\b/gi, '[hash]'],
  [/\/Users\/[^\s"']+/g, '[percorso]'],
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [token]'],
];
const redigi = (s) => RE_TESTI.reduce((t, [re, r]) => t.replace(re, r), String(s || ''));

async function gh(path, raw = false) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: raw ? 'application/vnd.github+json' : 'application/vnd.github+json', 'User-Agent': 'care-stato' } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return raw ? r.text() : r.json();
}

async function passoCaduto(repo, runId) {
  try {
    const j = await gh(`/repos/PuntoLuce26/${repo}/actions/runs/${runId}/jobs`);
    const passi = (j.jobs || []).flatMap((x) => x.steps || []).filter((s) => s.conclusion === 'failure');
    return passi.map((s) => s.name).slice(0, 3);
  } catch { return []; }
}

async function righeErrore(repo, runId) {
  try {
    const r = await fetch(`${API}/repos/PuntoLuce26/${repo}/actions/runs/${runId}/logs`, { headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'care-stato' }, redirect: 'follow' });
    if (!r.ok) return [];
    const buf = Buffer.from(await r.arrayBuffer());
    // zip: estraiamo solo le righe leggibili con grep testuale (senza dipendenze)
    const txt = buf.toString('latin1');
    const righe = txt.split('\n').filter((l) => /error|Error|ERRORE|KO|failed|not found|disabled|non torna/i.test(l) && l.length < 400);
    return righe.slice(0, 5).map((l) => redigi(l.replace(/^\S*Z\s*/, '').trim()));
  } catch { return []; }
}

const out = { generato: new Date().toISOString(), repos: {}, numeri: {}, nota: 'Riassunto redatto: nessun token, email, IBAN o percorso locale.' };
const taglio = Date.now() - 36 * 3600 * 1000;
for (const repo of REPOS) {
  try {
    const j = await gh(`/repos/PuntoLuce26/${repo}/actions/runs?per_page=40`);
    const runs = (j.workflow_runs || []).filter((r) => new Date(r.created_at).getTime() >= taglio);
    const voci = [];
    for (const r of runs.slice(0, 25)) {
      const v = { workflow: r.name, id: r.id, quando: r.created_at, esito: r.conclusion || r.status };
      if (r.conclusion === 'failure') {
        v.passi_caduti = await passoCaduto(repo, r.id);
        v.errore = await righeErrore(repo, r.id);
      }
      voci.push(v);
    }
    out.repos[repo] = { runs: voci };
  } catch (e) {
    out.repos[repo] = { errore: redigi(e.message) };
  }
}
// numeri.json: percorso giusto (edge) + contenuto redatto
try {
  const r = await fetch('https://careauctions.co/numeri.json', { headers: { 'User-Agent': 'care-stato' } });
  const j = await r.json();
  out.numeri = { url: 'https://careauctions.co/numeri.json', stato: r.status, generato: j.generato, aggiornato: j.aggiornato, lotti: j.lotti, asteOggi: j.asteOggi, asteFuture: j.asteFuture, lottiAperti: j.lottiAperti, tribunali: j.tribunali };
} catch (e) { out.numeri = { errore: redigi(e.message) }; }

fs.mkdirSync('qa', { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1));
let md = `# Run GitHub — riassunto redatto\n\n> generato ${out.generato} · nessun segreto: filtro su token, email, IBAN, hash, percorsi.\n\n`;
for (const [repo, v] of Object.entries(out.repos)) {
  md += `## ${repo}\n\n`;
  if (v.errore) { md += `- ${v.errore}\n\n`; continue; }
  const rossi = v.runs.filter((r) => r.esito === 'failure');
  md += `- run nelle ultime 36 h: **${v.runs.length}** · falliti: **${rossi.length}**\n`;
  for (const r of rossi.slice(0, 6)) {
    md += `- **${r.workflow}** (${r.quando}) — passi caduti: ${(r.passi_caduti || []).join(', ') || 'non leggibili'}\n`;
    for (const e of (r.errore || []).slice(0, 3)) md += `  - \`${e.slice(0, 180)}\`\n`;
  }
  md += '\n';
}
md += `## numeri.json\n\n- percorso giusto: \`${out.numeri.url}\` (${out.numeri.stato})\n`;
fs.writeFileSync(OUT_MD, md);
console.log('scritti', OUT_JSON, 'e', OUT_MD);
