// scripts/sync-aziende.js — Aste di aziende, quote societarie e crediti (direttiva 5.902)
// Gira nel cloud (GitHub Actions, costo 0): raccoglie dal PVP i lotti NON immobiliari/mobiliari
// che il feed principale scarta — AZIENDE, VALORI-CREDITI, ALTRO — e li pubblica in:
//   feed/aste-aziende.json            (aste in corso e future: la vetrina viva)
//   feed/aste-aziende-archivio.json   (aste concluse: la memoria storica)
// Regole: solo dati pubblici del PVP, mai numeri inventati, fonte citata, gentile col portale.
const fs = require('fs');
const path = require('path');
const https = require('https');

const TIPI = ['AZIENDE', 'VALORI-CREDITI', 'ALTRO'];
const MAPPA_TIPO = { 'AZIENDE': 'AZIENDE', 'VALORI-CREDITI': 'CREDITI', 'ALTRO': 'ALTRO' };
const SIZE = 100;
const OUT = path.join(__dirname, '..', 'feed');

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
const regioneDi = p => PROV[norm(p)] || PROV[norm(p).replace(/'/g, '')] || 'Italia';

// etichetta leggibile dalle categorie del PVP (CESSIONE_DI_AZIENDA → Cessione di azienda)
const BELLE = {
  'CESSIONE_DI_AZIENDA': "Cessione d'azienda", 'CESSIONE_AFFITTO': "Cessione d'azienda in affitto",
  'QUOTE_SOCIETARIE': 'Quote societarie', 'AZIONI': 'Azioni', 'CREDITI': 'Crediti',
  'RAMO_D_AZIENDA': "Ramo d'azienda", 'FABBRICATI_COSTRUITI_PER_ESIGENZE_IND': 'Immobile industriale in compendio aziendale'
};
function bella(cat) {
  const c = String(cat || '').trim();
  if (!c) return 'Lotto';
  if (BELLE[c]) return BELLE[c];
  const s = c.toLowerCase().replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function post(host, percorso, body) {
  return new Promise((res) => {
    const d = JSON.stringify(body || {});
    const r = https.request({ host, path: percorso, method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; careauctions-aziende/1.0)', 'Accept': 'application/json' } }, (x) => {
      let t = ''; x.on('data', c => t += c); x.on('end', () => res({ s: x.statusCode, t }));
    });
    r.on('error', () => res({ s: 0, t: '' }));
    r.setTimeout(30000, () => { r.destroy(); res({ s: 0, t: '' }); });
    r.write(d); r.end();
  });
}
function get(host, percorso) {
  return new Promise((res) => {
    const r = https.get({ host, path: percorso, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; careauctions-aziende/1.0)', 'Accept': 'text/html' } }, (x) => {
      let t = ''; x.on('data', c => t += c); x.on('end', () => res({ s: x.statusCode, t }));
    });
    r.on('error', () => res({ s: 0, t: '' }));
    r.setTimeout(30000, () => { r.destroy(); res({ s: 0, t: '' }); });
  });
}
const dormi = ms => new Promise(s => setTimeout(s, ms));

// il prefisso UUID del PVP cambia a ogni deploy: si scopre dal sito ufficiale
async function scopriPrefisso() {
  const noti = ['ric-496b258c-986a1b71'];
  for (const n of noti) {
    const r = await post('pvp.giustizia.it', '/' + n + '/ric-ms/ricerca/vendite?page=0&size=1&language=it', {});
    if (r.s === 200) { try { const j = JSON.parse(r.t); if (j.body) return n; } catch (e) {} }
    await dormi(800);
  }
  const pagina = await get('pvp.giustizia.it', '/pvp/it/ricerca.page');
  const m = String(pagina.t || '').match(/ric-[0-9a-f]{8}-[0-9a-f]{8}/);
  if (m) return m[0];
  return noti[0];
}

function mappa(x) {
  const tipo = MAPPA_TIPO[String(x.tipoLotto || '')] || 'ALTRO';
  const prov = (x.indirizzo && x.indirizzo.provincia) || '';
  const citta = (x.indirizzo && x.indirizzo.citta) || '';
  const base = Number(x.prezzoBaseAsta) || 0;
  const minima = Number(x.offertaMinima) || 0;
  let sconto = base > 0 ? Math.round((1 - minima / base) * 100) : 0;
  if (sconto < 0) sconto = 0; if (sconto > 99) sconto = 99;
  const cat = (x.categoriaBene && x.categoriaBene[0]) || String(x.categoriaLotto || '');
  return {
    id: String(x.id),
    tipo,
    categoria: String(cat || ''),
    cat: bella(cat),
    titolo: bella(cat) + ' · ' + citta + (prov ? ' (' + prov + ')' : ''),
    descrizione: String(x.descLotto || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    prezzoBase: base,
    minima,
    scontoPct: sconto,
    dataAsta: String(x.dataVendita || ''),
    oraAsta: String(x.orarioVendita || '').slice(0, 5),
    citta,
    provincia: prov,
    regione: regioneDi(prov),
    tribunale: String(x.tribunale || ''),
    esito: String(x.esito || ''),
    esitoEtichetta: ({ AGGIU: 'Aggiudicata', ASDES: 'Non aggiudicata', SOSPE: 'Sospesa' })[String(x.esito || '')] || '',
    link: 'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=' + x.id
  };
}

(async () => {
  const prefisso = await scopriPrefisso();
  console.log('prefisso PVP:', prefisso);
  const tutti = [];
  const visti = new Set();
  const copertura = {};
  for (const tipoPvp of TIPI) {
    // prima pagina: il totale dichiarato dal PVP
    const p0 = await post('pvp.giustizia.it', '/' + prefisso + '/ric-ms/ricerca/vendite?page=0&size=' + SIZE + '&language=it&sort=dataOraVendita%2Cdesc', { tipoLotto: tipoPvp });
    let tot = 0;
    try { tot = JSON.parse(p0.t).body.totalElements || 0; } catch (e) { console.log(tipoPvp + ': prima pagina non leggibile (stato ' + p0.s + ')'); }
    copertura[tipoPvp] = { dichiaratoPVP: tot, raccolti: 0 };
    const pagine = Math.ceil(tot / SIZE);
    console.log(tipoPvp + ': ' + tot + ' lotti · ' + pagine + ' pagine');
    let raccoltiTipo = 0;
    for (let p = 0; p < pagine; p++) {
      const r = p === 0 ? p0 : await post('pvp.giustizia.it', '/' + prefisso + '/ric-ms/ricerca/vendite?page=' + p + '&size=' + SIZE + '&language=it&sort=dataOraVendita%2Cdesc', { tipoLotto: tipoPvp });
      if (r.s === 200) {
        try {
          const j = JSON.parse(r.t);
          for (const x of (j.body && j.body.content) || []) {
            if (!x || x.id == null) continue;
            const id = String(x.id);
            if (visti.has(id)) continue;
            visti.add(id);
            tutti.push(mappa(x));
            raccoltiTipo++;
          }
        } catch (e) {}
      } else {
        console.log(tipoPvp + ' pagina ' + p + ': stato ' + r.s + ' — salto');
      }
      if (p % 10 === 0) console.log('  ' + tipoPvp + ' · pagine ' + (p + 1) + '/' + pagine);
      await dormi(250);
    }
    copertura[tipoPvp].raccolti = raccoltiTipo;
  }

  const oggi = new Date().toISOString().slice(0, 10);
  const attive = tutti.filter(x => x.dataAsta && x.dataAsta >= oggi).sort((a, b) => String(a.dataAsta).localeCompare(String(b.dataAsta)));
  const archivio = tutti.filter(x => !x.dataAsta || x.dataAsta < oggi).sort((a, b) => String(b.dataAsta).localeCompare(String(a.dataAsta)));

  const somma = a => a.reduce((t, x) => t + (Number(x.prezzoBase) || 0), 0);
  const perTipo = {};
  for (const x of attive) perTipo[x.tipo] = (perTipo[x.tipo] || 0) + 1;
  const meta = {
    titolo: 'Aste di aziende, quote societarie e crediti — dati veri dal PVP',
    generatoIl: new Date().toISOString(),
    dataRaccolta: oggi,
    totale: tutti.length,
    attive: attive.length,
    archivio: archivio.length,
    attivePerTipo: perTipo,
    valoreAttive: somma(attive),
    valoreTotale: somma(tutti),
    regioni: [...new Set(tutti.map(x => x.regione).filter(Boolean))].length,
    province: [...new Set(tutti.map(x => x.provincia).filter(Boolean))].length,
    comuni: [...new Set(tutti.map(x => x.citta).filter(Boolean))].length,
    tribunali: [...new Set(tutti.map(x => x.tribunale).filter(Boolean))].length,
    copertura,
    fonte: 'fonte PVP - Portale delle Vendite Pubbliche Giustizia - Ministero della Giustizia',
    nota: 'Solo lotti pubblicati sul PVP con tipo AZIENDE, VALORI-CREDITI e ALTRO. Nessun numero inventato: i campi mancanti non si mostrano.'
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'aste-aziende.json'), JSON.stringify({ meta, lotti: attive }));
  fs.writeFileSync(path.join(OUT, 'aste-aziende-archivio.json'), JSON.stringify({ meta, lotti: archivio }));
  console.log('SCRITTO: ' + attive.length + ' attive · ' + archivio.length + ' in archivio · totale ' + tutti.length);
  console.log('valore base attive: ' + (meta.valoreAttive / 1e6).toFixed(1) + ' mln € · totale ' + (meta.valoreTotale / 1e9).toFixed(2) + ' mld €');
})().catch(e => { console.error('FATALE', e); process.exit(1); });
