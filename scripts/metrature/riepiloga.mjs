// 20/11/2026 — Riepilogo delle metrature (Sam). Legge tutti i JSONL del giro, aggiorna il registro di
// copertura cumulativo `dati/metrature/stato.json` e lo committa. Il registro è ciò che il guardiano
// guarda: senza di lui il guardiano non ha niente da giudicare.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.REPO || 'PuntoLuce26/care-auctions-pagine';
const H = { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'care-metrature', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
const dir = process.argv[2] || '.';
const file = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
const tot = { ok: 0, ko: 0, mq: 0, commerciale: 0, utile: 0, catastale: 0, lorda: 0, rivedere: 0 };
const visti = new Set();
for (const f of file) {
  for (const riga of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
    if (!riga.trim()) continue;
    let d; try { d = JSON.parse(riga); } catch { continue; }
    if (visti.has(d.id)) continue;
    visti.add(d.id);
    if (d.errore) { tot.ko++; continue; }
    tot.ok++;
    if (d.mq_valore) {
      tot.mq++;
      const t = d.mq_tipo || '';
      if (t === 'commerciale') tot.commerciale++;
      else if (t === 'utile') tot.utile++;
      else if (t === 'catastale') tot.catastale++;
      else if (t === 'lorda') tot.lorda++;
      if (d.mq_da_rivedere) tot.rivedere++;
    }
  }
}
// registro precedente: si somma, non si sovrascrive (un giro non deve cancellare i precedenti)
let prec = null, shaPrec = null;
try {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/dati/metrature/stato.json?ref=main`, { headers: H });
  if (r.ok) { const j = await r.json(); shaPrec = j.sha; prec = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); }
} catch (e) {}
const cum = prec && prec.totale ? { ...prec.totale } : { ok: 0, ko: 0, mq: 0, commerciale: 0, utile: 0, catastale: 0, lorda: 0, rivedere: 0 };
for (const k of Object.keys(tot)) cum[k] = (cum[k] || 0) + tot[k];
const stato = {
  aggiornato: new Date().toISOString(),
  giro: { lotti: visti.size, ...tot, file: file.length },
  totale: cum,
  note: 'Registro cumulativo delle metrature: si somma a ogni giro, non si sovrascrive. Lo legge il guardiano (metrature-guardiano).'
};
writeFileSync('stato.json', JSON.stringify(stato, null, 2));
const body = { message: `metrature: registro di copertura — giro di ${visti.size} lotti, ${tot.commerciale} commerciali (totale ${cum.commerciale})`, content: Buffer.from(JSON.stringify(stato, null, 2)).toString('base64'), branch: 'main' };
if (shaPrec) body.sha = shaPrec;
const r = await fetch(`https://api.github.com/repos/${REPO}/contents/dati/metrature/stato.json`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
console.log('registro aggiornato:', r.status, JSON.stringify(stato.giro));
