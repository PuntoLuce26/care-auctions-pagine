// qa/accessibilita.mjs — test automatici di accessibilità (metodo AgID, WCAG 2.1 AA).
// Playwright + axe-core. 20 pagine, dichiarate qui sotto. Non compila moduli, non invia nulla.
// Scrive qa/accessibilita.json e qa/accessibilita.md con le violazioni per pagina, impatto e criterio.
// Le violazioni "critical" e "serious" sono quelle da portare subito a Emergent.

import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');

const BASE = 'https://careauctions.co';
const PAGINE = [
  ['home', '/'],
  ['aste', '/aste'],
  ['lotto', '/aste/1822566'],
  ['idati', '/idati'],
  ['osservatorio', '/osservatorio'],
  ['aggiudicazioni', '/aggiudicazioni'],
  ['buynow', '/buynow'],
  ['san-pasquale', '/buynow/san-pasquale'],
  ['segnala', '/buynow/segnala'],
  ['ishop', '/ishop'],
  ['ipartner', '/ipartner'],
  ['piani', '/piani'],
  ['termini', '/termini'],
  ['privacy', '/privacy'],
  ['cookie', '/cookie'],
  ['accessibilita', '/accessibilita'],
  ['chi-siamo', '/chi-siamo'],
  ['fondatore', '/fondatore'],
  ['metodo', '/metodo'],
  ['contatti', '/contatti']
];

const browser = await chromium.launch();
const contesto = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'it-IT', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });

const risultati = [];
for (const [nome, path] of PAGINE) {
  const pagina = await contesto.newPage();
  const r = { nome, path, stato: 0, titolo: '', violazioni: [], critical: 0, serious: 0, moderate: 0, minor: 0, totale: 0, errore: null };
  try {
    // domcontentloaded e non networkidle: la pagina lotto fa polling continuo (feed, pulse) e
    // networkidle non arriva mai, pur rispondendo in 2,8-4,4 s. L'attesa vera è il render sotto.
    const risposta = await pagina.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
    r.stato = risposta ? risposta.status() : 0;
    await pagina.waitForTimeout(3500);
    r.titolo = (await pagina.title()).slice(0, 90);
    if (r.stato >= 400) { risultati.push(r); await pagina.close(); continue; }
    await pagina.addScriptTag({ path: axePath });
    const res = await pagina.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        resultTypes: ['violations']
      });
    });
    for (const v of res.violations || []) {
      const nodi = (v.nodes || []).length;
      const rec = { id: v.id, impact: v.impact || 'none', help: (v.help || '').slice(0, 120), wcag: (v.tags || []).filter(t => t.startsWith('wcag')).join(','), nodi, esempio: (v.nodes?.[0]?.target || []).join(' ')?.slice(0, 120) || '' };
      r.violazioni.push(rec);
      if (rec.impact === 'critical') r.critical++;
      else if (rec.impact === 'serious') r.serious++;
      else if (rec.impact === 'moderate') r.moderate++;
      else r.minor++;
    }
    r.totale = r.violazioni.length;
  } catch (e) {
    r.errore = String(e).slice(0, 160);
  }
  risultati.push(r);
  await pagina.close();
  const st = r.errore ? 'ERR' : `${r.stato}`;
  console.log(`${st} ${nome.padEnd(14)} violazioni ${String(r.totale).padStart(2)} (C${r.critical} S${r.serious} M${r.moderate} m${r.minor})`);
}
await browser.close();

const somma = (k) => risultati.reduce((a, r) => a + (r[k] || 0), 0);
const out = {
  generato: new Date().toISOString(),
  metodo: 'Playwright + axe-core, WCAG 2.1 AA (tag wcag2a, wcag2aa, wcag21a, wcag21aa)',
  pagine: risultati.length,
  totali: { critical: somma('critical'), serious: somma('serious'), moderate: somma('moderate'), minor: somma('minor'), violazioni: somma('totale') },
  perPagina: risultati
};
mkdirSync('qa', { recursive: true });
writeFileSync('qa/accessibilita.json', JSON.stringify(out, null, 2) + '\n');

const righe = [
  `# Accessibilità — test automatici (WCAG 2.1 AA, axe-core)`,
  ``,
  `Generato il ${out.generato.slice(0, 16).replace('T', ' ')} UTC · ${out.pagine} pagine · ${out.metodo}`,
  ``,
  `**Totali**: critical ${out.totali.critical} · serious ${out.totali.serious} · moderate ${out.totali.moderate} · minor ${out.totali.minor} · violazioni ${out.totali.violazioni}`,
  ``,
  `| Pagina | HTTP | C | S | M | m | Violazioni principali |`,
  `|---|---|---|---|---|---|---|`,
];
for (const r of risultati) {
  const top = r.violazioni.slice(0, 4).map(v => `${v.id}(${v.impact})`).join(', ');
  righe.push(`| ${r.nome} | ${r.stato || '—'} | ${r.critical} | ${r.serious} | ${r.moderate} | ${r.minor} | ${top || r.errore || '—'} |`);
}
righe.push(``, `Le pagine con criticità o seri vanno portate a Emergent in un prompt unico, con il criterio WCAG e l'elemento.`);
writeFileSync('qa/accessibilita.md', righe.join('\n') + '\n');
console.log(`\nTotali: critical ${out.totali.critical}, serious ${out.totali.serious}, moderate ${out.totali.moderate}, minor ${out.totali.minor}`);
