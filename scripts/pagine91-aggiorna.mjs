// scripts/pagine91-aggiorna.mjs — 15/11/2026
// ---------------------------------------------------------------------------
// DIFETTO 4 del 15/11/2026: feed/pagine91.json non ha alcun campo data ed era fermo da
// 144,8 h (ultimo commit e1e20ed9 del 9/11 06:09Z). Il file contiene le traduzioni di
// /ilive e /stampa nelle 91 lingue: { <lang>: { ilive: {...}, stampa: {...} } }.
// NON esisteva un generatore nel repo (verificato: "pagine91" compare solo in
// scripts/feed-regole.js, che lo elenca fra i file PROTETTI, e in nessun workflow): il file
// era stato scritto una volta da un lavoro i18n del 8/11 (commit ec044417) e da allora
// nessun processo lo toccava — quindi non c'era nessun punto in cui aggiungere la data.
//
// COSA FA: è il generatore- custode del file. Non riscrive i contenuti (sono 91 lingue
// tradotte: non si rigenerano da un'euristica), ma a ogni giro VERIFICA la forma (lingue
// presenti, ilive+stampa per lingua), riscrive il file identico e ci mette il battito:
//   aggiornato    = quando ha girato questo controllo
//   ultimoCambio  = quando il contenuto è cambiato davvero
// Il campo vive dentro `_meta` (chiave nuova, non una lingua): l'edge legge
// jf[lang].ilive / jf[lang].stampa (careauctions/edge/worker.js:3138 e :3157), quindi
// un oggetto in più nel primo livello non cambia nulla per chi consuma il file.
// Si autolimita a un giro ogni 12 h (la data cambia, il contenuto no).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FEED = process.env.FEED_DIR || 'feed';
const FILE = path.join(FEED, 'pagine91.json');
const ORE = Number(process.env.PAGINE91_ORE || 12);
const FORZA = process.env.PAGINE91_FORZA === '1';
const CANARY = 'care-canary-d2c32afaa5d5';
const ORA = new Date().toISOString();

let dati;
try { dati = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.log('pagine91: file non leggibile — non tocco niente (' + String(e.message || e).slice(0, 60) + ')'); process.exit(0); }
if (!dati || typeof dati !== 'object' || Array.isArray(dati)) { console.log('pagine91: forma inattesa (non è un oggetto di lingue) — non tocco niente'); process.exit(0); }

const meta = dati._meta || {};
if (!FORZA) {
  const quando = Date.parse(meta.aggiornato || '');
  if (quando && (Date.now() - quando) < ORE * 3600 * 1000) { console.log('pagine91: aggiornato ' + meta.aggiornato + ' (<' + ORE + 'h) — salto'); process.exit(0); }
}

const lingue = Object.keys(dati).filter(k => k !== '_meta');
const conIlive = lingue.filter(k => dati[k] && dati[k].ilive).length;
const conStampa = lingue.filter(k => dati[k] && dati[k].stampa).length;
if (lingue.length < 80) { console.log('pagine91: solo ' + lingue.length + ' lingue — non scrivo (un file troncato sarebbe peggio di un file vecchio)'); process.exit(0); }

// ultimoCambio: si conserva, e avanza solo se i contenuti sono davvero diversi
const impronta = (o) => { const c = {}; for (const k of Object.keys(o)) if (k !== '_meta') c[k] = o[k]; return createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16); };
const prima = meta.impronta || null;
const ora = impronta(dati);   // hash del contenuto (non una copia: peserebbe il doppio del file)
const cambiato = !prima || prima !== ora;

const out = Object.assign({}, dati, {
  _meta: {
    titolo: 'Traduzioni di /ilive e /stampa nelle 91 lingue',
    aggiornato: ORA,
    ultimoCambio: cambiato ? ORA : (meta.ultimoCambio || meta.aggiornato || null),
    generatore: 'scripts/pagine91-aggiorna.mjs (dentro feed-sync)',
    cadenza: 'controllo ogni ' + ORE + ' h; il contenuto cambia solo con un lavoro i18n nuovo',
    lingue: lingue.length,
    lingueConIlive: conIlive,
    lingueConStampa: conStampa,
    nota: "Questo file non si rigenera da un'euristica: le 91 lingue sono tradotte una per una. Il generatore verifica la forma, conserva il contenuto e ci mette la data, così «nessun movimento» e «giro non passato» si distinguono. La data è dentro _meta e non tocca le chiavi delle lingue lette dall'edge (jf[lang].ilive / jf[lang].stampa).",
    impronta: ora,
    canary: CANARY,
    canaryNota: 'valore di riconoscimento della copia dei dati',
  },
});

// _meta resta in testa al file: si ricostruisce l'oggetto con _meta primo
const finale = { _meta: out._meta };
for (const k of lingue) finale[k] = out[k];
// 18/11/2026 — FORMA DEL MARCHIO SCRITTA ALLA FONTE (non rattoppata in lettura).
// «CARe Auctions» con lo spazio non deve finire nei feed: li leggono direttamente altre app,
// partner e crawler dati, che non passano dall'edge e quindi non vedono la correzione in uscita.
const normalizzaMarchio = (v) => {
  if (typeof v === 'string') return v.replace(/CARe\s+Auctions/g, 'CAReAuctions');
  if (Array.isArray(v)) return v.map(normalizzaMarchio);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = normalizzaMarchio(v[k]); return o; }
  return v;
};
fs.writeFileSync(FILE, JSON.stringify(normalizzaMarchio(finale)));
console.log('pagine91: ' + lingue.length + ' lingue (ilive ' + conIlive + ', stampa ' + conStampa + ') · aggiornato ' + ORA + ' · ' + (cambiato ? 'contenuto nuovo' : 'nessuna variazione di contenuto'));
