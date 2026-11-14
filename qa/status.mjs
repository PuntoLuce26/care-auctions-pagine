// Pubblica lo stato del QA in qa/stato.json (pubblico, senza segreti).
// Lo legge il workflow del Secondo Cervello per registrare ogni giro.
import { readFileSync, writeFileSync } from 'node:fs';

// 14/11/2026 — PAGINAZIONE VERA: una sola pagina da 100 copriva ~12 ore, non 7 giorni.
async function storico7g() {
  const repo = process.env.GITHUB_REPOSITORY;
  const tok = process.env.GITHUB_TOKEN;
  if (!repo || !tok) return null;
  try {
    const tutte = [];
    for (let pagina = 1; pagina <= 10; pagina++) {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/qa.yml/runs?per_page=100&page=${pagina}`, {
        headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'care-qa' },
      });
      if (!r.ok) break;
      const j = await r.json();
      const blocco = j.workflow_runs || [];
      tutte.push(...blocco);
      if (blocco.length < 100) break;
    }
    const since = Date.now() - 7 * 86400000;
    const runs = tutte.filter(x => x.conclusion && new Date(x.created_at).getTime() >= since);
    const c = { success: 0, failure: 0, cancelled: 0, other: 0 };
    for (const x of runs) {
      if (x.conclusion === 'success') c.success++;
      else if (x.conclusion === 'failure') c.failure++;
      else if (x.conclusion === 'cancelled') c.cancelled++;
      else c.other++;
    }
    const eseguiti = c.success + c.failure;
    const totale = runs.length;
    return {
      finestraGiorni: 7,
      totale,
      ...c,
      tassoSuccessoEseguiti: eseguiti ? +(100 * c.success / eseguiti).toFixed(1) : null,
      tassoSuccessoGrezzo: totale ? +(100 * c.success / totale).toFixed(1) : null,
    };
  } catch { return null; }
}

let report;
try { report = JSON.parse(readFileSync('qa/out/report.json', 'utf8')); }
catch (e) { console.error('stato: report non leggibile'); process.exit(0); }

const issues = (report.issues || []).slice(0, 120).map(i => ({
  severity: i.severity,
  type: i.type,
  route: i.route || '',
  viewport: i.viewport || '',
  message: String(i.message || '').slice(0, 240),
  suggestion: String(i.suggestion || '').slice(0, 240)
}));

const storico = await storico7g();
const seo = report.seo || {};
const logs = report.logs || {};
const stato = {
  generatedAt: report.generatedAt,
  runId: process.env.GITHUB_RUN_ID || '',
  runUrl: process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '',
  base: report.base,
  durationSec: report.durationSec,
  build: report.build,
  summary: report.summary,
  storico7g: storico,
  issues,
  routes: (report.routes || []).map(r => ({
    route: r.route, viewport: r.viewport, http: r.http, text: r.text,
    imagesBroken: r.images?.realBroken?.length || 0,
    jsErrors: r.pageErrors?.length || 0,
    consoleErrors: r.consoleErrors?.length || 0,
    formsFilled: r.forms?.filled || 0,
    clicks: r.clicked || 0
  })),
  smoke: (report.smoke || []).map(s => ({ browser: s.browser, skipped: s.skipped || null, routes: (s.routes || []).map(x => ({ route: x.route, http: x.http, text: x.text, errors: (x.pageErrors || []).length })) })),
  seo: {
    llms: seo.llms, robots: seo.robots, sitemap: seo.sitemap,
    sitemapNovita: seo.sitemapNovita, sitemapPagine: seo.sitemapPagine,
    home: seo.home, botHome: seo.botHome, origin: seo.origin
  },
  feed: report.feed,
  logs: {
    checks: (logs.checks || []).map(c => ({ name: c.name, ok: c.ok, status: c.status, ms: c.ms, detail: c.detail })),
    github: logs.github ? { checked: logs.github.checked, failedLast24h: logs.github.failedLast24h || [] } : {}
  }
};

writeFileSync('qa/stato.json', JSON.stringify(stato, null, 2) + '\n', 'utf8');
if (storico) {
  const righe = [
    '## QA — ultimi 7 giorni',
    '',
    `- Run totali: **${storico.totale}** — success ${storico.success}, failure ${storico.failure}, cancelled ${storico.cancelled}`,
    `- Tasso sui run **eseguiti** (success+failure): **${storico.tassoSuccessoEseguiti}%**`,
    `- Tasso grezzo (include cancellati): ${storico.tassoSuccessoGrezzo}%`,
    '',
    'I run cancellati sono duplicati di trigger messi in coda, non verdetti QA: non contano nel tasso eseguito.'
  ].join('\n') + '\n';
  writeFileSync('qa/out/storico7g.md', righe, 'utf8');
  console.log(righe);
}

console.log('stato scritto: qa/stato.json', stato.summary);
