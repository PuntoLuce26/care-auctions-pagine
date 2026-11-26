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

// FONTE ESATTA (18/11/2026): `residenziale-comune.json` = lotti IMMOBILIARI con asta non ancora
// svolta, per comune (è lo stesso perimetro del file originale: 16.853 lotti il 12/11) e
// `comune-tribunale.json` = mappa "Comune|Provincia" → [tribunali] (si prende il primo, come la
// tabella del 12/11: «comuni con più tribunali assegnati al primo della lista»).
const per = new Map();
{
  const [rc, ct] = await Promise.all([
    fetch(`${RAW}residenziale-comune.json?ts=${Date.now()}`),
    fetch(`${RAW}comune-tribunale.json?ts=${Date.now()}`),
  ]);
  if (!rc.ok || !ct.ok) {
    console.error(`::error title=tribunali::fonti non leggibili (residenziale-comune ${rc.status}, comune-tribunale ${ct.status})`);
    process.exit(1);
  }
  const comuni = (await rc.json()).comuni || [];
  const mappa = (await ct.json()).comuni || {};
  let senzaTribunale = 0;
  for (const c of comuni) {
    const chiave = `${c.comune}|${c.prov}`;
    const trib = (mappa[chiave] || [])[0];
    const aperti = Number(c.totImmobiliari || 0);
    if (!trib) { senzaTribunale += aperti; continue; }
    const e = per.get(trib) || { lottiAperti: 0 };
    e.lottiAperti += aperti;
    per.set(trib, e);
  }
  console.log(`comuni: ${comuni.length} · senza tribunale in mappa: ${senzaTribunale} lotti esclusi`);
}

// 19/11/2026 — l'eredità NON combaciava: il file vecchio scrive «Roma», la mappa dei comuni «ROMA».
// La chiave si normalizza (maiuscolo) e i campi si ereditano davvero. Se un campo era valorizzato e
// oggi non ha una fonte, la CHIAVE NON SI SCRIVE (meglio assente che null: un null dove prima c'era
// un valore è una regressione silenziosa per chi legge).
const norm = (s) => String(s || '').toUpperCase().trim();

// 26/11/2026 — la regione si EREDITAVA dal file precedente: se mancava una volta restava
// mancante per sempre (3 voci in «Altri tribunali»). Fallback esplicito per slug.
const REGIONE_FALLBACK = { 'napoli-nord-in-aversa': 'Campania', 'forli': 'Emilia-Romagna', 'corte-d-appello-bologna': 'Emilia-Romagna' };
const vecchi = new Map(((precedente && precedente.tribunali) || []).map((x) => [norm(x.tribunale), x]));
const tribunali = [...per.entries()]
  .map(([tribunale, e]) => {
    const v = vecchi.get(norm(tribunale)) || {};
    // SCHEMA 2 (deciso dal Lead, 18/11/2026): garantiti `tribunale` (MAIUSCOLO), `slug` (minuscolo),
    // `lottiAperti` (intero ≥ 0). `regione` è OPZIONALE: si omette se sconosciuta, mai null.
    // `totale`, `prezzoBaseMedio`, `aggiudicazioni`, `prezzoAggMedio` sono FUORI CONTRATTO: non si
    // scrivono finché non c'è un valore vero (e se torneranno, si riportano CON I VALORI e `schema` sale).
    const rec = { tribunale: norm(tribunale), slug: v.slug || slug(tribunale), lottiAperti: Number(e.lottiAperti) || 0 };
    if (v.regione) rec.regione = v.regione; else if (REGIONE_FALLBACK[slug(tribunale)]) rec.regione = REGIONE_FALLBACK[slug(tribunale)];
    return rec;
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
  schema: 2,
  aggiornato: new Date().toISOString(),
  copertura: `${tribunali.length} tribunali · ${attivi} con almeno un lotto aperto · ${somma} lotti aperti (lotti immobiliari con asta non ancora svolta)`,
  tribunali,
};
fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`scritto ${OUT} · aggiornato ${out.aggiornato} · ${out.copertura}`);
console.log('::notice title=tribunali::feed rigenerato — ' + out.copertura);
