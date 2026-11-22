// disponibilita-report.mjs — report mensile e quadrimestrale della disponibilità (art. 4 D.M. 31/10/2006).
// Unisce le due fonti: il punto 2 (registro disponibilita/<data>.json in questo repo) e il punto 1
// (worker care-disponibilita, cron ogni minuto) letto via /report. Separa feriali e festivi nella
// fascia 05:00-24:00 Europe/Rome. Scrive disponibilita/report-<DA>_<A>.json e .md.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]);
  return a;
}, []));

function meseP(anno, mese) { // mese 0-based -> {da, a}
  const da = new Date(Date.UTC(anno, mese, 1));
  const a = new Date(Date.UTC(anno, mese + 1, 0));
  return { da: da.toISOString().slice(0, 10), a: a.toISOString().slice(0, 10) };
}
const oggi = new Date();
const prev = meseP(oggi.getUTCFullYear(), oggi.getUTCMonth() - 1);
const DA = args.da || prev.da;
const A = args.a || prev.a;

// ---- punto 2: dal repo
function dalRepo(da, a) {
  const dir = 'disponibilita';
  if (!existsSync(dir)) return { fonte: 'repo', giorni: 0, feriali: vuoto(), festivi: vuoto() };
  const agg = { feriali: vuoto(), festivi: vuoto() };
  let giorni = 0;
  for (const f of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    if (f.slice(0, 10) < da || f.slice(0, 10) > a) continue;
    let g;
    try { g = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
    const t = g.feriale ? agg.feriali : agg.festivi;
    t.campioni += g.campioni || 0;
    t.misure += g.misure || (g.campioni || 0) * 5;
    t.ok += g.ok || 0;
    t.ko += g.ko || 0;
    t.giriCompleti += g.giriCompleti || 0;
    giorni++;
  }
  return { fonte: 'repo', giorni, ...agg };
}

// ---- punto 1: dal worker
async function dalWorker(da, a) {
  const base = process.env.DISP_WORKER || 'https://care-disponibilita.misty-mode-1cbc.workers.dev';
  if (!process.env.REGIA_KEY) return { fonte: 'worker', nota: 'REGIA_KEY assente' };
  try {
    const r = await fetch(`${base}/report?da=${da}&a=${a}`, { headers: { 'x-regia': process.env.REGIA_KEY } });
    if (!r.ok) return { fonte: 'worker', nota: 'HTTP ' + r.status };
    return { fonte: 'worker', ...(await r.json()) };
  } catch (e) { return { fonte: 'worker', nota: String(e) }; }
}

function vuoto() { return { campioni: 0, misure: 0, ok: 0, ko: 0, giriCompleti: 0 }; }
function pct(t) { return t.misure ? +(100 * t.ok / t.misure).toFixed(4) : null; }
function esito(t, soglia) { const p = pct(t); return p === null ? 'nessun dato' : (p >= soglia ? 'conforme' : 'sotto soglia'); }

const R = dalRepo(DA, A);
const W = await dalWorker(DA, A);
const wf = W.feriali && W.feriali.misure !== undefined ? W.feriali : null;
const wfe = W.festivi && W.festivi.misure !== undefined ? W.festivi : null;

const out = {
  periodo: { da: DA, a: A },
  generato: new Date().toISOString(),
  fonte1_worker: W.nota ? { nota: W.nota } : { feriali: W.feriali, festivi: W.festivi, esito: W.esito },
  fonte2_repo: {
    giorni: R.giorni,
    feriali: { ...R.feriali, disponibilita: pct(R.feriali), esito: esito(R.feriali, 99) },
    festivi: { ...R.festivi, disponibilita: pct(R.festivi), esito: esito(R.festivi, 95) }
  },
  esito: (() => {
    const a1 = wf ? esito(wf, 99) : 'nessun dato';
    const a2 = esito(R.feriali, 99);
    if (a1 === 'sotto soglia' || a2 === 'sotto soglia') return 'sotto soglia';
    if (a1 === 'nessun dato' && a2 === 'nessun dato') return 'nessun dato';
    return 'conforme';
  })()
};

const md = `# Disponibilità ${DA} → ${A}

Generato il ${out.generato.slice(0, 16).replace('T', ' ')} UTC · fascia 05:00-24:00 Europe/Rome · soglie: 99% feriali, 95% festivi

## Esito

**${out.esito}**

## Punto 1 — worker Cloudflare (cron ogni minuto)

${W.nota ? 'Non disponibile: ' + W.nota : `| | Feriali | Festivi |
|---|---|---|
| Misure | ${W.feriali?.misure ?? 0} | ${W.festivi?.misure ?? 0} |
| Risposte valide | ${W.feriali?.ok ?? 0} | ${W.festivi?.ok ?? 0} |
| Disponibilità | ${W.feriali?.disponibilita ?? '—'}% | ${W.festivi?.disponibilita ?? '—'}% |
| Esito | ${esito(W.feriali || vuoto(), 99)} | ${esito(W.festivi || vuoto(), 95)} |`}

## Punto 2 — GitHub Actions (ogni 5 minuti)

| | Feriali | Festivi |
|---|---|---|
| Giorni misurati | ${R.giorni} | ${R.giorni} |
| Giri | ${R.feriali.campioni} | ${R.festivi.campioni} |
| Misure | ${R.feriali.misure} | ${R.festivi.misure} |
| Risposte valide | ${R.feriali.ok} | ${R.festivi.ok} |
| Disponibilità | ${pct(R.feriali) ?? '—'}% | ${pct(R.festivi) ?? '—'}% |
| Esito | ${esito(R.feriali, 99)} | ${esito(R.festivi, 95)} |
`;

writeFileSync(`disponibilita/report-${DA}_${A}.json`, JSON.stringify(out, null, 2) + '\n');
writeFileSync(`disponibilita/report-${DA}_${A}.md`, md);
console.log(md);
