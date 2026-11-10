#!/usr/bin/env node
// QA CAReAuctions — orchestratore.
// Esegue crawl + log scan, scrive report.json, summary.md, fix-proposals.md e patch.diff.
// Non applica nulla in produzione: la patch sicura viene proposta alla CI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { runCrawl } from './crawl.mjs';
import { runLogScan } from './logscan.mjs';
import { buildProposals } from './autofix.mjs';
import { escMd, short, severityRank } from './lib.mjs';

const OUT = process.env.QA_OUT || 'qa/out';
mkdirSync(OUT, { recursive: true });

const started = new Date();
console.log('QA CAReAuctions — inizio', started.toISOString());

let crawl;
try {
  crawl = await runCrawl();
} catch (e) {
  crawl = { generatedAt: new Date().toISOString(), base: process.env.QA_BASE || 'https://careauctions.co', routes: [], smoke: [], seo: {}, feed: {}, links: { checked: 0, broken: [] }, issues: [{ severity: 'critical', type: 'qa_infra', route: '', viewport: '', message: 'crawler non eseguito: ' + String(e.message).slice(0, 200), suggestion: 'Verificare Playwright e la rete del runner.' }], summary: { critical: 1, high: 0, medium: 0, low: 0, total: 1 } };
  console.error('CRAWL ERROR', e);
}

let logs;
try {
  logs = await runLogScan();
} catch (e) {
  logs = { checks: [], github: {}, issues: [{ severity: 'medium', type: 'logscan_infra', route: 'log', viewport: '', message: String(e.message).slice(0, 200), suggestion: '' }] };
  console.error('LOGSCAN ERROR', e);
}

const issues = [...(crawl.issues || []), ...(logs.issues || [])];
issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
const summary = { critical: 0, high: 0, medium: 0, low: 0, total: issues.length };
for (const i of issues) summary[i.severity] = (summary[i.severity] || 0) + 1;

const report = {
  generatedAt: new Date().toISOString(),
  base: process.env.QA_BASE || 'https://careauctions.co',
  fast: !!process.env.QA_FAST,
  durationSec: Math.round((Date.now() - started.getTime()) / 1000),
  build: { sito: crawl.seo?.home?.build || null, origine: crawl.seo?.origin?.build || null },
  summary,
  issues,
  routes: crawl.routes || [],
  smoke: crawl.smoke || [],
  seo: crawl.seo || {},
  feed: crawl.feed || {},
  links: crawl.links || { checked: 0, broken: [] },
  logs
};

report.summary = summary;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');

// ── summary.md ──────────────────────────────────────────────────────────────
const lines = [];
lines.push('# QA CAReAuctions — report');
lines.push('');
lines.push(`Generato: **${report.generatedAt}** · base: ${report.base} · durata: ${report.durationSec}s`);
lines.push('');
lines.push(`Build: sito \`${report.build.sito || '?'}\` · origine \`${report.build.origine || '?'}\` · ${report.build.sito && report.build.sito === report.build.origine ? 'allineata' : 'DA VERIFICARE'}`);
lines.push('');
lines.push('## Esito');
lines.push('');
lines.push('| Critici | Alti | Medi | Bassi | Totale |');
lines.push('|---|---|---|---|---|');
lines.push(`| **${summary.critical}** | ${summary.high} | ${summary.medium} | ${summary.low} | ${summary.total} |`);
lines.push('');

lines.push('## Pagine (crawl)');
lines.push('');
lines.push('| Pagina | Viewport | HTTP | Testo | Immagini rotte | Errori JS | Console | Link |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const r of report.routes) {
  lines.push(`| ${escMd(r.route)} | ${r.viewport} | ${r.http ?? '—'} | ${r.text ?? 0} | ${r.images?.realBroken?.length || 0} | ${r.pageErrors?.length || 0} | ${r.consoleErrors?.length || 0} | ${r.clicked ?? 0} click |`);
}
lines.push('');

if (report.smoke?.length) {
  lines.push('## Cross-browser');
  lines.push('');
  for (const s of report.smoke) {
    if (s.skipped) { lines.push(`- ${s.browser}: saltato (${s.skipped})`); continue; }
    const bad = s.routes.filter(r => r.http !== 200 || r.pageErrors?.length || (r.text || 0) < 80);
    lines.push(`- ${s.browser}: ${s.routes.length - bad.length}/${s.routes.length} rotte OK${bad.length ? ' — KO: ' + bad.map(b => b.route).join(', ') : ''}`);
  }
  lines.push('');
}

lines.push('## SEO e AI');
lines.push('');
lines.push('| Controllo | Esito |');
lines.push('|---|---|');
const seo = report.seo || {};
lines.push(`| llms.txt | ${seo.llms?.ok ? '200' : 'KO'} · pagine ${seo.llms?.hasPages ? 'sì' : 'no'} · citazione ${seo.llms?.hasCite ? 'sì' : 'no'} |`);
lines.push(`| robots.txt | ${seo.robots?.ok ? '200' : 'KO'} · agenti AI ${seo.robots?.hasAi ? 'sì' : 'no'} |`);
lines.push(`| sitemap index | ${seo.sitemap?.ok ? '200' : 'KO'} · novita ${seo.sitemap?.hasNovita ? 'sì' : 'no'} |`);
lines.push(`| sitemap-novita | ${seo.sitemapNovita?.urls || 0} URL · hreflang affiliazione ${seo.sitemapNovita?.hasAffiliationSelf ? 'ok' : 'KO'} |`);
lines.push(`| sitemap-pagine | ${seo.sitemapPagine?.ok ? '200' : 'KO'} · buynow ${seo.sitemapPagine?.hasBuynow ? 'sì' : 'no'} |`);
lines.push(`| home umana | 200 · striscia ${seo.home?.strip ? 'sì' : 'no'} |`);
lines.push(`| home bot | 200 · link ${seo.botHome?.links?.length || 0}/4 |`);
lines.push('');
lines.push(`Feed statistiche: ${report.feed?.statistiche?.totale ?? '?'} lotti · ${report.feed?.statistiche?.ageHours ?? '?'} h fa · aggiudicazioni ${report.feed?.aggiudicazioni?.count ?? '?'}`);
lines.push('');

lines.push('## Log e servizi');
lines.push('');
lines.push('| Controllo | Esito | Dettaglio |');
lines.push('|---|---|---|');
for (const c of logs.checks || []) lines.push(`| ${escMd(c.name)} | ${c.ok ? 'ok' : 'KO'} | ${escMd(short(c.detail, 60))} |`);
if (logs.github?.failedLast24h?.length) lines.push(`| GitHub (24h) | KO | ${logs.github.failedLast24h.map(x => escMd(x.name + ' ' + x.conclusion)).join(', ')} |`);
else lines.push('| GitHub (24h) | ok | nessun run fallito |');
lines.push('');
lines.push('> Nota: i log interni di Emergent non sono accessibili via API. Il QA misura ciò che il sito e gli endpoint pubblici restituiscono, più i run GitHub Actions.');
lines.push('');

if (issues.length) {
  lines.push('## Problemi');
  lines.push('');
  lines.push('| Gravità | Tipo | Dove | Messaggio |');
  lines.push('|---|---|---|---|');
  for (const i of issues.slice(0, 80)) lines.push(`| ${i.severity} | ${escMd(i.type)} | ${escMd([i.route, i.viewport].filter(Boolean).join(' · '))} | ${escMd(short(i.message, 160))} |`);
  lines.push('');
}

lines.push('## Proposte');
lines.push('');
lines.push('Vedi `qa/out/fix-proposals.md` e `qa/out/patch.diff` (artefatto del run).');
lines.push('');

const summaryMd = lines.join('\n');
writeFileSync(`${OUT}/summary.md`, summaryMd + '\n', 'utf8');

const proposals = buildProposals(report);
report.fixProposals = proposals.md;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(summaryMd);
console.log('--- PROPOSTE ---');
console.log(proposals.md.slice(0, 4000));
console.log(`QA fine: ${summary.critical} critici, ${summary.high} alti, ${summary.medium} medi, ${summary.low} bassi · ${report.durationSec}s`);
