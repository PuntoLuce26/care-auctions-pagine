#!/usr/bin/env node
/**
 * raccogli-npl.js — Linea dati NPL / crediti in sofferenza (PuntoLuce · oCARe)
 * ---------------------------------------------------------------------------
 * FONTE UNICA: PVP — Portale delle Vendite Pubbliche (pvp.giustizia.it),
 * Ministero della Giustizia. Dati pubblici, nessun login, nessun pagamento.
 *
 * COSA FA
 *  1. Interroga l'endpoint pubblico del PVP che alimenta la ricerca:
 *       POST /<prefisso>/ric-ms/ricerca/vendite?page=N&size=100&language=it
 *       body: { "tipoLotto": "VALORI-CREDITI" }
 *     (stessa tecnica di scripts/sync-aziende.js — prefisso UUID scoperto dal sito)
 *  2. Normalizza ogni lotto nei campi della linea NPL.
 *  3. Classifica il tipo IN MODO CONSERVATIVO, solo da testo pubblico:
 *       - "sofferenza"  → la descrizione dice sofferenza/sofferenze
 *       - "NPL"         → la descrizione dice NPL / non performing / crediti deteriorati
 *       - "credito"     → tutti gli altri crediti (unitari/periodici) ceduti in procedura
 *     I crediti FISCALI (superbonus, bonus edilizi, crediti d'imposta) NON sono NPL:
 *     vengono esclusi dal dataset e solo contati in meta.esclusi.
 *     Le categorie TITOLI (azioni/quote) non sono crediti: escluse e contate.
 *  4. Estrae il valore nominale SOLO se scritto nella descrizione pubblica;
 *     se non c'è, il campo resta null (mai inventato).
 *  5. Scrive npl.json (dataset) e npl-statistiche.json (conteggi e copertura).
 *
 * REGOLE DI CORTESIA: pausa 400 ms tra pagine, timeout 30 s, tetto pagine,
 * User-Agent identificabile. Nessuna pagina aperta più di una volta per run.
 *
 * USO
 *   node raccogli-npl.js                  # raccolta live dal PVP
 *   node raccogli-npl.js --da-file X.json # riusa un grezzo già salvato
 *   node raccogli-npl.js --max-pagine 3   # campione ridotto (test)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = process.env.NPL_OUT_DIR || path.join(__dirname, '..', 'feed');
const OUT_DATASET = path.join(OUT_DIR, 'npl.json');
const OUT_STAT = path.join(OUT_DIR, 'npl-statistiche.json');

const PREFISSI_NOTI = ['ric-496b258c-986a1b71'];
const SIZE = 100;
const MAX_PAGINE = 12;          // VALORI-CREDITI sul PVP: 1116 lotti = 12 pagine
const DELAY_MS = 400;
const TIMEOUT_MS = 30000;
const UA = 'Mozilla/5.0 (compatible; puntoluce-npl/1.0; +https://careauctions.co)';

const LICENZA_PVP =
  'Dati pubblici del PVP (Portale delle Vendite Pubbliche, Ministero della Giustizia). ' +
  'Riuso consentito per finalità informative con citazione della fonte; ' +
  'nessun dato personale oltre a quanto già pubblico nel bando.';

// ---- mapping provincia → regione (stesso criterio di scripts/sync-aziende.js) ----
const PROV = {
  TORINO:'Piemonte',VERCELLI:'Piemonte',NOVARA:'Piemonte',CUNEO:'Piemonte',ASTI:'Piemonte',ALESSANDRIA:'Piemonte',BIELLA:'Piemonte','VERBANO-CUSIO-OSSOLA':'Piemonte',VERBANIA:'Piemonte',
  AOSTA:'Valle d Aosta','VALLE D AOSTA':'Valle d Aosta',
  MILANO:'Lombardia','MONZA E DELLA BRIANZA':'Lombardia','MONZA BRIANZA':'Lombardia',COMO:'Lombardia',VARESE:'Lombardia',LECCO:'Lombardia',SONDRIO:'Lombardia',BERGAMO:'Lombardia',BRESCIA:'Lombardia',PAVIA:'Lombardia',CREMONA:'Lombardia',MANTOVA:'Lombardia',LODI:'Lombardia',
  TRENTO:'Trentino-Alto Adige',BOLZANO:'Trentino-Alto Adige',BOZEN:'Trentino-Alto Adige',
  VENEZIA:'Veneto',VERONA:'Veneto',VICENZA:'Veneto',PADOVA:'Veneto',TREVISO:'Veneto',BELLUNO:'Veneto',ROVIGO:'Veneto',
  UDINE:'Friuli-Venezia Giulia',TRIESTE:'Friuli-Venezia Giulia',GORIZIA:'Friuli-Venezia Giulia',PORDENONE:'Friuli-Venezia Giulia',
  GENOVA:'Liguria',IMPERIA:'Liguria',SAVONA:'Liguria','LA SPEZIA':'Liguria',
  BOLOGNA:'Emilia-Romagna',MODENA:'Emilia-Romagna','REGGIO EMILIA':'Emilia-Romagna',"REGGIO NELL'EMILIA":'Emilia-Romagna',PARMA:'Emilia-Romagna',PIACENZA:'Emilia-Romagna',FERRARA:'Emilia-Romagna',RAVENNA:'Emilia-Romagna','FORLI-CESENA':'Emilia-Romagna','FORLÌ-CESENA':'Emilia-Romagna',RIMINI:'Emilia-Romagna',
  FIRENZE:'Toscana',PISA:'Toscana',LIVORNO:'Toscana',LUCCA:'Toscana','MASSA-CARRARA':'Toscana',PISTOIA:'Toscana',PRATO:'Toscana',SIENA:'Toscana',GROSSETO:'Toscana',AREZZO:'Toscana',
  PERUGIA:'Umbria',TERNI:'Umbria',
  ANCONA:'Marche','PESARO E URBINO':'Marche','PESARO-URBINO':'Marche',MACERATA:'Marche',FERMO:'Marche','ASCOLI PICENO':'Marche',
  ROMA:'Lazio',FROSINONE:'Lazio',LATINA:'Lazio',RIETI:'Lazio',VITERBO:'Lazio',
  "L'AQUILA":'Abruzzo',LAQUILA:'Abruzzo',PESCARA:'Abruzzo',CHIETI:'Abruzzo',TERAMO:'Abruzzo',
  CAMPOBASSO:'Molise',ISERNIA:'Molise',
  NAPOLI:'Campania',SALERNO:'Campania',AVELLINO:'Campania',BENEVENTO:'Campania',CASERTA:'Campania',
  BARI:'Puglia',LECCE:'Puglia',BRINDISI:'Puglia',TARANTO:'Puglia',FOGGIA:'Puglia','BARLETTA-ANDRIA-TRANI':'Puglia',
  POTENZA:'Basilicata',MATERA:'Basilicata',
  CATANZARO:'Calabria',COSENZA:'Calabria',CROTONE:'Calabria','REGGIO CALABRIA':'Calabria','REGGIO DI CALABRIA':'Calabria','VIBO VALENTIA':'Calabria',
  PALERMO:'Sicilia',CATANIA:'Sicilia',MESSINA:'Sicilia',SIRACUSA:'Sicilia',RAGUSA:'Sicilia',AGRIGENTO:'Sicilia',TRAPANI:'Sicilia',CALTANISSETTA:'Sicilia',ENNA:'Sicilia',
  CAGLIARI:'Sardegna',SASSARI:'Sardegna',NUORO:'Sardegna',ORISTANO:'Sardegna','SUD SARDEGNA':'Sardegna','CARBONIA-IGLESIAS':'Sardegna','MEDIO CAMPIDANO':'Sardegna','OGLIASTRA':'Sardegna'
};
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, "'").trim();
const regioneDi = p => PROV[norm(p)] || PROV[norm(p).replace(/'/g, '')] || '';

// ---- HTTP ----
function post(host, percorso, body) {
  return new Promise(res => {
    const d = JSON.stringify(body || {});
    const r = https.request({
      host, path: percorso, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Accept': 'application/json' }
    }, x => { let t = ''; x.on('data', c => t += c); x.on('end', () => res({ s: x.statusCode, t })); });
    r.on('error', e => res({ s: 0, t: 'ERR ' + e.message }));
    r.setTimeout(TIMEOUT_MS, () => { r.destroy(); res({ s: 0, t: 'TIMEOUT' }); });
    r.write(d); r.end();
  });
}
function get(host, percorso) {
  return new Promise(res => {
    const r = https.get({ host, path: percorso, headers: { 'User-Agent': UA, 'Accept': 'text/html' } }, x => {
      let t = ''; x.on('data', c => t += c); x.on('end', () => res({ s: x.statusCode, t }));
    });
    r.on('error', e => res({ s: 0, t: 'ERR ' + e.message }));
    r.setTimeout(TIMEOUT_MS, () => { r.destroy(); res({ s: 0, t: 'TIMEOUT' }); });
  });
}
const dormi = ms => new Promise(s => setTimeout(s, ms));

async function scopriPrefisso() {
  for (const n of PREFISSI_NOTI) {
    const r = await post('pvp.giustizia.it', '/' + n + '/ric-ms/ricerca/vendite?page=0&size=1&language=it', {});
    if (r.s === 200) { try { if (JSON.parse(r.t).body) return n; } catch (e) {} }
    await dormi(800);
  }
  const pagina = await get('pvp.giustizia.it', '/pvp/it/ricerca.page');
  const m = String(pagina.t || '').match(/ric-[0-9a-f]{8}-[0-9a-f]{8}/);
  return m ? m[0] : PREFISSI_NOTI[0];
}

// ---- classificazione (conservativa, solo testo pubblico) ----
const RE_SOFFERENZA = /sofferenz[ae]/i;
const RE_NPL = /\bNPL\b|non[\s-]*performing|credit[oi]\s+deteriorat|deteriorat[oi]\s+credit/i;
// credito FISCALE / d'imposta: non è un NPL (il debitore è lo Stato, non un privato inadempiente)
const RE_FISCALE = new RegExp([
  'fiscal', 'superbonus', 'bonus\\s+ediliz', 'bonus\\s+fiscali', 'ecobonus', 'sismabonus', '110\\s*%',
  "credit[oi]\\s+d['\u2019]?imposta", 'tributar', '\\bIRES\\b', '\\bIRAP\\b', 'erario',
  'credit[oi]\\s+(?:i\\.?v\\.?a\\.?|di\\s+iva)', 'rimborso\\s+(?:iva|fiscale)'
].join('|'), 'i');

function classifica(x, desc) {
  const cat = (x.categoriaBene && x.categoriaBene[0]) || '';
  if (cat === 'TITOLI' || /AZIONI|TITOLI/.test(String(x.categoriaLotto || ''))) {
    return { tipo: null, escluso: 'titoli-e-quote' };
  }
  if (RE_FISCALE.test(desc)) return { tipo: null, escluso: 'credito-fiscale' };
  if (!/CREDIT/.test(cat)) return { tipo: null, escluso: 'non-credito' };
  if (RE_SOFFERENZA.test(desc)) return { tipo: 'sofferenza' };
  if (RE_NPL.test(desc)) return { tipo: 'NPL' };
  return { tipo: 'credito' };
}

// ---- valore nominale: SOLO se scritto nel bando pubblico ----
const RE_NOMINALE = [
  /valore\s+nominale\s+(?:complessivo\s+)?(?:pari\s+a\s+|di\s+cui\s+|di\s+)?(?:circa\s+)?€?\s*([\d][\d.\s]*\d(?:,\d{1,2})?)/i,
  /credit[oi]\s+(?:di\s+|per\s+)?€\s*([\d][\d.\s]*\d(?:,\d{1,2})?)/i,
  /complessiv[ai]\s+€\s*([\d][\d.\s]*\d(?:,\d{1,2})?)/i,
  /€\s*([\d][\d.\s]*\d(?:,\d{1,2})?)/i
];
function numeroIt(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[\s.]/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
function valoreNominale(desc) {
  for (let i = 0; i < RE_NOMINALE.length; i++) {
    const m = String(desc).match(RE_NOMINALE[i]);
    const v = m && numeroIt(m[1]);
    if (v && v >= 100) return { valore: v, metodo: i === 3 ? 'importo-unico-in-descrizione' : 'valore-nominale-dichiarato' };
  }
  return { valore: null, metodo: null };
}

// ---- veicolo di vendita citato nel bando ----
const VEICOLI = [
  ['doauction.it', 'DoAuction'], ['astemobili.it', 'AsteMobili'], ['fallcoaste.it', 'FallcoAste (IVG)'],
  ['astegiudiziarie', 'AsteGiudiziarie'], ['astetelematiche', 'Aste Telematiche'], ['notarb.it', 'Notarb'],
  ['pvp.giustizia.it', 'PVP'], ['asteannunci', 'AsteAnnunci']
];
function veicoloDi(desc) {
  const d = String(desc).toLowerCase();
  for (const [k, nome] of VEICOLI) if (d.includes(k)) return nome;
  return null;
}

// ---- stato del lotto ----
function statoDi(x, oggi) {
  const esito = String(x.esito || '').toUpperCase();
  if (esito === 'AGGIU') return 'aggiudicata';
  if (esito === 'ASDES') return 'deserta';
  if (esito === 'SOSPE') return 'sospesa';
  const d = String(x.dataVendita || '');
  if (!d) return 'stato-non-pubblicato';
  if (d > oggi) return 'in-programma';
  return 'conclusa-esito-non-pubblicato';
}

function normalizza(x, oggi) {
  const desc = String(x.descLotto || '').replace(/\s+/g, ' ').trim();
  const cls = classifica(x, desc);
  if (!cls.tipo) return { scartato: cls.escluso };
  const ind = x.indirizzo || {};
  const prov = String(ind.provincia || '');
  const vn = valoreNominale(desc);
  const base = Number(x.prezzoBaseAsta) || null;
  return {
    lotto: {
      id: 'pvp-' + x.id,
      fonte: 'PVP',
      fonteUrl: 'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=' + x.id,
      tipo: cls.tipo,
      categoria: (x.categoriaBene && x.categoriaBene[0]) || '',
      importo: vn.valore,
      importoTipo: vn.metodo,
      prezzoBase: base,
      regione: regioneDi(prov) || null,
      provincia: prov || null,
      comune: ind.citta || null,
      tribunale: x.tribunale ? String(x.tribunale).replace(/^Tribunale di\s*/i, '').trim() : null,
      veicolo: veicoloDi(desc),
      data: x.dataVendita || null,
      ora: String(x.orarioVendita || '').slice(0, 5) || null,
      stato: statoDi(x, oggi),
      descrizione: desc.slice(0, 260),
      url: 'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=' + x.id,
      licenza: LICENZA_PVP,
      aggiornato: oggi
    }
  };
}

// ---- statistiche ----
const FASCIA = [
  ['fino-10k', 0, 10000], ['10k-50k', 10000, 50000], ['50k-250k', 50000, 250000],
  ['250k-1M', 250000, 1000000], ['oltre-1M', 1000000, Infinity]
];
function fasciaDi(v) {
  if (!v) return null;
  for (const [n, a, b] of FASCIA) if (v >= a && v < b) return n;
  return null;
}
function conta(arr, f) {
  const o = {};
  for (const x of arr) { const k = f(x); if (k != null && k !== '') o[k] = (o[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
}

(async () => {
  const args = process.argv.slice(2);
  const iFile = args.indexOf('--da-file');
  const iMax = args.indexOf('--max-pagine');
  const maxPagine = iMax >= 0 ? Number(args[iMax + 1]) || MAX_PAGINE : MAX_PAGINE;
  const oggi = new Date().toISOString().slice(0, 10);

  let raw;
  if (iFile >= 0) {
    const f = JSON.parse(fs.readFileSync(args[iFile + 1], 'utf8'));
    raw = f.rows || f;
    console.log('grezzo da file: ' + raw.length + ' righe');
  } else {
    const prefisso = await scopriPrefisso();
    console.log('prefisso PVP: ' + prefisso);
    raw = []; const visti = new Set(); let dichiarato = 0;
    for (let p = 0; p < maxPagine; p++) {
      const r = await post('pvp.giustizia.it', '/' + prefisso + '/ric-ms/ricerca/vendite?page=' + p + '&size=' + SIZE + '&language=it&sort=dataOraVendita%2Cdesc', { tipoLotto: 'VALORI-CREDITI' });
      if (r.s !== 200) { console.log('pagina ' + p + ': stato ' + r.s + ' — stop'); break; }
      let j; try { j = JSON.parse(r.t); } catch (e) { console.log('pagina ' + p + ': JSON non leggibile — stop'); break; }
      dichiarato = j.body.totalElements || 0;
      const c = (j.body.content || []);
      for (const x of c) if (x && x.id != null && !visti.has(String(x.id))) { visti.add(String(x.id)); raw.push(x); }
      console.log('  pagina ' + p + ' · cumulato ' + raw.length + '/' + dichiarato);
      if (c.length < SIZE) break;
      await dormi(DELAY_MS);
    }
    fs.mkdirSync(path.join(OUT_DIR, 'grezzi'), { recursive: true });
    fs.writeFileSync(path.join('/tmp', 'pvp-valori-crediti-' + oggi + '.json'),
      JSON.stringify({ raccoltoIl: new Date().toISOString(), dichiaratoPVP: dichiarato, righe: raw.length, rows: raw }));
    console.log('grezzo salvato in grezzi/');
  }

  const lotti = []; const esclusi = {};
  for (const x of raw) {
    const n = normalizza(x, oggi);
    if (n.scartato) { esclusi[n.scartato] = (esclusi[n.scartato] || 0) + 1; continue; }
    lotti.push(n.lotto);
  }
  lotti.sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));

  const perTipo = conta(lotti, x => x.tipo);
  const perRegione = conta(lotti, x => x.regione || null);
  const perProvincia = conta(lotti, x => x.provincia || null);
  const perStato = conta(lotti, x => x.stato);
  const fasceTot = conta(lotti, x => fasciaDi(x.importo));
  const fasceBase = conta(lotti, x => fasciaDi(x.prezzoBase));

  const conImporto = lotti.filter(x => x.importo).length;
  const conRegione = lotti.filter(x => x.regione).length;
  const conTribunale = lotti.filter(x => x.tribunale).length;
  const sommaBase = lotti.reduce((s, x) => s + (x.prezzoBase || 0), 0);

  const meta = {
    titolo: "NPL's — crediti in sofferenza e crediti in procedura (dati veri dal PVP)",
    generatoIl: new Date().toISOString(),
    aggiornato: oggi,
    fonte: 'PVP — Portale delle Vendite Pubbliche, Ministero della Giustizia (pvp.giustizia.it)',
    query: 'tipoLotto=VALORI-CREDITI',
    licenza: LICENZA_PVP,
    metodo: 'Classificazione conservativa dal testo pubblico del bando: NPL/sofferenza solo se dichiarati; ' +
            'crediti fiscali e titoli/quote esclusi (classi diverse, non NPL). Valore nominale solo se scritto nel bando.',
    totale: lotti.length,
    dichiaratoPVP: raw.length,
    esclusi,
    copertura: {
      importo: { con: conImporto, su: lotti.length, pct: +(100 * conImporto / (lotti.length || 1)).toFixed(1) },
      regione: { con: conRegione, su: lotti.length, pct: +(100 * conRegione / (lotti.length || 1)).toFixed(1) },
      tribunale: { con: conTribunale, su: lotti.length, pct: +(100 * conTribunale / (lotti.length || 1)).toFixed(1) }
    },
    perTipo, perStato,
    fasceImportoNominale: fasceTot,
    fascePrezzoBase: fasceBase,
    regioni: Object.keys(perRegione).length,
    province: Object.keys(perProvincia).length,
    sommaPrezzoBase: Math.round(sommaBase),
    freschezza: {
      ultimaRaccolta: oggi,
      dataLottoPiuRecente: lotti.map(x => x.data).filter(Boolean).sort().pop() || null,
      dataLottoPiuVecchio: lotti.map(x => x.data).filter(Boolean).sort()[0] || null
    },
    nota: 'Nessun numero inventato: i campi mancanti restano null e non vanno mostrati. ' +
          'Prezzo base = base d\'asta del bando, NON il valore nominale del credito.'
  };

  fs.writeFileSync(OUT_DATASET, JSON.stringify({ meta, lotti }, null, 0));
  fs.writeFileSync(OUT_STAT, JSON.stringify({ meta, perRegione, perProvincia }, null, 1));

  console.log('\nSCRITTO ' + OUT_DATASET);
  console.log('lotti: ' + lotti.length + ' · esclusi: ' + JSON.stringify(esclusi));
  console.log('per tipo: ' + JSON.stringify(perTipo));
  console.log('per stato: ' + JSON.stringify(perStato));
  console.log('regioni: ' + meta.regioni + ' · province: ' + meta.province);
  console.log('copertura importo ' + meta.copertura.importo.pct + '% · regione ' + meta.copertura.regione.pct + '% · tribunale ' + meta.copertura.tribunale.pct + '%');
  console.log('somma prezzi base: € ' + meta.sommaPrezzoBase.toLocaleString('it-IT'));
})().catch(e => { console.error('FATALE', e); process.exit(1); });
