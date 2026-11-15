#!/usr/bin/env node
/**
 * rapporto-trimestrale.mjs — CAReAuctions, Osservatorio Aste Immobiliari.
 *
 * Legge i feed pubblici veri (PVP, OMI, CAReIndex) e scrive due artefatti statici:
 *   rapporto/<trimestre>.html  — pagina senza JavaScript
 *   rapporto/<trimestre>.csv   — SOLO aggregati comunali (mai il singolo lotto)
 *
 * Node 22+, zero dipendenze. Uso:
 *   node scripts/rapporto-trimestrale.mjs
 *   node scripts/rapporto-trimestrale.mjs --autotest   # prova che il cancello fallisca (exit 1)
 *
 * IL CANCELLO (regola ferma del progetto):
 *   1. un fatto senza `fonte`, `rilevazione` o `copertura` non si pubblica: se anche un solo
 *      fatto è rifiutato, la pagina NON si scrive e il processo esce 1 elencando i rifiutati;
 *   2. il numero dichiarato deve comparire nella frase (niente testo e numero che si
 *      contraddicono);
 *   3. lo scarto prezzo base → offerta minima si chiama `scarto_base_minima`: se un fatto con
 *      quella metrica contiene la parola «sconto» viene rifiutato (è il pavimento legale del
 *      25%, non un ribasso di mercato);
 *   4. i fatti emessi devono essere fra 8 e 12: sotto 8 il rapporto non si pubblica.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TRIMESTRE = process.env.RAPPORTO_TRIMESTRE || "2026-Q4";
const BASE = process.env.RAPPORTO_BASE || "https://careauctions.co";
const RAW =
  process.env.RAPPORTO_RAW ||
  "https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main";
const OUT = process.env.RAPPORTO_OUT || "rapporto";

const SITO = "https://careauctions.co";
const PAGINA = `/rapporto/${TRIMESTRE}`;
const CSV = `/rapporto/${TRIMESTRE}.csv`;
const CITAZIONE = `CAReAuctions, Osservatorio Aste Immobiliari ${TRIMESTRE}, careauctions.co/rapporto/${TRIMESTRE}`;
const MIN_FATTI = 8;
const MAX_FATTI = 12;
const N_CITTA = 14;

// Nessuna licenza di riuso è stata decisa da Gianluca: si dichiara la citazione e si dice che
// oltre la citazione non si concede nulla. Non si inventano licenze.
const LICENZA =
  `Citazione consentita e richiesta: «${CITAZIONE}». Nessuna licenza di riuso automatico è concessa ` +
  "su questa pagina; i dati di base appartengono alle fonti (PVP — Ministero della Giustizia; OMI — " +
  "Agenzia delle Entrate, CC BY 4.0).";

// ---------------------------------------------------------------------------------------------
// Formattazione (niente toLocaleString: su questo Node non mette il separatore delle migliaia)
// ---------------------------------------------------------------------------------------------

const fmtInt = (n) => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const fmtDec = (n, d = 1) => Number(n).toFixed(d).replace(".", ",");
const fmtPct = (n, d = 1) => `${fmtDec(n, d)}%`;
const fmtEuro = (n) => `${fmtInt(n)} €`;

function fmtDataOra(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())} UTC`;
}

function fmtData(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const txt = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const senzaTag = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function percentile(valori, p) {
  const v = valori.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const pos = (v.length - 1) * p;
  const base = Math.floor(pos);
  const resto = pos - base;
  return v[base] + (v[Math.min(base + 1, v.length - 1)] - v[base]) * resto;
}

// Provincia → regione: tabella ISTAT (limiti openpolis/geojson-italy, CC BY 4.0), con gli alias
// che il PVP usa per Reggio, Aosta e la Sardegna. Serve solo ad aggregare i comuni per regione.
const REGIONE_PER_PROVINCIA = {
  "Agrigento":"Sicilia", "Alessandria":"Piemonte", "Ancona":"Marche", "Aosta":"Valle d'Aosta/Vallée d'Aoste",
  "Arezzo":"Toscana", "Ascoli Piceno":"Marche", "Asti":"Piemonte", "Avellino":"Campania", "Bari":"Puglia",
  "Barletta-Andria-Trani":"Puglia", "Belluno":"Veneto", "Benevento":"Campania", "Bergamo":"Lombardia",
  "Biella":"Piemonte", "Bologna":"Emilia-Romagna", "Bolzano/Bozen":"Trentino-Alto Adige/Südtirol",
  "Brescia":"Lombardia", "Brindisi":"Puglia", "Cagliari":"Sardegna", "Caltanissetta":"Sicilia",
  "Campobasso":"Molise", "Caserta":"Campania", "Catania":"Sicilia", "Catanzaro":"Calabria", "Chieti":"Abruzzo",
  "Como":"Lombardia", "Cosenza":"Calabria", "Cremona":"Lombardia", "Crotone":"Calabria", "Cuneo":"Piemonte",
  "Enna":"Sicilia", "Fermo":"Marche", "Ferrara":"Emilia-Romagna", "Firenze":"Toscana", "Foggia":"Puglia",
  "Forlì-Cesena":"Emilia-Romagna", "Frosinone":"Lazio", "Gallura Nord-Est Sardegna":"Sardegna",
  "Genova":"Liguria", "Gorizia":"Friuli-Venezia Giulia", "Grosseto":"Toscana", "Imperia":"Liguria",
  "Isernia":"Molise", "L'Aquila":"Abruzzo", "La Spezia":"Liguria", "Latina":"Lazio", "Lecce":"Puglia",
  "Lecco":"Lombardia", "Livorno":"Toscana", "Lodi":"Lombardia", "Lucca":"Toscana", "Macerata":"Marche",
  "Mantova":"Lombardia", "Massa-Carrara":"Toscana", "Matera":"Basilicata", "Medio Campidano":"Sardegna",
  "Messina":"Sicilia", "Milano":"Lombardia", "Modena":"Emilia-Romagna", "Monza e della Brianza":"Lombardia",
  "Napoli":"Campania", "Novara":"Piemonte", "Nuoro":"Sardegna", "Ogliastra":"Sardegna", "Oristano":"Sardegna",
  "Padova":"Veneto", "Palermo":"Sicilia", "Parma":"Emilia-Romagna", "Pavia":"Lombardia", "Perugia":"Umbria",
  "Pesaro e Urbino":"Marche", "Pescara":"Abruzzo", "Piacenza":"Emilia-Romagna", "Pisa":"Toscana",
  "Pistoia":"Toscana", "Pordenone":"Friuli-Venezia Giulia", "Potenza":"Basilicata", "Prato":"Toscana",
  "Ragusa":"Sicilia", "Ravenna":"Emilia-Romagna", "Reggio Calabria":"Calabria",
  "Reggio di Calabria":"Calabria", "Reggio Emilia":"Emilia-Romagna", "Reggio nell'Emilia":"Emilia-Romagna",
  "Rieti":"Lazio", "Rimini":"Emilia-Romagna", "Roma":"Lazio", "Rovigo":"Veneto", "Salerno":"Campania",
  "Sassari":"Sardegna", "Savona":"Liguria", "Siena":"Toscana", "Siracusa":"Sicilia", "Sondrio":"Lombardia",
  "Sud Sardegna":"Sardegna", "Sulcis Iglesiente":"Sardegna", "Taranto":"Puglia", "Teramo":"Abruzzo",
  "Terni":"Umbria", "Torino":"Piemonte", "Trapani":"Sicilia", "Trento":"Trentino-Alto Adige/Südtirol",
  "Treviso":"Veneto", "Trieste":"Friuli-Venezia Giulia", "Udine":"Friuli-Venezia Giulia",
  "Valle d'Aosta/Vallée d'Aoste":"Valle d'Aosta/Vallée d'Aoste", "Varese":"Lombardia", "Venezia":"Veneto",
  "Verbano-Cusio-Ossola":"Piemonte", "Vercelli":"Piemonte", "Verona":"Veneto", "Vibo Valentia":"Calabria",
  "Vicenza":"Veneto", "Viterbo":"Lazio",
};

const NOME_REGIONE = {
  "Valle d'Aosta/Vallée d'Aoste": "Valle d'Aosta",
  "Trentino-Alto Adige/Südtirol": "Trentino-Alto Adige",
};

const PARTICELLE = new Set(["di", "del", "della", "dei", "degli", "delle", "da", "dal", "in", "e", "la", "le", "il", "lo", "sul", "sull"]);

function titoloComune(nome) {
  return String(nome)
    .toLowerCase()
    .split(" ")
    .map((parola, i) => {
      if (i > 0 && PARTICELLE.has(parola)) return parola;
      return parola.replace(/(^|['’])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase());
    })
    .join(" ");
}

// ---------------------------------------------------------------------------------------------
// Caricamento feed
// ---------------------------------------------------------------------------------------------

const FEED = {
  "confronto-mercato": { cosa: "scarto prezzo base ÷ m² contro i valori OMI, comune per comune", fornitore: "PVP + OMI — Agenzia delle Entrate" },
  statistiche: { cosa: "catalogo, prezzo base medio, scarto base→minima, esiti", fornitore: "PVP — Portale delle Vendite Pubbliche" },
  "careindex-serie": { cosa: "serie del prezzo base al m² dei lotti residenziali", fornitore: "PVP — shard regionali dei lotti" },
  pagine91: { cosa: "traduzioni delle pagine dell'osservatorio", fornitore: "CAReAuctions (i18n)" },
  "omi-indice": { cosa: "valori di mercato OMI per comune, semestre per semestre", fornitore: "OMI — Agenzia delle Entrate" },
};

async function prendi(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(25000),
    headers: { "user-agent": "CAReAuctions-rapporto/1.0 (+https://careauctions.co)" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { testo: await r.text(), url, http: r.status };
}

async function caricaFeed(nome) {
  const tentativi = [`${BASE}/feed/${nome}.json`, `${RAW}/feed/${nome}.json`];
  const errori = [];
  for (const url of tentativi) {
    try {
      const { testo, http } = await prendi(url);
      return { nome, ok: true, data: JSON.parse(testo), url, http };
    } catch (e) {
      errori.push(`${url.replace(/\?.*$/, "").replace(/^https?:\/\//, "")} → ${e.message}`);
    }
  }
  return { nome, ok: false, errore: errori.join(" · ") };
}

// ---------------------------------------------------------------------------------------------
// Costruzione dei fatti
// ---------------------------------------------------------------------------------------------

function costruisciFatti(f) {
  const emessi = [];
  const nonEmessi = [];
  const emetti = (fatto) => emessi.push(fatto);
  const manca = (id, motivo) => nonEmessi.push({ id, motivo });

  const st = f.statistiche?.ok ? f.statistiche.data : null;
  const cm = f["confronto-mercato"]?.ok ? f["confronto-mercato"].data : null;
  const ci = f["careindex-serie"]?.ok ? f["careindex-serie"].data : null;
  const oi = f["omi-indice"]?.ok ? f["omi-indice"].data : null;

  const rilevSt = st && txt(st.rilevazione || st.aggiornato);
  const rilevCm = cm && (txt(cm.meta?.rilevazione) || txt(cm.rilevazione));
  const rilevCi = ci && txt(ci.meta?.generatoIl);
  const rilevOi = oi && txt(oi.meta?.generatoIl);
  const nat = cm?.nazionale;
  const cop = cm?.meta?.copertura;

  // 01 — catalogo
  const totale = st && num(st.totale);
  if (!st) manca("01-catalogo", "feed/statistiche.json non disponibile");
  else if (!totale || !rilevSt) manca("01-catalogo", "campo `totale` o `rilevazione` assente in feed/statistiche.json");
  else
    emetti({
      id: "01-catalogo",
      frase: `Il catalogo nazionale delle aste giudiziarie conta <strong>${fmtInt(totale)}</strong> lotti pubblicati.`,
      numero: totale,
      tipo: "int",
      fonte: "PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia)",
      rilevazione: rilevSt,
      copertura: "catalogo completo dei lotti pubblicati sul PVP, nessun filtro applicato",
      metrica: "lotti_pubblicati",
    });

  // 02 — passati / futuri
  const passate = st && num(st.perData?.passate);
  const future = st && num(st.perData?.future);
  if (!st) manca("02-calendario", "feed/statistiche.json non disponibile");
  else if (passate == null || future == null || !rilevSt)
    manca("02-calendario", "campi `perData.passate` / `perData.future` assenti in feed/statistiche.json");
  else
    emetti({
      id: "02-calendario",
      frase: `Di questi, <strong>${fmtInt(passate)}</strong> hanno già una data d'asta passata e ${fmtInt(future)} una data futura.`,
      numero: passate,
      tipo: "int",
      fonte: "PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia)",
      rilevazione: rilevSt,
      copertura: `lotti del catalogo con una data d'asta dichiarata (${fmtInt(st.perData?.totale ?? totale)} su ${fmtInt(totale)})`,
      metrica: "lotti_per_data",
    });

  // 03 — prossimi 30 giorni
  const p30 = st && num(st.perData?.prossimi30);
  if (!st) manca("03-prossimi-30", "feed/statistiche.json non disponibile");
  else if (p30 == null || !rilevSt) manca("03-prossimi-30", "campo `perData.prossimi30` assente in feed/statistiche.json");
  else
    emetti({
      id: "03-prossimi-30",
      frase: `Nei 30 giorni successivi alla rilevazione sono in calendario <strong>${fmtInt(p30)}</strong> aste.`,
      numero: p30,
      tipo: "int",
      fonte: "PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia)",
      rilevazione: rilevSt,
      copertura: `lotti con data d'asta nei 30 giorni successivi alla rilevazione, dentro il catalogo di ${fmtInt(totale)} lotti`,
      metrica: "lotti_prossimi_30_giorni",
    });

  // 04 — prezzo base medio
  const prezzo = st && num(st.prezzoMedioImm);
  if (!st) manca("04-prezzo-medio", "feed/statistiche.json non disponibile");
  else if (prezzo == null || !rilevSt) manca("04-prezzo-medio", "campo `prezzoMedioImm` assente in feed/statistiche.json");
  else
    emetti({
      id: "04-prezzo-medio",
      frase: `Il prezzo base d'asta medio dei lotti immobiliari è <strong>${fmtEuro(prezzo)}</strong>.`,
      numero: prezzo,
      tipo: "int",
      fonte: "PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia)",
      rilevazione: rilevSt,
      copertura: "lotti immobiliari del catalogo con prezzo base d'asta pubblicato; i lotti senza prezzo non entrano nella media",
      metrica: "prezzo_base_medio",
    });

  // 05 — scarto base → minima (metrica che non può chiamarsi «sconto»)
  const sbm = st && num(st.scartoBaseMinimaMedioImm);
  if (!st) manca("05-scarto-base-minima", "feed/statistiche.json non disponibile");
  else if (sbm == null || !rilevSt)
    manca("05-scarto-base-minima", "campo `scartoBaseMinimaMedioImm` assente in feed/statistiche.json");
  else
    emetti({
      id: "05-scarto-base-minima",
      frase: `Lo scarto tra prezzo base d'asta e offerta minima è in media del <strong>${fmtPct(sbm)}</strong>: è il pavimento legale (l'offerta minima è il 75% della base), non un ribasso di mercato.`,
      numero: sbm,
      tipo: "pct",
      fonte: "PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia)",
      rilevazione: rilevSt,
      copertura: "lotti immobiliari con offerta minima dichiarata; i fallimenti, dove minima e base coincidono, abbassano la media",
      metrica: "scarto_base_minima",
    });

  // 06 — scarto di mercato vs OMI (mediana)
  const med = nat && num(nat.scontoMedianoPct);
  if (!cm) manca("06-scarto-omi-mediana", "feed/confronto-mercato.json non disponibile");
  else if (med == null || !nat || !rilevCm || !cop)
    manca("06-scarto-omi-mediana", "campo `nazionale.scontoMedianoPct`, `meta.rilevazione` o `meta.copertura` assente");
  else
    emetti({
      id: "06-scarto-omi-mediana",
      frase: `Lo scarto di mercato — prezzo base al metro quadro rispetto ai valori OMI del comune — ha mediana <strong>${fmtPct(med)}</strong>: metà dei lotti confrontabili parte con uno scarto superiore a quel valore.`,
      numero: med,
      tipo: "pct",
      fonte: "PVP — Portale delle Vendite Pubbliche, confrontato con OMI — Agenzia delle Entrate",
      rilevazione: rilevCm,
      copertura: `${fmtInt(nat.lotti)} lotti residenziali con superficie in mq e valori OMI del comune, su ${fmtInt(cop.lottiResidenziali)} residenziali; ${fmtInt(cop.comuniPubblicati)} comuni con almeno 3 lotti confrontabili`,
      metrica: "scarto_vs_omi_mediana",
    });

  // 07 — quartili
  const p25 = nat && num(nat.scontoP25Pct);
  const p75 = nat && num(nat.scontoP75Pct);
  if (!cm) manca("07-scarto-omi-quartili", "feed/confronto-mercato.json non disponibile");
  else if (p25 == null || p75 == null || !nat || !rilevCm || !cop)
    manca("07-scarto-omi-quartili", "campi `nazionale.scontoP25Pct` / `scontoP75Pct` assenti");
  else
    emetti({
      id: "07-scarto-omi-quartili",
      frase: `La forbice è larga: un lotto su quattro ha uno scarto rispetto all'OMI superiore al <strong>${fmtPct(p75)}</strong>, mentre un altro lotto su quattro sta sotto il ${fmtPct(p25)}.`,
      numero: p25,
      tipo: "pct",
      fonte: "PVP — Portale delle Vendite Pubbliche, confrontato con OMI — Agenzia delle Entrate",
      rilevazione: rilevCm,
      copertura: `stessa base della mediana: ${fmtInt(nat.lotti)} lotti misurati su ${fmtInt(cop.lottiResidenziali)} residenziali in ${fmtInt(cop.comuniPubblicati)} comuni`,
      metrica: "scarto_vs_omi_quartili",
    });

  // 08 — scarto conservativo
  const cons = nat && num(nat.scontoConservativoPct);
  if (!cm) manca("08-scarto-conservativo", "feed/confronto-mercato.json non disponibile");
  else if (cons == null || !rilevCm || !cop)
    manca("08-scarto-conservativo", "campo `nazionale.scontoConservativoPct` assente");
  else
    emetti({
      id: "08-scarto-conservativo",
      frase: `Anche nel confronto più prudente — il valore OMI della zona più economica del comune — lo scarto mediano resta del <strong>${fmtPct(cons)}</strong>.`,
      numero: cons,
      tipo: "pct",
      fonte: "PVP — Portale delle Vendite Pubbliche, confrontato con OMI — Agenzia delle Entrate",
      rilevazione: rilevCm,
      copertura: `lotti confrontabili con almeno una zona OMI nel comune, misurati sul valore della zona più economica (${fmtInt(cop.comuniPubblicati)} comuni)`,
      metrica: "scarto_vs_omi_conservativo",
    });

  // 09 — copertura della misura
  const conMq = cop && num(cop.lottiConMq);
  const senzaMq = cop && num(cop.lottiSenzaMq);
  const resid = cop && num(cop.lottiResidenziali);
  if (!cm) manca("09-copertura-misura", "feed/confronto-mercato.json non disponibile");
  else if (conMq == null || senzaMq == null || resid == null || !rilevCm)
    manca("09-copertura-misura", "campi `meta.copertura.lottiConMq` / `lottiSenzaMq` / `lottiResidenziali` assenti");
  else
    emetti({
      id: "09-copertura-misura",
      frase: `La misura copre <strong>${fmtInt(conMq)}</strong> lotti con la superficie dichiarata sui ${fmtInt(resid)} residenziali (${fmtPct(Math.round((conMq / resid) * 100))}): ${fmtInt(senzaMq)} lotti non dichiarano i metri quadri e restano fuori.`,
      numero: conMq,
      tipo: "int",
      fonte: "PVP — Portale delle Vendite Pubbliche (dichiarazioni di superficie dei lotti)",
      rilevazione: rilevCm,
      copertura: `lotti residenziali del catalogo (${fmtInt(resid)}); ${fmtInt(cop.lottiEsclusiPerQuota)} lotti sono esclusi perché in quota, nuda proprietà o usufrutto`,
      metrica: "copertura_misura",
    });

  // 10 — esiti
  const es = st && st.esiti;
  const agg = es && num(es.aggiudicate);
  const des = es && num(es.deserte);
  const sos = es && num(es.sospese);
  if (!st) manca("10-esiti", "feed/statistiche.json non disponibile");
  else if (agg == null || des == null || sos == null || !rilevSt)
    manca("10-esiti", "campo `esiti.aggiudicate` / `esiti.deserte` / `esiti.sospese` assente");
  else {
    const conEsito = agg + des + sos;
    emetti({
      id: "10-esiti",
      frase: `Hanno un esito pubblico <strong>${fmtInt(conEsito)}</strong> lotti su ${fmtInt(totale)} (${fmtPct(((conEsito / totale) * 100).toFixed(1))}), di cui ${fmtInt(agg)} aggiudicati, ${fmtInt(des)} deserti e ${fmtInt(sos)} sospesi.`,
      numero: conEsito,
      tipo: "int",
      fonte: "PVP — Portale delle Vendite Pubbliche (esiti pubblicati)",
      rilevazione: rilevSt,
      copertura: `lotti del catalogo con esito pubblicato dalla fonte (${fmtInt(conEsito)} su ${fmtInt(totale)}); per gli altri l'esito non è pubblico`,
      metrica: "esiti_pubblici",
    });
  }

  // 11 — valore OMI mediano nazionale
  const natOmi = oi && Array.isArray(oi.nazionale) ? oi.nazionale[oi.nazionale.length - 1] : null;
  const medOmi = natOmi && num(natOmi.mediano);
  if (!oi) manca("11-omi-mediana", "feed/omi-indice.json non disponibile");
  else if (medOmi == null || !rilevOi) manca("11-omi-mediana", "campo `nazionale[].mediano` assente in feed/omi-indice.json");
  else
    emetti({
      id: "11-omi-mediana",
      frase: `Il valore di mercato OMI mediano nazionale è <strong>${fmtEuro(medOmi)}</strong> al metro quadro (semestre ${natOmi.semestre}).`,
      numero: medOmi,
      tipo: "int",
      fonte: "OMI — Agenzia delle Entrate (Osservatorio del Mercato Immobiliare)",
      rilevazione: rilevOi,
      copertura: `${fmtInt(natOmi.righe)} righe OMI del semestre ${natOmi.semestre}: mediana delle zone per comune, poi mediana dei comuni`,
      metrica: "omi_valore_mediano",
    });

  // 12 — copertura della serie CAReIndex
  const ciCop = ci?.meta?.copertura;
  const ciCon = ciCop && num(ciCop.lottiConSuperficie);
  const ciRes = ciCop && num(ciCop.lottiResidenziali);
  if (!ci) manca("12-careindex-copertura", "feed/careindex-serie.json non disponibile");
  else if (ciCon == null || ciRes == null || !rilevCi || !ci.meta?.finestra)
    manca("12-careindex-copertura", "campi `meta.copertura.lottiConSuperficie` / `finestra` assenti in feed/careindex-serie.json");
  else
    emetti({
      id: "12-careindex-copertura",
      frase: `La serie CAReIndex misura il prezzo base al metro quadro su <strong>${fmtInt(ciCon)}</strong> lotti in ${fmtInt(ciCop.giorniInSerie)} punti giornalieri: il ${fmtPct(ciCop.quotaPct)} dei ${fmtInt(ciRes)} lotti residenziali letti negli shard regionali.`,
      numero: ciCon,
      tipo: "int",
      fonte: "PVP — Portale delle Vendite Pubbliche (shard regionali dei lotti, superficie da perizie)",
      rilevazione: rilevCi,
      copertura: `finestra ${fmtData(ci.meta.finestra.dal)}–${fmtData(ci.meta.finestra.al)}, giorni con almeno ${ci.meta.finestra.minLottiPerGiorno ?? 5} lotti misurati; i lotti senza superficie non si stimano`,
      metrica: "careindex_copertura",
    });

  return { emessi, nonEmessi };
}

// ---------------------------------------------------------------------------------------------
// IL CANCELLO
// ---------------------------------------------------------------------------------------------

const VIETATI = [/n\/d\b/i, /\bTBD\b/i, /\bda definire\b/i, /\?\?\?/];

function validaFatti(fatti) {
  const rifiutati = [];
  const validi = [];
  const visti = new Set();

  for (const [i, f] of fatti.entries()) {
    const motivi = [];
    const id = txt(f?.id) || `fatto-${i + 1}`;

    if (visti.has(id)) motivi.push("id duplicato");
    visti.add(id);
    if (!txt(f?.frase)) motivi.push("frase mancante");

    if (!txt(f?.fonte)) motivi.push("fonte mancante");
    if (!txt(f?.rilevazione)) motivi.push("rilevazione mancante");
    else {
      const d = new Date(f.rilevazione);
      if (Number.isNaN(d.getTime())) motivi.push(`rilevazione non è una data: «${f.rilevazione}»`);
      else if (d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2100) motivi.push("rilevazione fuori intervallo");
    }
    if (!txt(f?.copertura)) motivi.push("copertura mancante");
    else if (txt(f.copertura).length < 12) motivi.push("copertura troppo vaga (meno di 12 caratteri)");

    const frase = senzaTag(f?.frase || "");

    // numero dichiarato == numero scritto
    if (f?.numero != null && Number.isFinite(Number(f.numero))) {
      const n = Number(f.numero);
      const atteso = f.tipo === "pct" ? `${fmtDec(n, 1)}%` : fmtInt(n);
      if (!frase.includes(atteso)) motivi.push(`il numero dichiarato (${atteso}) non compare nella frase`);
    }

    // il pavimento legale non si chiama «sconto»
    if (f?.metrica === "scarto_base_minima" && /sconto/i.test(frase))
      motivi.push("scarto base→minima chiamato «sconto»: vietato, è il pavimento legale del 25%");

    // un fatto che parla di OMI deve nominare l'OMI
    if (String(f?.metrica || "").includes("omi") && !/OMI/.test(frase))
      motivi.push("fatto OMI senza la sigla OMI nella frase");

    for (const re of VIETATI) if (re.test(frase)) motivi.push(`segnaposto vietato: ${re}`);

    if (motivi.length) rifiutati.push({ id, motivi });
    else validi.push(f);
  }

  return { validi, rifiutati };
}

function gate(fatti, nonEmessi) {
  const { validi, rifiutati } = validaFatti(fatti);

  if (rifiutati.length) {
    console.error(`CANCELLO: ${rifiutati.length} fatto/i rifiutato/i — nessun file scritto.`);
    for (const r of rifiutati) console.error(`  ✗ ${r.id}: ${r.motivi.join("; ")}`);
    return { ok: false, exit: 1, validi, rifiutati };
  }
  if (validi.length < MIN_FATTI || validi.length > MAX_FATTI) {
    console.error(
      `CANCELLO: ${validi.length} fatti emessi, il rapporto ne vuole fra ${MIN_FATTI} e ${MAX_FATTI} — nessun file scritto.`
    );
    for (const n of nonEmessi) console.error(`  · non emesso ${n.id}: ${n.motivo}`);
    return { ok: false, exit: 1, validi, rifiutati };
  }
  return { ok: true, exit: 0, validi, rifiutati };
}

// ---------------------------------------------------------------------------------------------
// Aggregati
// ---------------------------------------------------------------------------------------------

function regioniDaComuni(comuni) {
  const gruppi = new Map();
  let senzaRegione = 0;
  for (const c of comuni) {
    const regione = REGIONE_PER_PROVINCIA[c.provincia];
    if (!regione) {
      senzaRegione += 1;
      continue;
    }
    if (!gruppi.has(regione)) gruppi.set(regione, []);
    gruppi.get(regione).push(c);
  }
  const righe = [...gruppi.entries()]
    .map(([regione, lista]) => {
      const mediane = lista.map((x) => num(x.scontoMedianoPct)).filter((v) => v != null);
      return {
        regione: NOME_REGIONE[regione] || regione,
        comuni: lista.length,
        lotti: lista.reduce((s, x) => s + (num(x.lotti) || 0), 0),
        p25: percentile(mediane, 0.25),
        mediana: percentile(mediane, 0.5),
        p75: percentile(mediane, 0.75),
      };
    })
    .sort((a, b) => b.lotti - a.lotti);
  return { righe, senzaRegione };
}

function renderCsv(comuni) {
  const cella = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const uno = (v) => (num(v) == null ? "" : Number(v).toFixed(1));
  const righe = [
    ["comune", "provincia", "lotti_misurati", "prezzo_mq_medio_eur", "p25_scarto_omi", "mediana_scarto_omi", "p75_scarto_omi"],
  ];
  const ordinati = [...comuni].sort((a, b) => (num(b.lotti) || 0) - (num(a.lotti) || 0) || String(a.comune).localeCompare(String(b.comune), "it"));
  for (const c of ordinati) {
    righe.push([c.comune, c.provincia, num(c.lotti) ?? "", num(c.prezzoMqMedio) ?? "", uno(c.scontoP25Pct), uno(c.scontoMedianoPct), uno(c.scontoP75Pct)]);
  }
  return righe.map((r) => r.map(cella).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------

const CSS = `
:root{--blu:#0F1E3A;--oro:#D4A84B;--carta:#F4F1EA;--tenue:#5b6780;--filo:rgba(15,30,58,.14)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--carta);color:var(--blu);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;font-size:17px;line-height:1.6}
.wrap{max-width:760px;margin:0 auto;padding:44px 20px 60px}
a{color:var(--blu);text-decoration-color:var(--oro);text-underline-offset:3px}
header{padding-bottom:20px;border-bottom:3px solid var(--blu)}
.marchio{margin:0 0 16px;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#8a7550}
h1{margin:0 0 12px;font-size:33px;line-height:1.14;letter-spacing:-.02em;font-weight:600}
.sotto{margin:0 0 20px;font-size:18px;color:#3d4c66}
.dateline{margin:0;font-size:13.5px;color:var(--tenue)}
h2{margin:44px 0 6px;font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#8a7550;font-weight:600}
h2+.guida{margin-top:0}
h3{margin:22px 0 4px;font-size:16.5px;font-weight:600}
p{margin:12px 0}
.guida{color:var(--tenue);font-size:14.5px}
ol.fatti{list-style:none;counter-reset:f;margin:18px 0 0;padding:0}
ol.fatti li{counter-increment:f;position:relative;padding:14px 0 14px 44px;border-top:1px solid var(--filo)}
ol.fatti li:last-child{border-bottom:1px solid var(--filo)}
ol.fatti li:before{content:counter(f);position:absolute;left:0;top:14px;width:26px;height:26px;border-radius:50%;background:var(--oro);color:#1a1204;font:600 13px/26px sans-serif;text-align:center}
ol.fatti strong{font-weight:600;color:var(--blu)}
.dett{color:var(--tenue);font-size:14.5px}
.dett b{font-weight:600;color:#3d4c66}
table.dati{width:100%;border-collapse:collapse;margin:12px 0 6px;font-size:13.5px}
table.dati caption{caption-side:top;text-align:left;color:var(--tenue);font-size:13px;padding:0 0 8px}
table.dati th{text-align:left;font-weight:600;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:#3d4c66;border-bottom:2px solid var(--blu);padding:7px 6px;vertical-align:bottom}
table.dati td{padding:6px;border-bottom:1px solid var(--filo);vertical-align:top}
table.dati .n{text-align:right;font-variant-numeric:tabular-nums}
table.dati tbody tr:nth-child(even){background:rgba(212,168,75,.07)}
table.dati tfoot td{border-top:2px solid var(--blu);border-bottom:0;font-weight:600;padding-top:8px}
.citare{margin:18px 0;padding:16px 18px;border-left:4px solid var(--oro);background:#fff;font-size:15.5px}
.citare span{display:block;color:var(--tenue);font-size:12px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px}
ol.stampa{margin:14px 0 0;padding-left:22px}
ol.stampa li{margin:0 0 14px}
.non-emessi{margin-top:14px;padding:14px 16px;border:1px solid var(--filo);background:#fff;font-size:14px}
footer{margin-top:52px;padding-top:20px;border-top:1px solid var(--filo);color:var(--tenue);font-size:13px}
footer p{margin:6px 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:rgba(15,30,58,.06);padding:2px 5px;border-radius:3px}
@media (max-width:600px){body{font-size:16px}.wrap{padding:28px 14px 44px}h1{font-size:26px}.sotto{font-size:16px}table.dati{font-size:12.5px}table.dati th,table.dati td{padding:5px 4px}}
@media print{body{background:#fff}.wrap{max-width:none;padding:0}table.dati tbody tr:nth-child(even){background:transparent}}
`;

function renderHtml(ctx) {
  const { fatti, nonEmessi, fonti, comuni, regione, nazionale, datePublished, dateModified, jsonld } = ctx;
  const dtPubblicato = fmtData(datePublished);
  const dtAggiornato = fmtDataOra(dateModified);
  const righeFonti = fonti
    .map((f) => {
      const stato = f.ok ? "200 OK" : "non disponibile";
      const quando = f.rilevazione ? fmtDataOra(f.rilevazione) : "—";
      return `<tr><td><code>${f.nome}</code></td><td>${f.cosa}</td><td>${f.fornitore}</td><td class="n">${stato}</td><td class="n">${quando || "—"}</td></tr>`;
    })
    .join("\n");

  const righeCitta = comuni
    .map(
      (c) =>
        `<tr><td>${titoloComune(c.comune)}</td><td>${c.provincia}</td><td class="n">${fmtInt(c.lotti)}</td><td class="n">${fmtInt(c.prezzoMqMedio)}</td><td class="n">${fmtDec(c.scontoP25Pct)}</td><td class="n">${fmtDec(c.scontoMedianoPct)}</td><td class="n">${fmtDec(c.scontoP75Pct)}</td></tr>`
    )
    .join("\n");

  const q = (v) => (v == null ? "—" : fmtDec(v));
  const righeRegioni = regione.righe
    .map(
      (r) =>
        `<tr><td>${r.regione}</td><td class="n">${fmtInt(r.comuni)}</td><td class="n">${fmtInt(r.lotti)}</td><td class="n">${q(r.p25)}</td><td class="n">${q(r.mediana)}</td><td class="n">${q(r.p75)}</td></tr>`
    )
    .join("\n");

  const bloccoNonEmessi = nonEmessi.length
    ? `<div class="non-emessi"><strong>Fatti non emessi in questo giro.</strong> Una fonte muta o un campo assente impedisce di pubblicare il fatto: si dichiara, non si stima.<ul>${nonEmessi
        .map((n) => `<li><code>${n.id}</code> — ${n.motivo}</li>`)
        .join("")}</ul></div>`
    : "";

  const stampa = [
    `Il mercato delle aste non ha un prezzo solo. Nel 25% dei casi il prezzo base al metro quadro sta oltre il ${fmtPct(
      nazionale.scontoP75Pct
    )} sotto il valore OMI del comune; in un altro 25% dei casi lo scarto resta sotto il ${fmtPct(
      nazionale.scontoP25Pct
    )}. La mediana nazionale è ${fmtPct(nazionale.scontoMedianoPct)} su ${fmtInt(
      nazionale.lotti
    )} lotti misurati in ${fmtInt(ctx.comuniMisurati)} comuni.`,
    `Il «ribasso del 25%» che circola nelle guide alle aste non è un ribasso di mercato: è il pavimento legale tra prezzo base e offerta minima (l'offerta minima è il 75% della base). Lo scarto vero si misura solo contro i valori OMI, ed è quello che questa pagina pubblica: ${fmtPct(
      nazionale.scontoMedianoPct
    )} di mediana, ${fmtPct(nazionale.scontoConservativoPct)} nel confronto più prudente con la zona più economica.`,
    `Su ${fmtInt(ctx.catalogo)} lotti pubblicati, solo ${fmtInt(
      ctx.esiti.conEsito
    )} (${fmtPct(((ctx.esiti.conEsito / ctx.catalogo) * 100).toFixed(1))}) hanno un esito pubblico e ${fmtInt(
      ctx.esiti.aggiudicate
    )} risultano aggiudicati: chi ha comprato, e a quanto, in Italia non è un dato pubblico per la gran parte del mercato.`,
  ];

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Osservatorio Aste Immobiliari ${TRIMESTRE} — CAReAuctions</title>
<meta name="description" content="Quanto parte sotto il valore di mercato un immobile all'asta in Italia: prezzo base al m² contro i valori OMI, ${fmtInt(nazionale.lotti)} lotti misurati in ${fmtInt(ctx.comuniMisurati)} comuni. Fonte, rilevazione e copertura accanto a ogni numero.">
<link rel="canonical" href="${SITO}${PAGINA}">
<meta property="article:published_time" content="${datePublished}">
<meta property="article:modified_time" content="${dateModified}">
<meta name="robots" content="index,follow">
<style>${CSS}</style>
<script type="application/ld+json">
${JSON.stringify(jsonld, null, 1)}
</script>
</head>
<body>
<div class="wrap">
<header>
  <p class="marchio">CAReAuctions · Osservatorio Aste Immobiliari</p>
  <h1>Aste immobiliari ${TRIMESTRE}: quanto parte sotto il valore di mercato</h1>
  <p class="sotto">Prezzo base d'asta al metro quadro confrontato con i valori OMI, comune per comune. ${fmtInt(nazionale.lotti)} lotti misurati su ${fmtInt(ctx.coperturaResidenziali)} residenziali, in ${fmtInt(ctx.comuniMisurati)} comuni.</p>
  <p class="dateline">Pubblicato: ${dtPubblicato} · Ultimo aggiornamento: ${dtAggiornato} · Indirizzo stabile: <a href="${SITO}${PAGINA}">careauctions.co${PAGINA}</a> · Dati: <a href="${TRIMESTRE}.csv">${TRIMESTRE}.csv</a></p>
</header>

<section id="fatti">
<h2>I fatti, con la fonte accanto</h2>
<p class="guida">Ogni fatto porta fonte, rilevazione e copertura nella stessa frase. Se a un fatto manca uno dei tre, questa pagina non viene scritta: il generatore esce in errore.</p>
<ol class="fatti">
${fatti
  .map(
    (f) =>
      `<li><p>${f.frase} <span class="dett">Fonte: ${f.fonte}. Rilevazione: ${fmtDataOra(f.rilevazione)}. Copertura: ${f.copertura}.</span></p></li>`
  )
  .join("\n")}
</ol>
${bloccoNonEmessi}
</section>

<section id="metodo">
<h2>Il metodo, in chiaro</h2>
<p>Per ogni lotto residenziale a piena proprietà con la superficie in metri quadri dichiarata, il prezzo al metro quadro è il <strong>prezzo base d'asta diviso i m²</strong>. Quel prezzo viene confrontato con il valore OMI residenziale del comune (mediana delle zone): lo scarto è <code>1 − (prezzo base ÷ m²) ÷ valore OMI</code>. La mediana, il P25 e il P75 sono calcolati sulla distribuzione dei singoli lotti, non sulle medie dei comuni. Il confronto conservativo usa invece la zona OMI più economica del comune, cioè il confronto più prudente possibile.</p>
<h3>Perché si usa il prezzo base e non l'offerta minima</h3>
<p>In un'asta giudiziaria l'offerta minima è il 75% del prezzo base: il 25% di differenza è il pavimento legale, non un ribasso di mercato. Usare la minima gonfierebbe ogni scarto di 25 punti e renderebbe la metrica falsa. Per questo il dato si chiama <code>scarto_base_minima</code> e non «sconto», ed è pubblicato separatamente dal confronto con l'OMI.</p>
<h3>Quali lotti restano fuori, e perché</h3>
<ul>
<li><strong>${fmtInt(ctx.copertura.senzaMq)}</strong> lotti non dichiarano la superficie: senza m² il prezzo al metro quadro non esiste e non si stima.</li>
<li><strong>${fmtInt(ctx.copertura.quota)}</strong> lotti sono in quota, nuda proprietà o usufrutto: il prezzo è di una parte, la superficie del tutto, e il rapporto sarebbe falso.</li>
<li><strong>${fmtInt(ctx.copertura.comuniSenzaOmi)}</strong> comuni non hanno un valore OMI utilizzabile: senza termine di confronto il lotto non entra.</li>
<li><strong>${fmtInt(ctx.copertura.fuoriScala)}</strong> lotti hanno un valore fuori scala (prezzo al m² implausibile) e vengono scartati.</li>
<li>Entrano solo i comuni con almeno 3 lotti confrontabili: sotto quella soglia un numero comunale sarebbe casuale.</li>
</ul>
<p>I valori OMI non vengono pubblicati: la pagina riporta solo la nostra metrica e il prezzo base al metro quadro delle aste. I dati dei singoli lotti non escono: il CSV contiene solo aggregati comunali.</p>
</section>

<section id="citta">
<h2>Per città</h2>
<table class="dati">
  <caption>Le ${N_CITTA} città con più lotti misurati. Valori in percentuale: scarto del prezzo base al m² rispetto al valore OMI del comune; P25 e P75 sono il primo e il terzo quartile della distribuzione dei lotti.</caption>
  <thead><tr><th scope="col">Città</th><th scope="col">Prov.</th><th scope="col" class="n">Lotti misurati</th><th scope="col" class="n">Prezzo base €/m²</th><th scope="col" class="n">P25 %</th><th scope="col" class="n">Mediana %</th><th scope="col" class="n">P75 %</th></tr></thead>
  <tbody>
${righeCitta}
  </tbody>
</table>
<p class="guida">Il prezzo base €/m² è la media dei prezzi base dichiarati diviso i m²: non è un prezzo di mercato e non è un prezzo di aggiudicazione.</p>
</section>

<section id="regioni">
<h2>Per regione</h2>
<table class="dati">
  <caption>Le ${regione.righe.length} regioni, ordinate per lotti misurati. I quartili sono calcolati sulle mediane comunali (ogni comune pesa uguale), non sui singoli lotti: è una sintesi regionale, non una misura di lotto.</caption>
  <thead><tr><th scope="col">Regione</th><th scope="col" class="n">Comuni</th><th scope="col" class="n">Lotti misurati</th><th scope="col" class="n">P25 %</th><th scope="col" class="n">Mediana %</th><th scope="col" class="n">P75 %</th></tr></thead>
  <tbody>
${righeRegioni}
  </tbody>
  <tfoot><tr><td>Italia (nazionale)</td><td class="n">${fmtInt(ctx.comuniMisurati)}</td><td class="n">${fmtInt(nazionale.lotti)}</td><td class="n">${fmtDec(nazionale.scontoP25Pct)}</td><td class="n">${fmtDec(nazionale.scontoMedianoPct)}</td><td class="n">${fmtDec(nazionale.scontoP75Pct)}</td></tr></tfoot>
</table>
<p class="guida">La riga Italia è la distribuzione dei singoli lotti (${fmtInt(nazionale.lotti)} misurati, ${fmtInt(ctx.sommaLotti)} lotti aggregati nei ${fmtInt(ctx.comuniTotali)} comuni del CSV): le righe regionali sono mediane di mediane comunali, quindi non sono confrontabili una a una con la riga Italia.</p>
</section>

<section id="fonti">
<h2>Le fonti, una per una</h2>
<table class="dati">
  <caption>Stato delle fonti al momento della generazione. Una fonte che non risponde non produce fatti: il fatto viene dichiarato non emesso.</caption>
  <thead><tr><th scope="col">Feed</th><th scope="col">Cosa fornisce</th><th scope="col">Fornitore</th><th scope="col" class="n">Esito</th><th scope="col" class="n">Rilevazione</th></tr></thead>
  <tbody>
${righeFonti}
  </tbody>
</table>
</section>

<section id="dati">
<h2>I dati</h2>
<p>Aggregati per comune — ${fmtInt(ctx.comuniTotali)} righe più intestazione, nessun dato del singolo lotto: <a href="${TRIMESTRE}.csv"><code>${TRIMESTRE}.csv</code></a> (anche su <a href="${SITO}${CSV}">careauctions.co${CSV}</a>). Colonne: comune, provincia, lotti misurati, prezzo base medio €/m², P25, mediana e P75 dello scarto rispetto all'OMI.</p>
<p class="citare"><span>Come citare</span>${CITAZIONE}</p>
<p class="guida">Rigenerabile con <code>node scripts/rapporto-trimestrale.mjs</code> nel repository <code>PuntoLuce26/care-auctions-pagine</code>: lo script legge i feed pubblici e riscrive pagina e CSV.</p>
</section>

<section id="stampa">
<h2>Tre punti pronti per la stampa</h2>
<ol class="stampa">
${stampa.map((s) => `<li>${s}</li>`).join("\n")}
</ol>
</section>

<footer>
<p><strong>Fonti di base.</strong> PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia) per lotti, prezzi base, offerte minime ed esiti; OMI — Agenzia delle Entrate per i valori di mercato (CC BY 4.0); CAReIndex per la serie del prezzo base al m². I valori OMI non sono pubblicati: è pubblicata solo la nostra metrica.</p>
<p><strong>Licenza dichiarata.</strong> ${LICENZA}</p>
<p>Osservatorio Aste Immobiliari ${TRIMESTRE} · Pubblicato ${dtPubblicato} · Aggiornato ${dtAggiornato} · CAReAuctions, careauctions.co</p>
</footer>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// Autotest: il cancello DEVE fallire
// ---------------------------------------------------------------------------------------------

async function autotest() {
  const dir = path.join(os.tmpdir(), `rapporto-autotest-${Date.now()}`);
  const base = {
    fonte: "PVP — Portale delle Vendite Pubbliche",
    rilevazione: "2026-11-15T07:12:36Z",
    copertura: "catalogo completo dei lotti pubblicati sul PVP, nessun filtro",
    tipo: "int",
  };
  const fatti = [
    { ...base, id: "prova-ok", frase: "Il catalogo conta <strong>1.000</strong> lotti.", numero: 1000, metrica: "lotti_pubblicati" },
    { ...base, id: "prova-senza-fonte", frase: "Il catalogo conta <strong>2.000</strong> lotti.", numero: 2000, fonte: "", metrica: "lotti_pubblicati" },
    { ...base, id: "prova-sconto-vietato", frase: "Lo sconto medio è del <strong>25,0%</strong>.", numero: 25.0, tipo: "pct", metrica: "scarto_base_minima" },
    { ...base, id: "prova-senza-copertura", frase: "Il catalogo conta <strong>3.000</strong> lotti.", numero: 3000, copertura: "", metrica: "lotti_pubblicati" },
  ];

  const esito = gate(fatti, []);
  let fileScritti = 0;
  if (esito.ok) {
    // Se il cancello NON rifiuta, simuliamo la scrittura per dimostrare che non è successo nulla.
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${TRIMESTRE}.html`), "x");
    fileScritti = 1;
  }
  const filePresenti = existsSync(path.join(dir, `${TRIMESTRE}.html`)) || existsSync(path.join(dir, `${TRIMESTRE}.csv`));
  if (fileScritti) await rmDir(dir);

  if (esito.ok) {
    console.error("AUTOTEST FALLITO: il cancello ha accettato fatti incompleti.");
    return 2;
  }
  if (filePresenti) {
    console.error("AUTOTEST FALLITO: il cancello ha rifiutato ma dei file sono stati scritti.");
    return 2;
  }
  console.log(`AUTOTEST: il cancello ha rifiutato ${esito.rifiutati.length} fatti e non ha scritto nessun file.`);
  for (const r of esito.rifiutati) console.log(`  ✗ ${r.id}: ${r.motivi.join("; ")}`);
  console.log(`AUTOTEST OK — exit 1 voluto (codice di uscita del cancello).`);
  return 1;
}

async function rmDir(dir) {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main() {
  if (process.argv.includes("--autotest")) {
    const codice = await autotest();
    process.exit(codice);
  }

  const feed = {};
  for (const nome of Object.keys(FEED)) feed[nome] = await caricaFeed(nome);
  const falliti = Object.values(feed).filter((f) => !f.ok);
  for (const f of falliti) console.warn(`FONTE MUTA: ${f.nome} — ${f.errore}`);

  const { emessi, nonEmessi } = costruisciFatti(feed);

  const esito = gate(emessi, nonEmessi);
  if (!esito.ok) {
    for (const n of nonEmessi) console.error(`  · non emesso ${n.id}: ${n.motivo}`);
    process.exit(esito.exit);
  }
  const fatti = esito.validi;

  const cm = feed["confronto-mercato"].ok ? feed["confronto-mercato"].data : null;
  const comuni = cm && Array.isArray(cm.comuni) ? cm.comuni : [];
  if (comuni.length < 12) {
    console.error(`CANCELLO: ${comuni.length} comuni aggregati, ne servono almeno 12 per la tabella — nessun file scritto.`);
    process.exit(1);
  }

  const regioni = regioniDaComuni(comuni);
  if (regioni.senzaRegione > 0) {
    console.error(`CANCELLO: ${regioni.senzaRegione} comuni senza regione nella tabella ISTAT — nessun file scritto.`);
    process.exit(1);
  }

  const comuniCitta = [...comuni]
    .sort((a, b) => (num(b.lotti) || 0) - (num(a.lotti) || 0) || String(a.comune).localeCompare(String(b.comune), "it"))
    .slice(0, N_CITTA);

  const now = new Date();
  const dateModified = now.toISOString();
  const percorsoHtml = path.join(OUT, `${TRIMESTRE}.html`);
  let datePublished = dateModified;
  if (existsSync(percorsoHtml)) {
    try {
      const precedente = await readFile(percorsoHtml, "utf8");
      const m = precedente.match(/"datePublished":\s*"([^"]+)"/);
      if (m && !Number.isNaN(new Date(m[1]).getTime())) datePublished = m[1];
    } catch {
      /* la pagina precedente non è leggibile: si pubblica con la data di oggi */
    }
  }

  // stato delle fonti per la tabella in pagina
  const fonti = Object.keys(FEED).map((nome) => {
    const f = feed[nome];
    let rilevazione = null;
    if (f.ok) {
      const d = f.data;
      rilevazione =
        txt(d.rilevazione) || txt(d.meta?.rilevazione) || txt(d.meta?.generatoIl) || txt(d._meta?.aggiornato) || txt(d.aggiornato) || null;
    }
    return { nome: `feed/${nome}.json`, cosa: FEED[nome].cosa, fornitore: FEED[nome].fornitore, ok: f.ok, rilevazione };
  });

  const cop = cm.meta?.copertura || {};
  const comuniMisurati = num(cop.comuniPubblicati) ?? comuni.length;
  const sommaLotti = comuni.reduce((s, c) => s + (num(c.lotti) || 0), 0);
  const st = feed.statistiche.ok ? feed.statistiche.data : {};
  const esiti = {
    conEsito:
      (num(st.esiti?.aggiudicate) || 0) + (num(st.esiti?.deserte) || 0) + (num(st.esiti?.sospese) || 0),
    aggiudicate: num(st.esiti?.aggiudicate) || 0,
  };
  const catalogo = num(st.totale) || 0;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `Osservatorio Aste Immobiliari ${TRIMESTRE} — CAReAuctions`,
    description:
      `Prezzo base d'asta al metro quadro dei lotti immobiliari italiani confrontato con i valori OMI del comune. ` +
      `${fmtInt(cm.nazionale.lotti)} lotti misurati in ${fmtInt(comuniMisurati)} comuni, ` +
      `mediana dello scarto ${fmtDec(cm.nazionale.scontoMedianoPct)}% (P25 ${fmtDec(cm.nazionale.scontoP25Pct)}%, ` +
      `P75 ${fmtDec(cm.nazionale.scontoP75Pct)}%). Solo aggregati comunali, nessun dato del singolo lotto.`,
    creator: { "@type": "Organization", name: "CAReAuctions", url: SITO },
    publisher: { "@type": "Organization", name: "CAReAuctions", url: SITO },
    datePublished,
    dateModified,
    license: LICENZA,
    spatialCoverage: "IT",
    url: `${SITO}${PAGINA}`,
    isAccessibleForFree: true,
    citation: CITAZIONE,
    variableMeasured: [
      { "@type": "PropertyValue", name: "lotti pubblicati", unitText: "lotti" },
      { "@type": "PropertyValue", name: "prezzo base d'asta medio", unitText: "EUR" },
      { "@type": "PropertyValue", name: "scarto_base_minima (pavimento legale, non sconto di mercato)", unitText: "percentuale" },
      { "@type": "PropertyValue", name: "scarto prezzo base ÷ m² rispetto ai valori OMI — mediana", unitText: "percentuale" },
      { "@type": "PropertyValue", name: "scarto prezzo base ÷ m² rispetto ai valori OMI — P25", unitText: "percentuale" },
      { "@type": "PropertyValue", name: "scarto prezzo base ÷ m² rispetto ai valori OMI — P75", unitText: "percentuale" },
      { "@type": "PropertyValue", name: "prezzo base al metro quadro per comune", unitText: "EUR/m²" },
      { "@type": "PropertyValue", name: "lotti misurati per comune", unitText: "lotti" },
    ],
    distribution: [
      { "@type": "DataDownload", name: `Aggregati per comune (CSV) ${TRIMESTRE}`, contentUrl: `${SITO}${CSV}`, encodingFormat: "text/csv" },
      { "@type": "DataDownload", name: `Rapporto ${TRIMESTRE} (HTML)`, contentUrl: `${SITO}${PAGINA}`, encodingFormat: "text/html" },
    ],
  };

  const html = renderHtml({
    fatti,
    nonEmessi,
    fonti,
    comuni: comuniCitta,
    regione: regioni,
    nazionale: cm.nazionale,
    copertura: {
      senzaMq: num(cop.lottiSenzaMq) ?? 0,
      quota: num(cop.lottiEsclusiPerQuota) ?? 0,
      comuniSenzaOmi: num(cop.comuniSenzaOmi) ?? 0,
      fuoriScala: num(cop.fuoriScala) ?? 0,
    },
    coperturaResidenziali: num(cop.lottiResidenziali) ?? 0,
    comuniMisurati,
    comuniTotali: comuni.length,
    sommaLotti,
    catalogo,
    esiti,
    datePublished,
    dateModified,
    jsonld,
  });
  const csv = renderCsv(comuni);

  await mkdir(OUT, { recursive: true });
  await writeFile(percorsoHtml, html, "utf8");
  await writeFile(path.join(OUT, `${TRIMESTRE}.csv`), csv, "utf8");

  console.log(`OK — ${fatti.length} fatti emessi, ${nonEmessi.length} non emessi, ${esito.rifiutati.length} rifiutati.`);
  for (const f of fatti) console.log(`  ${f.id.padEnd(26)} ${fmtDataOra(f.rilevazione)}  ${f.fonte}`);
  for (const n of nonEmessi) console.log(`  non emesso ${n.id}: ${n.motivo}`);
  console.log(`PAGINA ${percorsoHtml} — ${html.length} byte, ${senzaTag(html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "")).length} caratteri visibili`);
  console.log(`CSV    ${path.join(OUT, `${TRIMESTRE}.csv`)} — ${csv.trim().split("\n").length} righe (intestazione inclusa)`);
  console.log(`CITAZIONE ${CITAZIONE}`);
}

await main();
