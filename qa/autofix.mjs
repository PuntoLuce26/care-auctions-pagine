// QA CAReAuctions — proposte di correzione.
// Regola: una patch si applica solo se è una sostituzione esatta e sicura (qa/fix-rules.json).
// Tutto ciò che vive nell'app Emergent diventa un prompt in inglese, pronto da incollare:
// da qui non possiamo pubblicare il loro codice, e una patch non verificata in produzione è un guasto.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const RULES_FILE = join(ROOT, 'qa', 'fix-rules.json');

const RULES = (() => {
  try { return JSON.parse(readFileSync(RULES_FILE, 'utf8')); } catch (e) { return {}; }
})();

function walk(dir, out = [], depth = 0) {
  if (depth > 2 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (/\.(html|htm|js|mjs|json|xml|txt)$/i.test(name) && st.size < 400000) out.push(p);
  }
  return out;
}

function findFiles() {
  const dirs = ['prerender', 'comunicati', 'qa'];
  const files = [];
  for (const d of dirs) for (const f of walk(join(ROOT, d))) files.push(f);
  return files;
}

// Applica solo sostituzioni esatte dichiarate in qa/fix-rules.json.
// Ritorna {changes, patch}; il working tree viene ripristinato prima di uscire.
export function applySafeFixes(report) {
  const changes = [];
  const byUrl = new Map();
  for (const i of report.issues || []) {
    if (i.type !== 'link_rotto') continue;
    const m = String(i.message || '').match(/^(\d{3})\s+(https?:\/\/\S+)/);
    if (!m) continue;
    const oldUrl = m[2];
    const rule = RULES[oldUrl] || RULES[oldUrl.replace(/\/$/, '')];
    if (!rule) continue;
    byUrl.set(oldUrl, rule);
  }
  if (!byUrl.size) return { changes, patch: '' };

  const files = findFiles();
  for (const [oldUrl, newUrl] of byUrl) {
    for (const file of files) {
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch (e) { continue; }
      if (!text.includes(oldUrl)) continue;
      const next = text.split(oldUrl).join(newUrl);
      try { writeFileSync(file, next, 'utf8'); changes.push({ file: relative(ROOT, file), oldUrl, newUrl }); } catch (e) {}
    }
  }
  let patch = '';
  if (changes.length) {
    try { patch = execSync('git diff -- ' + changes.map(c => "'" + c.file + "'").join(' '), { cwd: ROOT, encoding: 'utf8' }); } catch (e) {}
    // ripristina: la patch la applica la CI su un branch, non il workspace del report
    try { execSync('git checkout -- ' + changes.map(c => "'" + c.file + "'").join(' '), { cwd: ROOT, stdio: 'ignore' }); } catch (e) {}
  }
  return { changes, patch };
}

function promptFor(issues) {
  if (!issues.length) return '';
  const rows = issues.slice(0, 30).map((i, n) => {
    const where = [i.route, i.viewport].filter(Boolean).join(' · ');
    return `${n + 1}. [${i.severity}] ${where || i.type}: ${i.message}${i.suggestion ? '\n   Suggested fix: ' + i.suggestion : ''}`;
  }).join('\n');
  return `You are fixing production bugs on CAReAuctions (careauctions.co), a React app.
A cloud QA crawler found the issues below by browsing the live site (desktop and mobile), clicking safe UI controls, filling forms without submitting, checking images, links, console and HTTP errors.
Fix them in the component source (not with CSS overlays or edge patches). Keep the brand CAReAuctions and the domain careauctions.co. Do not introduce negations in marketing copy. Do not invent numbers. After publishing, report the build hash and what you changed.

ISSUES
${rows}

For each issue, state: file changed, what was wrong, the fix, and how you verified it. If an issue is not real, say so with the evidence; do not claim it fixed.`;
}

export function buildProposals(report) {
  const appIssues = (report.issues || []).filter(i =>
    ['pageerror', 'console_error', 'http_5xx', 'page_fatal', 'pagina_vuota', 'click_error', 'form_invalid', 'canonical_mancante', 'seo_home_strip', 'seo_bot_links'].includes(i.type)
  );
  const safe = applySafeFixes(report);
  const lines = [];
  lines.push('# Proposte di correzione — QA CAReAuctions');
  lines.push('');
  lines.push(`Generato: ${report.generatedAt} · base: ${report.base}`);
  lines.push('');
  lines.push('## Patch sicura (solo sostituzioni esatte)');
  if (safe.changes.length) {
    for (const c of safe.changes) lines.push(`- \`${c.file}\`: ${c.oldUrl} → ${c.newUrl}`);
    lines.push('');
    lines.push('```diff');
    lines.push(safe.patch.trim());
    lines.push('```');
  } else {
    lines.push('Nessuna sostituzione esatta applicabile con le regole attuali (`qa/fix-rules.json`).');
  }
  lines.push('');
  lines.push('## Prompt per Emergent (bug dell\'app)');
  if (appIssues.length) {
    lines.push('Copia questo blocco in Emergent. È già in inglese e contiene solo i bug misurati.');
    lines.push('');
    lines.push('```text');
    lines.push(promptFor(appIssues));
    lines.push('```');
  } else {
    lines.push('Nessun bug dell\'app tra quelli rilevati in questo giro.');
  }
  lines.push('');
  lines.push('## Cosa NON viene applicato in automatico');
  lines.push('- Bug dell\'app Emergent: non abbiamo accesso al loro deploy; la patch diventa il prompt sopra.');
  lines.push('- Modifiche all\'edge che richiedono un deploy Cloudflare: vanno riviste e deployate con backup.');
  lines.push('- Qualunque correzione che non sia una sostituzione esatta e sicura.');
  lines.push('');
  const md = lines.join('\n');
  const outDir = join(ROOT, 'qa', 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'fix-proposals.md'), md + '\n', 'utf8');
  writeFileSync(join(outDir, 'patch.diff'), safe.patch || '', 'utf8');
  return { md, patch: safe.patch || '', changes: safe.changes };
}
