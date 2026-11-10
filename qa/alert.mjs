#!/usr/bin/env node
/* QA email-alert: riceve gli allarmi dal mail-qa, li registra e attiva i soccorsi noti. */
import fs from 'node:fs';
import path from 'node:path';
const A = JSON.parse(process.env.ALERT_JSON || '{}');
const alerts = A.alerts || [];
const REPO = process.env.GITHUB_REPOSITORY || 'PuntoLuce26/care-auctions-pagine';
const GH = process.env.GITHUB_TOKEN;
const RUN = process.env.GITHUB_RUN_ID || '';
const api = async (u, opt = {}) => { const r = await fetch('https://api.github.com' + u, { ...opt, headers: { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json', 'User-Agent': 'care-qa-alert', 'Content-Type': 'application/json', ...(opt.headers || {}) } }); return { status: r.status, text: await r.text() }; };
(async () => {
  fs.mkdirSync(path.join(process.cwd(), 'qa', 'out'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'qa', 'out', 'alert.json'), JSON.stringify(A, null, 2));
  const azioni = [];
  for (const a of alerts) {
    let z = '';
    if (a.componente === 'pages') { const r = await api('/repos/' + REPO + '/pages/builds', { method: 'POST', body: '{}' }); z = 'rebuild Pages HTTP ' + r.status; }
    else if (a.componente === 'prerender') { const r = await api('/repos/' + REPO + '/actions/workflows/prerender.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) }); z = 'dispatch prerender HTTP ' + r.status; }
    else if (a.componente === 'feed') { const r = await api('/repos/' + REPO + '/actions/workflows/feed-sync.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) }); z = 'dispatch feed-sync HTTP ' + r.status; }
    else if (a.componente === 'app-ci') { const r = await api('/repos/PuntoLuce26/care-aste-app/actions/workflows/ci.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) }); z = 'dispatch app-ci HTTP ' + r.status; }
    else if (a.componente === 'guardiano' || a.componente === 'edge' || a.componente === 'emergent') { z = 'QA crawl + issue (serve intervento)'; }
    else { z = 'QA crawl + issue'; }
    azioni.push({ componente: a.componente, gravita: a.gravita, oggetto: a.oggetto, azione: z });
  }
  const body = '## Allarmi mail ricevuti dal QA\n\n' + alerts.map((a, i) => `${i + 1}. **${a.gravita}** · ${a.componente} · ${a.oggetto}\n   da ${a.da} · ${a.data}${a.link ? ' · ' + a.link : ''}`).join('\n') + '\n\n## Azioni\n\n' + azioni.map(a => `- ${a.componente}: ${a.azione}`).join('\n') + '\n\nQA run: https://github.com/' + REPO + '/actions/runs/' + RUN;
  const r = await api('/repos/' + REPO + '/issues', { method: 'POST', body: JSON.stringify({ title: '[QA] Allarme mail: ' + alerts.length + ' segnalazioni', body, labels: ['qa', 'alert'] }) });
  console.log(JSON.stringify({ alerts: alerts.length, azioni, issue: r.status }));
})().catch(e => { console.error('QA ALERT ERRORE', e.message); process.exit(1); });
