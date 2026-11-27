// verifica-pubblicazione.mjs — verifica automatica del sito pubblicato.
// Nasce il 21/11/2026 su richiesta di Gianluca: ogni volta che careauctions.co viene ripubblicato,
// questa automazione misura l'artefatto e apre un'issue se qualcosa non torna. Costo: zero.
// Regola: si misura il DOMINIO PUBBLICO, mai l'origine; e si giudica il file servito, mai il log.
import fs from 'node:fs';

const SITO = 'https://careauctions.co';
const ORIGINE = 'https://care-aste.emergent.host';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const controlli = [];
const add = (nome, ok, dettaglio) => controlli.push({ nome, ok, dettaglio: String(dettaglio).slice(0, 300) });

const get = async (url, ua = UA) => {
  const r = await fetch(url, { headers: { 'user-agent': ua }, cf: undefined }).catch(e => ({ ok: false, status: 0, headers: new Map(), text: async () => '' }));
  return { status: r.status, ct: (r.headers.get('content-type') || ''), body: await r.text() };
};
const testo = html => html
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();
const build = html => (html.match(/main\.[a-f0-9]+\.js/) || [])[0] || '';

// 1. BUILD: sito e origine devono servire lo stesso bundle
const rotte = ['/', '/ishop', '/ipartner', '/idati', '/fondatore'];
const builds = {};
for (const p of rotte) {
  const [s, o] = await Promise.all([get(SITO + p), get(ORIGINE + p)]);
  builds[p] = { sito: build(s.body), origine: build(o.body) };
}
const buildSito = builds['/'].sito;
const disallineate = Object.entries(builds).filter(([, v]) => v.sito !== v.origine);
add('build sito = origine', disallineate.length === 0,
  disallineate.length ? disallineate.map(([p, v]) => `${p}: sito ${v.sito || '-'} ≠ origine ${v.origine || '-'}`).join(' · ')
                      : `tutte su ${buildSito}`);

// 2. TESTI: le promesse false non devono tornare
// 27/11/2026 — «COMING SOON» sulle foto iShop in inglese è VOLUTO (ordine di Gianluca, giro G):
// il divieto di quella frase vale SOLO su /ipartner. Gli altri divieti restano su tutte le rotte.
const divieti = ['30%', '40%', 'prezzo riservato', 'reserved price'];
const divietiSoloPartner = ['coming soon'];
for (const p of ['/termini', '/note-legali', '/affiliazione', '/ishop', '/ipartner']) {
  const r = await get(SITO + p);
  const t = testo(r.body);
  const trovati = divieti.filter(d => t.toLowerCase().includes(d.toLowerCase()));
  const lista = p === '/ipartner' ? divieti.concat(divietiSoloPartner) : divieti;
  const trovatiP = lista.filter((d) => r.body.toLowerCase().includes(d));
  add(`testi ${p}`, r.status === 200 && trovatiP.length === 0, `http ${r.status}, vietati: ${trovatiP.join(', ') || 'nessuno'}`);
}
// /note-legali non deve servire i Termini
const nl = await get(SITO + '/note-legali');
add('/note-legali non è un doppione dei Termini', !/Termini e condizioni/.test((nl.body.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1]),
  `titolo: ${((nl.body.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, '?'])[1] || '?').trim().slice(0, 70)}`);

// 3. IMMAGINI iSHOP: congelate, byte identici al manifest
try {
  const feed = JSON.parse((await get(SITO + '/feed/ishop-categorie.json')).body);
  let ok = 0, tot = 0; const ko = [];
  for (const c of feed.categorie) {
    for (const [k, atteso] of [['foto', c.pesoCard], ['fotoHeader', c.pesoHeader]]) {
      if (!c[k]) continue;
      tot++;
      const r = await fetch(`${SITO}/img/ishop/${c[k]}`, { headers: { 'user-agent': UA } });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.status === 200 && (!atteso || buf.length === atteso)) ok++; else ko.push(`${c[k]} ${r.status}/${buf.length}`);
    }
  }
  add('immagini iShop identiche al manifest', ok === tot, `${ok}/${tot}${ko.length ? ' KO: ' + ko.slice(0, 3).join(', ') : ''}`);
} catch (e) { add('immagini iShop identiche al manifest', false, 'feed non leggibile: ' + e.message); }

// 4. ROTTE CHIAVE
const chiavi = ['/', '/ishop', '/ipartner', '/fondatore', '/idati', '/metodo', '/piani', '/feed/statistiche.json', '/favicon.svg', '/llms.txt'];
const koRotte = [];
for (const p of chiavi) { const r = await get(SITO + p); if (r.status !== 200) koRotte.push(`${p} ${r.status}`); }
add('rotte chiave 200', koRotte.length === 0, koRotte.join(', ') || `${chiavi.length}/${chiavi.length}`);

// 5. FEED FRESCO
try {
  const st = JSON.parse((await get(SITO + '/feed/statistiche.json')).body);
  const min = (Date.now() - new Date(st.aggiornato).getTime()) / 60000;
  add('feed statistiche fresco (< 90 min)', min < 90, `${min.toFixed(0)} min · ${st.totale} lotti · aggiornato ${st.aggiornato}`);
} catch (e) { add('feed statistiche fresco (< 90 min)', false, e.message); }

// 6. PRERENDER ALLINEATO (una pagina campione)
try {
  const pr = await get('https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/prerender/idati.html');
  const h = build(pr.body);
  add('prerender allineato alla build servita', h === buildSito, `${h || 'nessun bundle'} vs ${buildSito || '-'}`);
} catch (e) { add('prerender allineato alla build servita', false, e.message); }

const guasti = controlli.filter(c => !c.ok);
const esito = guasti.length === 0 ? 'VERDE' : (guasti.length <= 2 ? 'GIALLO' : 'ROSSO');
const out = { generato: new Date().toISOString(), esito, build: buildSito, controlli, guasti: guasti.map(g => g.nome) };
fs.mkdirSync('qa', { recursive: true });
fs.writeFileSync('qa/verifica-pubblicazione.json', JSON.stringify(out, null, 1));
console.log(`ESITO ${esito} · ${controlli.length - guasti.length}/${controlli.length} OK`);
for (const c of controlli) console.log(`  ${c.ok ? 'OK ' : 'KO '} ${c.nome}: ${c.dettaglio}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `esito=${esito}\nguasti=${guasti.map(g => g.nome).join(' | ')}\n`);
}
process.exit(esito === 'ROSSO' ? 1 : 0);
