// Pubblica lo stato del QA in qa/stato.json (pubblico, senza segreti).
// Lo legge il workflow del Secondo Cervello per registrare ogni giro.
import { readFileSync, writeFileSync } from 'node:fs';

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
console.log('stato scritto: qa/stato.json', stato.summary);
