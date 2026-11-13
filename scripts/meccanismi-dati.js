#!/usr/bin/env node
// meccanismi-dati.js — i dati che rendono CITABILE un numero dei colossi.
//
// Genera, dai feed che già possediamo, gli artefatti che mancavano (green/STUDIO.md, 13/11/2026):
//   1. feed/sconto-reale-certificato.json + .csv  → lo Sconto Reale Certificato con nome, copertura,
//      fonte e rilevazione dentro il file (meccanismo Zillow: «il numero con un nome proprio»).
//   2. feed/andamento-esiti.csv                   → la serie storica scaricabile (Redfin: il CSV in mano).
//   3. feed/esiti-statistiche.csv                 → gli esiti con la copertura dichiarata.
//   4. feed/serie.csv                             → la stessa storia in formato lungo (serie,misura,data,valore).
//   5. feed/tipi-asta.json                        → il tipo d'asta come dimensione di URL (Idealista):
//      tipo di lotto (PVP), categoria del bene (PVP), filone fallimentare (FallcoAste + aste-aziende).
//
// REGOLE (non negoziabili):
//   · ogni file dichiara FONTE e RILEVAZIONE dentro di sé (campo o riga di commento);
//   · nessun numero senza copertura: se la copertura non c'è, il campo resta null e lo si dice;
//   · si usa SEMPRE il prezzo base d'asta, mai l'offerta minima (lo scarto base→minima è il
//     pavimento legale del 25%, non uno sconto di mercato — direttiva 6/11/2026);
//   · se una sorgente non risponde, il file che ne dipende NON si riscrive (mai un numero vecchio
//     presentato come fresco, mai un numero inventato).
//
// Uso: node scripts/meccanismi-dati.js [--solo=sconto|serie|tipi] [--dry]
// Zero dipendenze: solo fetch e fs (gira su GitHub Actions e in locale).

const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const FEED = path.join(RADICE, 'feed');
const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/feed/';
const PVP_RICERCA = 'https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite?page=0&size=1&language=it&sort=dataOraVendita%2Cdesc';
const SOLO = (process.argv.find(a => a.startsWith('--solo=')) || '').split('=')[1] || '';
const DRY = process.argv.includes('--dry');
const UA = 'CAReAuctions-meccanismi-dati/1.0 (+https://careauctions.co)';

const log = (...a) => console.log('[meccanismi-dati]', ...a);

// ---- lettura dei feed: prima dal checkout (CI), poi dalla raw -----------------
async function leggiFeed(nome) {
  const locale = path.join(FEED, nome);
  try {
    if (fs.existsSync(locale)) return JSON.parse(fs.readFileSync(locale, 'utf8'));
  } catch (e) { log('feed locale illeggibile: ' + nome + ' — ' + e.message); }
  try {
    const r = await fetch(RAW + nome, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) { log('raw ' + nome + ' → HTTP ' + r.status); return null; }
    return await r.json();
  } catch (e) { log('raw ' + nome + ' → ' + e.message); return null; }
}

function scrivi(rel, testo) {
  const p = path.join(RADICE, rel);
  if (DRY) { log('dry: avrei scritto ' + rel + ' (' + Buffer.byteLength(testo, 'utf8') + ' byte)'); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, testo);
  log('scritto ' + rel + ' (' + Buffer.byteLength(testo, 'utf8') + ' byte)');
}

const num = (v, d) => (v === null || v === undefined || isNaN(Number(v))) ? '' : Number(v).toFixed(d || 0);
const dataIT = iso => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
};
// CSV: campo fra virgolette se contiene virgola, virgoletta o a capo
const csv = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const riga = arr => arr.map(csv).join(',');

// =============================================================================
// 1 · SCONTO REALE CERTIFICATO — il numero che diventa citabile (Zillow)
// =============================================================================
async function generaSconto() {
  const cm = await leggiFeed('confronto-mercato.json');
  if (!cm || !cm.nazionale || cm.nazionale.scontoMedianoPct === undefined) {
    log('sconto: confronto-mercato.json assente o senza nazionale → non scrivo'); return null;
  }
  const m = cm.meta || {};
  const cp = m.copertura || {};
  const naz = cm.nazionale;
  const rilevazione = m.rilevazione || cm.rilevazione || null;
  const comuni = Array.isArray(cm.comuni) ? cm.comuni : [];
  const lottiConfrontabili = Number(naz.lotti) || 0;
  const fonte = [
    { nome: 'Portale delle Vendite Pubbliche (Ministero della Giustizia)', url: 'https://pvp.giustizia.it', ruolo: 'prezzi base d\'asta dei lotti' },
    { nome: 'OMI — Agenzia delle Entrate (Osservatorio del Mercato Immobiliare)', url: 'https://www1.agenziaentrate.gov.it/servizi/geopoi_omi/', ruolo: 'valori di mercato OMI (mediana delle zone del comune)' }
  ];
  const valore = Math.round(Number(naz.scontoMedianoPct) * 10) / 10;
  const certificato = {
    nome: 'Sconto Reale Certificato',
    definizione: 'La mediana di quanto il prezzo base d\'asta sta sotto il valore di mercato OMI del comune, misurata sui lotti residenziali con la superficie dichiarata.',
    numero: {
      valorePct: valore,
      etichetta: 'Sconto Reale Certificato — mediana nazionale',
      formula: '1 − (prezzo base d\'asta al mq) / (valore OMI al mq del comune)',
      usaPrezzo: 'prezzo base d\'asta (mai l\'offerta minima: lo scarto base→minima è il pavimento legale del 25%, non uno sconto di mercato)'
    },
    intervallo: { p25Pct: Number(naz.scontoP25Pct), p75Pct: Number(naz.scontoP75Pct), conservativoPct: Number(naz.scontoConservativoPct) },
    copertura: {
      lottiConfrontabili: lottiConfrontabili,
      lottiConMq: Number(cp.lottiConMq) || null,
      lottiResidenziali: Number(cp.lottiResidenziali) || null,
      comuniPubblicati: Number(cp.comuniPubblicati) || comuni.length,
      comuniConOmi: Number(cp.comuniOmi) || null,
      semestreOmi: m.semestreOmi || null,
      percentualeLottiConMq: Number(cp.percentualeConMq) || null
    },
    prezzoMqMedioAste: Number(naz.prezzoMqMedio) || null,
    fonte: fonte,
    rilevazione: rilevazione,
    rilevazioneLeggibile: dataIT(rilevazione),
    cadenza: m.cadenza || 'settimanale (workflow confronto-mercato.yml)',
    generatoIl: new Date().toISOString(),
    metodo: m.metodo || null,
    nota: m.nota || null,
    fraseCitabile: 'Secondo lo Sconto Reale Certificato di CAReAuctions, il prezzo base delle case all\'asta in Italia è in mediana il '
      + String(valore).replace('.', ',') + '% sotto il valore di mercato OMI, su '
      + lottiConfrontabili.toLocaleString('it-IT') + ' lotti confrontabili in '
      + (Number(cp.comuniPubblicati) || comuni.length).toLocaleString('it-IT') + ' comuni (rilevazione '
      + dataIT(rilevazione) + '; fonti: PVP del Ministero della Giustizia e OMI dell\'Agenzia delle Entrate).',
    citareCome: 'CAReAuctions — «Sconto Reale Certificato», rilevazione del ' + dataIT(rilevazione) + ' — https://careauctions.co/sconto-reale-certificato',
    pagina: 'https://careauctions.co/sconto-reale-certificato',
    csv: 'https://careauctions.co/feed/sconto-reale-certificato.csv',
    json: 'https://careauctions.co/feed/sconto-reale-certificato.json',
    regola: 'I valori OMI non si pubblicano mai: si pubblica la percentuale con la sua copertura (direttiva 5.874).'
  };
  scrivi('feed/sconto-reale-certificato.json', JSON.stringify(certificato, null, 1));

  // CSV per comune, con fonte e rilevazione DENTRO il file (righe di commento #)
  const righe = [];
  righe.push('# Sconto Reale Certificato — CAReAuctions — comune per comune');
  righe.push('# Fonte prezzi: ' + fonte[0].nome + ' — ' + fonte[0].url);
  righe.push('# Fonte valori: ' + fonte[1].nome + ' — ' + fonte[1].url);
  righe.push('# Rilevazione: ' + (rilevazione || 'n/d') + ' (' + (dataIT(rilevazione) || 'n/d') + ') · semestre OMI: ' + (m.semestreOmi || 'n/d'));
  righe.push('# Copertura: ' + lottiConfrontabili + ' lotti confrontabili · ' + (Number(cp.comuniPubblicati) || comuni.length) + ' comuni pubblicati · ' + (Number(cp.comuniOmi) || 'n/d') + ' comuni con valori OMI');
  righe.push('# Metodo: ' + String(m.metodo || '').replace(/\s+/g, ' ').slice(0, 500));
  righe.push('# Nota: si usa il prezzo base d\'asta, mai l\'offerta minima. I valori OMI non si pubblicano: solo la percentuale.');
  righe.push('# Licenza d\'uso: dati pubblici (PVP, OMI) aggregati da CAReAuctions; si cita «CAReAuctions — Sconto Reale Certificato, rilevazione ' + (dataIT(rilevazione) || 'n/d') + '».');
  righe.push(riga(['comune', 'provincia', 'lotti_confrontabili', 'sconto_mediano_pct', 'sconto_p25_pct', 'sconto_p75_pct', 'sconto_conservativo_pct', 'prezzo_mq_medio_aste_eur', 'semestre_omi', 'rilevazione', 'fonte_prezzi', 'fonte_valori']));
  for (const c of comuni.slice().sort((a, b) => (Number(b.lotti) || 0) - (Number(a.lotti) || 0))) {
    righe.push(riga([
      c.comune || '', c.provincia || '', num(c.lotti), num(c.scontoMedianoPct, 1), num(c.scontoP25Pct, 1),
      num(c.scontoP75Pct, 1), num(c.scontoConservativoPct, 1), num(c.prezzoMqMedio),
      m.semestreOmi || '', rilevazione || '',
      'PVP — Ministero della Giustizia (pvp.giustizia.it)', 'OMI — Agenzia delle Entrate'
    ]));
  }
  scrivi('feed/sconto-reale-certificato.csv', righe.join('\n') + '\n');
  log('sconto: ' + valore + '% su ' + lottiConfrontabili + ' lotti, ' + comuni.length + ' comuni, rilevazione ' + rilevazione);
  return certificato;
}

// =============================================================================
// 2-4 · REDFIN — i CSV scaricabili (serie storica e esiti)
// =============================================================================
async function generaSerie() {
  const ap = await leggiFeed('andamento-prezzi.json');
  const ae = await leggiFeed('andamento-esiti.json');
  const st = await leggiFeed('statistiche.json');
  const oggi = new Date().toISOString();

  // 2 · andamento-esiti.csv — la serie storica giorno per giorno, scaricabile
  if (ap && Array.isArray(ap.giorni) && ap.giorni.length) {
    const fonte = ap.fonte || { nome: 'Portale delle Vendite Pubbliche (Ministero della Giustizia)', url: 'https://pvp.giustizia.it' };
    const out = [];
    out.push('# Serie storica delle aste immobiliari italiane — CAReAuctions');
    out.push('# Fonte: ' + fonte.nome + ' — ' + (fonte.url || 'https://pvp.giustizia.it'));
    out.push('# Rilevazione: ' + (ap.rilevazione || 'n/d') + ' · granularità: ' + (ap.rilevazioneGranularita || 'giorno'));
    out.push('# Nota: ' + String(ap.rilevazioneNota || '').replace(/\s+/g, ' '));
    out.push('# Colonne: data = giorno della misura · totale_lotti = lotti a catalogo quel giorno · prezzo_medio_eur = prezzo BASE medio (non l\'offerta minima) · scarto_base_minima_pct = scarto fra prezzo base e offerta minima (pavimento legale, NON uno sconto di mercato)');
    out.push('# Citazione: «CAReAuctions — serie storica delle aste, rilevazione ' + (ap.rilevazione || 'n/d') + '» — https://careauctions.co/feed/andamento-esiti.csv');
    out.push(riga(['data', 'totale_lotti', 'prezzo_medio_eur', 'scarto_base_minima_pct', 'fonte', 'rilevazione']));
    for (const g of ap.giorni) {
      const scarto = (g.scartoBaseMinimaMedio !== undefined) ? g.scartoBaseMinimaMedio : g.scontoMedio;
      out.push(riga([g.data, num(g.totale), num(g.prezzoMedio), num(scarto, 1), 'PVP — Ministero della Giustizia', ap.rilevazione || '']));
    }
    scrivi('feed/andamento-esiti.csv', out.join('\n') + '\n');

    // 4 · serie.csv — la stessa storia in formato lungo (una riga = una misura)
    const lungo = [];
    lungo.push('# Serie storica in formato lungo — CAReAuctions');
    lungo.push('# Fonte: ' + fonte.nome + ' — ' + (fonte.url || 'https://pvp.giustizia.it') + ' · rilevazione: ' + (ap.rilevazione || 'n/d'));
    lungo.push('# Formato: serie,misura,data,valore — una riga per ogni punto di ogni serie (comodo per i grafici).');
    lungo.push(riga(['serie', 'misura', 'data', 'valore', 'unita', 'fonte', 'rilevazione']));
    for (const g of ap.giorni) {
      lungo.push(riga(['aste', 'totale_lotti', g.data, num(g.totale), 'lotti', 'PVP', ap.rilevazione || '']));
      lungo.push(riga(['aste', 'prezzo_medio_eur', g.data, num(g.prezzoMedio), 'EUR', 'PVP', ap.rilevazione || '']));
      const scartoL = (g.scartoBaseMinimaMedio !== undefined) ? g.scartoBaseMinimaMedio : g.scontoMedio;
      lungo.push(riga(['aste', 'scarto_base_minima_pct', g.data, num(scartoL, 1), '%', 'PVP', ap.rilevazione || '']));
    }
    scrivi('feed/serie.csv', lungo.join('\n') + '\n');
  } else {
    log('serie: andamento-prezzi.json assente o senza giorni → non scrivo');
  }

  // 3 · esiti-statistiche.csv — gli esiti con la copertura dichiarata
  if (ae && ae.esiti) {
    const tot = Number((st && st.totale) || 0);
    const ESITI_VERI = ['aggiudicate', 'deserte', 'sospese'];
    const nonPubblicato = Object.keys(ae.esiti).filter(k => ESITI_VERI.indexOf(k) < 0).reduce((a, k) => a + (Number(ae.esiti[k]) || 0), 0);
    const somma = ESITI_VERI.reduce((a, k) => a + (Number(ae.esiti[k]) || 0), 0);
    const out = [];
    out.push('# Esiti delle aste immobiliari italiane — CAReAuctions');
    out.push('# Fonte: ' + String(ae.nota || 'Portale delle Vendite Pubbliche e portali autorizzati'));
    out.push('# Rilevazione: ' + (ae.generato || 'n/d'));
    out.push('# Copertura dichiarata: ' + somma + ' lotti con un esito VERO (aggiudicata, deserta, sospesa)' + (tot ? ' su ' + tot + ' lotti a catalogo (' + (Math.round((somma / tot) * 1000) / 10) + '%)' : '') + ' · ' + nonPubblicato + ' lotti senza esito pubblicato (non contati come deserte)');
    out.push('# Avvertenza: gli esiti non sono nell\'API pubblica del PVP; si contano dalle fonti autorizzate che li pubblicano. Un esito mancante non è un\'asta deserta.');
    out.push(riga(['stato', 'esiti', 'quota_pct_sugli_esiti', 'totale_lotti_catalogo', 'rilevazione', 'fonte']));
    for (const [k, v] of Object.entries(ae.esiti)) {
      const eVeri = ESITI_VERI.indexOf(k) >= 0;
      const quota = eVeri ? (somma ? Math.round((Number(v) / somma) * 1000) / 10 : '') : '';
      out.push(riga([k, num(v), num(quota, 1), tot || '', ae.generato || '', eVeri ? 'PVP e portali autorizzati' : 'senza esito pubblicato — non e un esito']));
    }
    scrivi('feed/esiti-statistiche.csv', out.join('\n') + '\n');
  } else {
    log('esiti: andamento-esiti.json assente → non scrivo esiti-statistiche.csv');
  }
  log('serie: fine');
  return true;
}

// =============================================================================
// 5 · IDEALISTA — il tipo d'asta come dimensione di URL
// =============================================================================
async function contaPvp(tipoLotto) {
  try {
    const r = await fetch(PVP_RICERCA, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ tipoLotto: tipoLotto }),
      signal: AbortSignal.timeout(25000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    const n = (j.body || {}).totalElements;
    return Number.isFinite(Number(n)) ? Number(n) : null;
  } catch (e) { return null; }
}
const slugify = s => String(s || '').toLowerCase()
  .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o').replace(/[ùúûü]/g, 'u')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function generaTipi() {
  const sm = await leggiFeed('statistiche-mercato.json');
  const st = await leggiFeed('statistiche.json');
  const az = await leggiFeed('aste-aziende.json');
  const ag = await leggiFeed('aggiudicazioni.json');
  const rilevazione = new Date().toISOString();
  const totale = Number((st && st.totale) || (sm && sm.meta && sm.meta.totaleLotti) || 0);

  // tipo di lotto: numeri chiesti ADESSO al PVP (una pagina da 1 record, solo il totale)
  const conteggi = {};
  for (const t of ['IMMOBILI', 'MOBILI', 'AZIENDE']) {
    const n = await contaPvp(t);
    if (n !== null) conteggi[t] = n;
    await new Promise(r => setTimeout(r, 400));
  }
  const sommaTipi = Object.values(conteggi).reduce((a, b) => a + b, 0);

  const tipi = [
    { slug: 'immobiliare', nome: 'Aste immobiliari', chiave: 'tipoLotto', valore: 'IMMOBILI', nota: 'Case, terreni, negozi, capannoni: i lotti immobiliari del catalogo.' },
    { slug: 'mobiliare', nome: 'Aste mobiliari', chiave: 'tipoLotto', valore: 'MOBILI', nota: 'Auto, macchinari, arredi: i lotti mobiliari, spesso dentro la stessa procedura.' },
    { slug: 'aziende', nome: 'Aste di aziende, quote e crediti', chiave: 'tipoLotto', valore: 'AZIENDE', nota: 'Complessi aziendali, quote societarie e crediti.' }
  ].map(t => {
    const n = conteggi[t.valore];
    return Object.assign(t, {
      lotti: n === undefined ? null : n,
      quotaPct: (n !== undefined && sommaTipi) ? Math.round((n / sommaTipi) * 1000) / 10 : null,
      url: '/aste-categoria/it/' + t.slug + '.html'
    });
  });

  // categoria del bene: dai conteggi del nostro giro (statistiche-mercato)
  const mix = (sm && sm.mixCategoria && Array.isArray(sm.mixCategoria.top)) ? sm.mixCategoria.top : [];
  const categorie = mix.slice(0, 12).map(c => ({
    slug: slugify(c.categoria),
    nome: String(c.categoria || '').replace(/_/g, ' ').toLowerCase().replace(/^./, s => s.toUpperCase()),
    categoria: c.categoria,
    lotti: Number(c.lotti) || null,
    quotaPct: Number(c.quota) || null,
    url: '/aste-categoria/it/' + slugify(c.categoria) + '.html'
  }));

  // filone fallimentare: ciò che le nostre fonti ci danno davvero
  let aggiudicazioniFallco = null, aggiudicazioniTot = null;
  if (Array.isArray(ag)) {
    aggiudicazioniTot = ag.length;
    aggiudicazioniFallco = ag.filter(a => String(a.fonte || '') === 'fallcoaste').length;
  }
  const aziendeLotti = Array.isArray(az) ? az.length : null;
  const procedure = [{
    slug: 'fallimentare',
    nome: 'Aste fallimentari',
    url: '/aste-categoria/it/fallimentare.html',
    aggiudicazioniFallimento: aggiudicazioniFallco,
    aggiudicazioniRegistrate: aggiudicazioniTot,
    lottiAziendeQuoteCrediti: aziendeLotti,
    nota: 'Il PVP non espone un filtro pubblico per tipo di procedura: i fallimenti si contano da ciò che le fonti pubblicano. FallcoAste pubblica gli esiti dei fallimenti; il catalogo PVP pubblica i lotti di aziende, quote e crediti.'
  }];

  const fuori = { IMMOBILI: 0, MOBILI: 0, AZIENDE: 0 };
  const dati = {
    generato: rilevazione,
    fonte: [
      { nome: 'Portale delle Vendite Pubbliche (Ministero della Giustizia)', url: 'https://pvp.giustizia.it', ruolo: 'conteggio dei lotti per tipo (tipoLotto) — letto dal servizio di ricerca pubblico' },
      { nome: 'CAReAuctions — giri automatici', url: 'https://careauctions.co/feed/statistiche-mercato.json', ruolo: 'categorie del bene, totale del catalogo, cattura dei lotti' },
      { nome: 'FallcoAste', url: 'https://www.fallcoaste.it', ruolo: 'aggiudicazioni dei fallimenti' }
    ],
    rilevazione: rilevazione,
    rilevazioneLeggibile: dataIT(rilevazione),
    totaleCatalogo: totale || null,
    tipoLottoSomma: sommaTipi || null,
    tipi: tipi,
    categorie: categorie,
    procedure: procedure,
    nota: 'Il tipo d\'asta è una dimensione di URL, non un parametro ?q=. Ogni voce qui sopra ha la sua pagina: /aste-categoria/it/<slug>.html',
    regola: 'Un numero senza la sua fonte e la sua data non si pubblica: ogni voce porta fonte e rilevazione.'
  };
  scrivi('feed/tipi-asta.json', JSON.stringify(dati, null, 1));
  log('tipi: ' + JSON.stringify(conteggi) + ' · categorie ' + categorie.length + ' · fallco ' + aggiudicazioniFallco + '/' + aggiudicazioniTot);
  return dati;
}

// ---- giro -------------------------------------------------------------------
(async () => {
  let esito = 0;
  try {
    if (!SOLO || SOLO === 'sconto') await generaSconto().catch(e => { log('sconto ERRORE: ' + e.message); esito = 1; });
    if (!SOLO || SOLO === 'serie') await generaSerie().catch(e => { log('serie ERRORE: ' + e.message); esito = 1; });
    if (!SOLO || SOLO === 'tipi') await generaTipi().catch(e => { log('tipi ERRORE: ' + e.message); esito = 1; });
  } catch (e) {
    log('ERRORE: ' + e.message); esito = 1;
  }
  log(esito ? 'giro CHIUSO CON ERRORI' : 'giro chiuso');
  process.exit(esito);
})();
