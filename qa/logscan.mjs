// QA CAReAuctions — lettura dei log e dei servizi.
// "Log del server": per il sito pubblico leggiamo ciò che il server espone (stato, feed, endpoint)
// e i run GitHub Actions. I log interni di Emergent non sono accessibili via API: lo dichiariamo.
import { BASE, ORIGIN } from './config.mjs';
import { ageHours, fetchJson, fetchText, makeIssue, short } from './lib.mjs';

const UA = 'CARe-QA/1.0 (+https://careauctions.co)';

async function checkGitHub() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'PuntoLuce26/care-auctions-pagine';
  if (!token) return { skipped: 'GITHUB_TOKEN assente (esecuzione locale)' };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=30`, {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'CARe-QA', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(25000)
    });
    if (!r.ok) return { status: r.status, error: 'GitHub API non accessibile' };
    const j = await r.json();
    const runs = (j.workflow_runs || []).map(x => ({
      name: x.name, status: x.status, conclusion: x.conclusion, created_at: x.created_at,
      url: x.html_url, head: (x.head_sha || '').slice(0, 8)
    }));
    const failed = runs.filter(x => x.conclusion && !['success', 'skipped', 'cancelled'].includes(x.conclusion));
    const recent = failed.filter(x => ageHours(x.created_at) < 24);
    return { checked: runs.length, failedLast24h: recent.slice(0, 8), failedTotal: failed.length };
  } catch (e) {
    return { status: 0, error: short(e.message, 120) };
  }
}

async function checkService(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { name, ok: !!r.ok, status: r.status || 0, ms: Date.now() - t0, detail: r.detail || '' };
  } catch (e) {
    return { name, ok: false, status: 0, ms: Date.now() - t0, detail: short(e.message, 160) };
  }
}

export async function runLogScan() {
  const checks = [];
  checks.push(await checkService('stato', async () => {
    const r = await fetchText(BASE + '/stato');
    return { ok: r.status === 200, status: r.status, detail: r.text.includes('Letto il') ? 'tabella popolata' : 'pagina senza data' };
  }));
  checks.push(await checkService('feed statistiche', async () => {
    const r = await fetchJson(BASE + '/feed/statistiche.json');
    const age = ageHours(r.json?.aggiornato);
    return { ok: r.status === 200 && !!r.json?.totale && age !== null && age < 2, status: r.status, detail: `totale ${r.json?.totale || '?'} · ${age} h fa` };
  }));
  checks.push(await checkService('feed aggiudicazioni', async () => {
    const r = await fetchJson(BASE + '/feed/aggiudicazioni.json');
    const n = Array.isArray(r.json) ? r.json.length : 0;
    return { ok: r.status === 200 && n > 0, status: r.status, detail: `${n} record` };
  }));
  checks.push(await checkService('origine Emergent', async () => {
    const r = await fetchText(ORIGIN + '/', { ua: UA });
    return { ok: r.status === 200, status: r.status, detail: (r.text.match(/main\.[a-f0-9]{8}\.js/) || ['no build'])[0] };
  }));
  // 18/11/2026 — il check deve chiamare la ROTTA PUBBLICA, non l'origine: `icare-ai.…workers.dev`
  // risponde 401 agli anonimi per progetto (era il falso «chat iCARe HTTP 401»). Stessa classe di
  // errore già corretta in internal-audit.
  checks.push(await checkService('chat iCARe', async () => {
    const r = await fetch(BASE + '/api/icare', {
      method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': 'CARe-QA/1.0' },
      body: JSON.stringify({ azione: 'ai-chat', messaggio: 'ciao', lingua: 'it' }),
      signal: AbortSignal.timeout(25000)
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    const risposta = (j && (j.risposta || j.testo)) || '';
    return { ok: r.status === 200 && String(risposta).length > 10, status: r.status, detail: short(risposta || t, 80) };
  }));
  // 18/11/2026 — stessa classe: l'origine risponde 403 agli anonimi, la parete pubblica vive su
  // careauctions.co/api/battito (200, JSON con messaggi[]).
  checks.push(await checkService('iCAReWall API', async () => {
    const r = await fetchText(BASE + '/api/battito?lang=it', { ua: UA });
    let n = null; try { const j = JSON.parse(r.text); n = Array.isArray(j.messaggi) ? j.messaggi.length : null; } catch (e) {}
    return { ok: r.status === 200 && n !== null, status: r.status, detail: `${r.text.length} byte · ${n === null ? 'JSON non valido' : n + ' messaggi'}` };
  }));
  checks.push(await checkService('voce TTS', async () => {
    const r = await fetchText(BASE + '/voce/tts-worker.js');
    return { ok: r.status === 200, status: r.status, detail: `${r.text.length} byte` };
  }));

  const github = await checkGitHub();
  const issues = [];
  for (const c of checks) {
    if (!c.ok) issues.push(makeIssue({
      severity: c.name === 'chat iCARe' || c.name === 'feed statistiche' ? 'high' : 'medium',
      type: 'servizio_' + c.name.replace(/\s+/g, '_'),
      route: 'servizi', viewport: '',
      message: `${c.name}: HTTP ${c.status} ${c.detail}`,
      suggestion: 'Verificare il servizio e il deploy corrispondente; se è Emergent, controllare la build e il pannello.'
    }));
  }
  if (github.failedLast24h?.length) {
    issues.push(makeIssue({
      severity: 'medium', type: 'github_run_falliti', route: 'log', viewport: '',
      message: github.failedLast24h.map(x => `${x.name} (${x.conclusion})`).join(', '),
      suggestion: 'Aprire i run falliti; se sono build Pages cancellate da un commit, non è un guasto (vedi LEZIONI).'
    }));
  }
  return { checks, github, issues };
}
