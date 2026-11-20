// 20/11/2026 — Guardiano delle metrature (Sam). Giudica lo stato dell'estrazione, non il log.
// Scrive guardiano-esito.txt (testo leggibile) e guardiano-esito.json (per l'invio).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const REPO = process.env.REPO || 'PuntoLuce26/care-auctions-pagine';
const H = { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'care-metrature-guardiano', Accept: 'application/vnd.github+json' };
const SOGLIA_FERMO_ORE = 12;       // nessun giro riuscito da più di 12 ore
const SOGLIA_AVANZA_ORE = 24;      // copertura ferma da 24 ore
const SOGLIA_ERRORI = 0.20;        // oltre il 20% di lotti in errore
const ora = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const allarmi = [];
let stato = null, runs = [], tot = { ok: 0, ko: 0, mq: 0, commerciale: 0 };

// 1) registro di copertura, se esiste
try {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/dati/metrature/stato.json?ref=main`, { headers: H });
  if (r.ok) { const j = await r.json(); stato = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); }
} catch (e) {}
// 2) run recenti del workflow metrature
try {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/metrature.yml/runs?per_page=10`, { headers: H });
  if (r.ok) runs = (await r.json()).workflow_runs || [];
} catch (e) {}
const riusciti = runs.filter(r => r.conclusion === 'success');
const ultimo = riusciti[0];
if (!ultimo) {
  allarmi.push('nessun giro di metrature riuscito: l\'estrazione non è mai partita o è sempre fallita');
} else {
  const ore = (Date.now() - new Date(ultimo.created_at).getTime()) / 3600000;
  if (ore > SOGLIA_FERMO_ORE) allarmi.push(`l'ultimo giro riuscito è di ${ore.toFixed(1)} ore fa (soglia ${SOGLIA_FERMO_ORE})`);
}
if (stato) {
  tot = stato.totale || tot;
  const etaOre = stato.aggiornato ? (Date.now() - new Date(stato.aggiornato).getTime()) / 3600000 : null;
  if (etaOre !== null && etaOre > SOGLIA_AVANZA_ORE) allarmi.push(`il registro di copertura non si aggiorna da ${etaOre.toFixed(1)} ore (soglia ${SOGLIA_AVANZA_ORE})`);
  const denom = (tot.ok || 0) + (tot.ko || 0);
  if (denom > 0) {
    const tasso = (tot.ko || 0) / denom;
    if (tasso > SOGLIA_ERRORI) allarmi.push(`lotti in errore ${(tasso * 100).toFixed(1)}% (soglia ${SOGLIA_ERRORI * 100}%)`);
  }
} else {
  allarmi.push('registro di copertura assente: nessun giro ha ancora scritto dati/metrature/stato.json');
}
const righe = [
  `METRATURE — controllo del ${ora()}`,
  '',
  stato ? `Copertura: ${tot.commerciale || 0} lotti con superficie commerciale, ${tot.mq || 0} con una metratura qualsiasi, ${tot.ok || 0} letti, ${tot.ko || 0} in errore.` : 'Copertura: registro assente.',
  runs.length ? `Ultimi giri: ${runs.slice(0, 3).map(r => `${r.created_at.slice(0, 16).replace('T', ' ')} ${r.conclusion || r.status}`).join(' · ')}` : 'Nessun run trovato.',
  '',
  allarmi.length ? 'ALLARMI:\n- ' + allarmi.join('\n- ') : 'Nessun allarme.'
];
writeFileSync('guardiano-esito.txt', righe.join('\n') + '\n');
writeFileSync('guardiano-esito.json', JSON.stringify({ generato: new Date().toISOString(), allarmi, stato, runs: runs.slice(0, 3).map(r => ({ created: r.created_at, conclusion: r.conclusion })) }, null, 2));
console.log(righe.join('\n'));
