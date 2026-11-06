// scripts/andamento-partecipazione.js — A · 6/11/2026
// ---------------------------------------------------------------------------
// Ricalcola DA ZERO l'archivio giornaliero della partecipazione.
//
// Perche' da zero: la versione precedente (sync-feed.js, righe 253-272) partiva dai giorni
// gia' presenti nel file e INCREMENTAVA, quindi a ogni run (~ogni 3-5 minuti) si riaggiungeva
// il catalogo intero a ogni giorno gia' presente. La somma dei `totale` era arrivata a
// ~177 milioni, cioe' ~542 volte i 324.119 lotti.
//
// Regola: un giorno si conta dai lotti che hanno quella data d'asta nel feed. Se un giorno
// non ha lotti nel feed, quel giorno NON c'e' — non si stima, non si eredita, non si
// "ricostruisce". Meglio un buco che un numero inventato.
'use strict';
const fs = require('fs');
const path = require('path');

const FORMATO_DATA = /^20\d\d-\d\d-\d\d$/;

function ricalcolaPartecipazione(FEED, indice, opts = {}) {
  const maxGiorni = opts.maxGiorni || 730;
  const oggi = opts.oggi || new Date().toISOString().slice(0, 10);
  const log = opts.log || (() => {});

  const files = [];
  for (const r of Object.keys((indice && indice.regioni) || {})) {
    const g = indice.regioni[r] || {};
    for (const f of [...(g.filesImm || []), ...(g.filesMob || [])]) files.push(f);
  }

  const perGiorno = new Map(); // NON si carica il file precedente: si parte da zero
  let letti = 0, senzaData = 0;

  for (const f of files) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(FEED, f), 'utf8')); } catch (e) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      letti++;
      const d = String(x.dataAsta || '').slice(0, 10);
      if (!FORMATO_DATA.test(d) || d < '2018-01-01' || d > '2035-12-31') { senzaData++; continue; }
      const e = String(x.esito || '').toUpperCase();
      let g = perGiorno.get(d);
      if (!g) { g = { data: d, aggiudicate: 0, deserte: 0, sospese: 0, totale: 0 }; perGiorno.set(d, g); }
      g.totale++;
      if (e === 'AGGIU') g.aggiudicate++;
      else if (e === 'ASDES') g.deserte++;
      else if (e === 'SOSPE') g.sospese++;
    }
  }

  const giorni = [...perGiorno.values()]
    .filter(g => g.data <= oggi)
    .sort((a, b) => (a.data < b.data ? -1 : 1))
    .slice(-maxGiorni);

  const sommaTotale = giorni.reduce((s, g) => s + g.totale, 0);
  const giornoOggi = giorni.find(g => g.data === oggi) || null;
  const out = path.join(FEED, 'andamento-partecipazione.json');
  fs.writeFileSync(out, JSON.stringify({
    generato: new Date().toISOString(),
    metodo: 'ricalcolo da zero dai lotti del feed, un giorno per dataAsta; nessuna stima',
    giorni,
  }));

  log(`partecipazione: ${giorni.length} giorni, somma totale ${sommaTotale} ` +
    `(lotti letti ${letti}, senza data valida ${senzaData})`);

  return { giorni: giorni.length, sommaTotale, letti, senzaData, giornoOggi };
}

module.exports = { ricalcolaPartecipazione };

if (require.main === module) {
  const FEED = process.argv[2] || path.join(__dirname, '..', 'feed');
  const indice = JSON.parse(fs.readFileSync(path.join(FEED, 'indice.json'), 'utf8'));
  console.log(JSON.stringify(ricalcolaPartecipazione(FEED, indice, { log: console.log })));
}
