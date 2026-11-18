#!/usr/bin/env node
/**
 * tribunali-feed.mjs — rigenera `feed/tribunali.json` dai dati correnti.
 *
 * PERCHÉ ESISTE (18/11/2026): il file era stato scritto UNA VOLTA il 12/11 e nessun workflow lo
 * rigenerava. Il numero «148 tribunali con almeno un lotto aperto» era giusto quel giorno e basta:
 * un tribunale che apre il primo lotto non entrava, uno che li chiudeva tutti restava contato.
 *
 * FONTE: `feed/aste-indice/<shard>.json` (64 shard, l'indice compatto dei lotti: ha `tr` e `d` per
 * ogni lotto) + `feed/statistiche.json` per il catalogo. Zero dipendenze, si può lanciare ovunque.
 *
 * FORMA (compatibile con il file esistente): {aggiornato, fonte, copertura, tribunali:[{tribunale,
 * regione, lottiAperti, prezzoBaseMedio, aggiudicazioni, prezzoAggMedio}], nota}. I campi che non
 * hanno ancora una fonte in questo giro (regione, aggiudicazioni, prezzoAggMedio) si EREDITANO dal
 * file precedente dove il tribunale esiste: non si inventano numeri.
 *
 * GUARDIA ANTI-TRONCAMENTO: se i tribunali scendono sotto 100, o la somma dei lottiAperti scende
 * sotto l'80% del giro precedente, NON si scrive e si esce 1: un feed dimezzato è peggio di uno vecchio.
 */

import fs from 'node:fs';

const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/feed/';
const OUT = process.env.TRIBUNALI_OUT || 'feed/tribunali.json';
const SHARD = 64;
const MIN_TRIBUNALI = 100;
const FATTORE_GUARDIA = 0.8;

const oggi = new Date().toISOString().slice(0, 10);
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const precedente = (() => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; }
})();

const per = new Map(); // tribunale → {lottiAperti, totale, slug}
for (let n = 0; n < SHARD; n += 1) {
  const chiave = n.toString(16).padStart(2, '0');
  const r = await fetch(`${RAW}aste-indice/${chiave}.json?ts=${Date.now()}`);
  if (!r.ok) { console.error(`::error title=tribunali::shard ${chiave} non leggibile (HTTP ${r.status})`); process.exit(1); }
  const j = await r.json();
  for (const lotto of Object.values(j.lotti || {})) {
    const tr = String(lotto.tr || '').replace(/^Tribunale di\s+/i, '').trim();
    if (!tr) continue;
    const e = per.get(tr) || { lottiAperti: 0, totale: 0 };
    e.totale += 1;
    if (lotto.d && lotto.d >= oggi) e.lottiAperti += 1;
    per.set(tr, e);
  }
}

const vecchi = new Map(((precedente && precedente.tribunali) || []).map((x) => [x.tribunale, x]));
const tribunali = [...per.entries()]
  .map(([tribunale, e]) => {
    const v = vecchi.get(tribunale) || {};
    return {
      tribunale,
      regione: v.regione || null,
      lottiAperti: e.lottiAperti,
      prezzoBaseMedio: v.prezzoBaseMedio || null,
      aggiudicazioni: v.aggiudicazioni || null,
      prezzoAggMedio: v.prezzoAggMedio || null,
      slug: v.slug || slug(tribunale),
    };
  })
  .sort((a, b) => b.lottiAperti - a.lottiAperti || a.tribunale.localeCompare(b.tribunale));

const somma = tribunali.reduce((s, x) => s + x.lottiAperti, 0);
const attivi = tribunali.filter((x) => x.lottiAperti > 0).length;
const sommaPrima = precedente && Array.isArray(precedente.tribunali) ? precedente.tribunali.reduce((s, x) => s + (x.lottiAperti || 0), 0) : null;

console.log(`tribunali: ${tribunali.length} · con lotti aperti: ${attivi} · somma lottiAperti: ${somma}${sommaPrima ? ` (prima ${sommaPrima})` : ''}`);

// GUARDIA: un feed dimezzato è peggio di uno vecchio.
if (tribunali.length < MIN_TRIBUNALI) {
  console.error(`::error title=tribunali::solo ${tribunali.length} tribunali (minimo ${MIN_TRIBUNALI}) — non scrivo`);
  process.exit(1);
}
if (sommaPrima && somma < sommaPrima * FATTORE_GUARDIA) {
  console.error(`::error title=tribunali::lottiAperti ${somma} sotto l'${Math.round(FATTORE_GUARDIA * 100)}% di ${sommaPrima} — non scrivo`);
  process.exit(1);
}

const out = {
  aggiornato: new Date().toISOString(),
  fonte: 'feed/aste-indice/*.json (indice lotti) + feed/statistiche.json',
  copertura: `${tribunali.length} tribunali · ${attivi} con almeno un lotto aperto · ${somma} lotti aperti`,
  tribunali,
  nota: 'Rigenerato a ogni giro di feed-sync (18/11/2026). regione/aggiudicazioni/prezzoAggMedio restano dal file precedente finché non hanno una fonte in questo giro: non si inventano.',
};
fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`scritto ${OUT} · aggiornato ${out.aggiornato} · ${out.copertura}`);
console.log('::notice title=tribunali::feed rigenerato — ' + out.copertura);
