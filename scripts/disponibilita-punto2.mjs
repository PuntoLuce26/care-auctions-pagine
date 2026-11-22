// disponibilita-punto2.mjs — secondo punto di misura esterno (GitHub Actions), per l'art. 4 del
// D.M. 31/10/2006. Misura le stesse cinque URL del punto 1 (worker Cloudflare, cron ogni minuto)
// e scrive un registro giornaliero in disponibilita/<AAAA-MM-GG>.json. Zero dipendenze.
// Fascia 05:00-24:00 Europe/Rome. Separazione feriali/festivi.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const URLS = [
  ['home', 'https://careauctions.co/'],
  ['lotto', 'https://careauctions.co/aste/1822566'],
  ['idati', 'https://careauctions.co/api/idati'],
  ['feed', 'https://careauctions.co/feed/statistiche.json'],
  ['buynow', 'https://careauctions.co/buynow']
];

const FESTIVI = new Set(['01-01','01-06','04-25','05-01','06-02','08-15','11-01','12-08','12-25','12-26',
  '2026-04-05','2026-04-06','2027-03-28','2027-03-29','2028-04-16','2028-04-17']);

function dataRoma() {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' });
  const p = {};
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { giorno: `${p.year}-${p.month}-${p.day}`, ora: Number(p.hour), wd: p.weekday };
}
function festivo(d) {
  const mmgg = d.giorno.slice(5);
  return FESTIVI.has(mmgg) || FESTIVI.has(d.giorno) || d.wd === 'Sat' || d.wd === 'Sun';
}

const d = dataRoma();
if (d.ora < 5) { console.log('fuori fascia 05-24, esco'); process.exit(0); }

const esiti = [];
for (const [nome, url] of URLS) {
  const t0 = Date.now();
  let ok = false, stato = 0;
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'care-disponibilita-punto2/1.0 (art.4 DM 31/10/2006)' } });
    stato = r.status; ok = r.status >= 200 && r.status < 400;
  } catch { stato = 0; }
  esiti.push({ url: nome, ok, stato, ms: Date.now() - t0 });
  console.log(`${ok ? 'OK ' : 'KO '} ${String(stato).padStart(3)} ${Date.now() - t0}ms  ${nome}`);
}

const dir = 'disponibilita';
if (!existsSync(dir)) mkdirSync(dir);
const file = `${dir}/${d.giorno}.json`;
const rec = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { data: d.giorno, feriale: !festivo(d), campioni: 0, misure: 0, ok: 0, ko: 0, giriCompleti: 0, per: {}, ultimo: null };
rec.feriale = !festivo(d);
rec.campioni += 1;
rec.misure += esiti.length;
rec.ultimo = new Date().toISOString();
let giroOk = true;
for (const e of esiti) {
  const v = rec.per[e.url] || (rec.per[e.url] = { ok: 0, ko: 0 });
  if (e.ok) { v.ok++; rec.ok++; } else { v.ko++; rec.ko++; giroOk = false; }
}
if (giroOk) rec.giriCompleti += 1;
writeFileSync(file, JSON.stringify(rec, null, 1) + '\n');
console.log(`scritto ${file}: ${rec.campioni} giri, ${rec.ok}/${rec.misure} ok`);
