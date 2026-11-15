#!/usr/bin/env node
/** omi-r2-scarica.mjs — porta il dataset OMI dal bucket R2 `care-dati` al runner.
 *
 *  PERCHÉ ESISTE (15/11/2026). Il dataset OMI (81 MB di quotazioni + 45 cache semestrali da 44 MB)
 *  stava SOLO sul Mac: per questo `fordi/aste-zone.json` e `feed/omi-indice.json` non si potevano
 *  rigenerare in cloud e il canary non atterrava. Dal 15/11 il dataset è su R2 (bucket `care-dati`,
 *  prefisso `dati/omi/`) e questo script è la porta d'ingresso: stesso percorso locale e stesso
 *  script di prima, ma i byte arrivano dal cloud.
 *
 *  USO:  node scripts/omi-r2-scarica.mjs <destDirAgg> <destFileDataset>
 *  ENV:  CLOUDFLARE_API_TOKEN (secret del repo) · R2_ACCOUNT · R2_BUCKET (default care-dati)
 *  Se il token manca lo script FALLISCE dichiarandolo: meglio niente che un dataset a metà.
 */
import fs from 'node:fs';
import path from 'node:path';

const [destAgg, destDataset] = process.argv.slice(2);
if (!destAgg || !destDataset) {
  console.error('uso: node scripts/omi-r2-scarica.mjs <destDirAgg> <destFileDataset>');
  process.exit(2);
}
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT = process.env.R2_ACCOUNT || 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const BUCKET = process.env.R2_BUCKET || 'care-dati';
if (!TOKEN) {
  console.error('omi-r2: CLOUDFLARE_API_TOKEN assente — impossibile leggere il dataset da R2');
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects`;
const H = { Authorization: 'Bearer ' + TOKEN };

async function elenca(prefix) {
  const out = [];
  let cursor = null;
  do {
    const u = new URL(API);
    u.searchParams.set('per_page', '1000');
    u.searchParams.set('prefix', prefix);
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await fetch(u, { headers: H });
    const j = await r.json();
    if (!j.success) throw new Error('elenco ' + prefix + ': ' + JSON.stringify(j.errors || j).slice(0, 160));
    const res = j.result || [];
    for (const o of (Array.isArray(res) ? res : (res.objects || []))) out.push(o.key);
    cursor = (Array.isArray(res) ? null : res.cursor) || null;
    if (!cursor) break;
  } while (true);
  return out;
}

async function scarica(key, dest) {
  const u = new URL(API + '/' + key.split('/').map(encodeURIComponent).join('/'));
  const r = await fetch(u, { headers: H });
  if (!r.ok) throw new Error('GET ' + key + ' -> ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

(async () => {
  const t0 = Date.now();
  const n = await scarica('dati/omi/omi-dataset.json', destDataset);
  if (n < 10_000_000) throw new Error('dataset troppo piccolo: ' + n + ' byte (atteso ~81 MB)');
  console.log('dataset OMI:', (n / 1048576).toFixed(1), 'MB ->', destDataset);

  const chiavi = (await elenca('dati/omi/agg/')).filter((k) => /\/\d{4}-\d\.json$/.test(k)).sort();
  if (chiavi.length < 40) throw new Error('cache semestrali insufficienti su R2: ' + chiavi.length);
  let tot = 0;
  for (const k of chiavi) tot += await scarica(k, path.join(destAgg, path.basename(k)));
  console.log('cache semestrali:', chiavi.length, 'file ·', (tot / 1048576).toFixed(1), 'MB ->', destAgg);
  console.log('omi-r2: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
})().catch((e) => { console.error('FAIL omi-r2:', e.message); process.exit(1); });
