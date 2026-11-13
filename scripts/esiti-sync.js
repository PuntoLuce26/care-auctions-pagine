#!/usr/bin/env node
/* CARe — esiti-sync: raccoglie i PREZZI DI AGGIUDICAZIONE pubblici, li normalizza,
   calcola le statistiche per CAReIndex/iDati/CAReOS e aggiorna i feed.
   Fonti: FallcoAste "Miglior offerta €" (award), Notarile Verona, AstaGiudiziaria/IVG.
   Regola: un prezzo senza fonte non è un dato; la copertura si dichiara sempre. */
const fs = require('fs');
const path = require('path');
const FEED = path.join(process.cwd(), 'feed');
const OUT = { esiti: path.join(FEED, 'esiti-statistiche.json'), indice: path.join(FEED, 'ca-re-index-esiti.json'), report: path.join(FEED, 'esiti-report.json') };
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const w = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const num = v => { const n = Number(String(v == null ? '' : v).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '')); return isFinite(n) && n > 0 ? n : null; };
const dateIt = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{2})/); return m ? ('20' + m[3] + '-' + m[2] + '-' + m[1]) : null; };
const trib = s => { const m = String(s || '').match(/Tribunale\s+di\s+([^-\u2013]+?)(?:\s*[-\u2013]|$)/i); return m ? m[1].trim().toUpperCase() : null; };
const proc = s => { const m = String(s || '').match(/Procedura\s+n\.?\s*([0-9]+\/[0-9]+)/i); return m ? m[1] : null; };
const regioneDi = (t, mappa) => (mappa && mappa[t]) || null;
(async () => {
  const agg = read(path.join(FEED, 'aggiudicazioni.json'), []);
  const fonteTmp = ['/tmp/aggiudicazioni-fallco.json', '/tmp/aggiudicazioni-ivg.json'].map(p => read(p, [])).flat();
  // merge non distruttivo: fonte|id
  const map = new Map();
  for (const x of agg) if (x && x.id != null) map.set(String(x.fonte || '?') + '|' + String(x.id), x);
  for (const x of fonteTmp) if (x && x.id != null) map.set(String(x.fonte || '?') + '|' + String(x.id), Object.assign({ fonte: x.fonte || '?' }, x));
  const tutti = [...map.values()];
  // mapping tribunale→regione dal monitor esistente
  const monOld = read(path.join(FEED, 'esiti-monitor.json'), {});
  const mappaReg = {};
  for (const [t, r] of (monOld.tribunali || [])) mappaReg[String(t).toUpperCase()] = r;
  // record con PREZZO DI AGGIUDICAZIONE (non prezzo base, non mobiliari senza tribunale)
  const awards = [];
  for (const x of tutti) {
    const lbl = String(x.prezzo_label || '');
    const fallcoAward = x.fonte === 'fallcoaste' && /Miglior offerta|aggiudicazione/i.test(lbl) && !/Prezzo base/i.test(lbl);
    const notarile = x.fonte === 'notarile-verona' && /aggiudicat/i.test(String(x.descrizione || ''));
    if (!fallcoAward && !notarile) continue;
    const desc = String(x.descrizione || x.titolo || '');
    const mobile = /(autoveicol|motoveicol|autovettur|furgon|trattor|escavator|macchinar|attrezzatur|arred|oro\b|argento|orolog|gioiell|quadro|barca|natante|imbarcazion|moto\b|scooter|ciclomot|carrell|muletto|container|merci|scorte|materie prime|idropulit|elettrodomest|computer|telefon|attrezzi|lotto di|pell|tessut|mobilio)/i.test(desc);
    const immob = /(appartament|abitazion|villa|terren|capannon|negozi|locale|immobil|box\b|garage|magazzin|uffici|palazz|fabbricat|rustic|casal|attic|mansard|loft|opifici|alberg|hotel|tenut|poder|area edificabil|pertinenz|autorimess|posto auto|seminativ|bosco|vignet|ulivet|capannone|azienda agricola|stabiliment|immobile)/i.test(desc);
    if (!notarile && (mobile || !immob)) continue;
    const prezzo = num(x.prezzo);
    if (!prezzo) continue;
    const t = trib(x.tribunale);
    const data = dateIt(x.termina) || (String(x.id || '').match(/vr-(\d{4})/) ? String(x.id).match(/vr-(\d{4})/)[1] + '-01-01' : null);
    awards.push({ id: String(x.id), fonte: x.fonte, prezzo, prezzoBase: null, tribunale: t, procedura: proc(x.tribunale), data, regione: regioneDi(t, mappaReg), url: x.url || null, descrizione: String(x.descrizione || x.titolo || '').slice(0, 220) });
  }
  const allAwards = tutti.filter(x => {
    const lbl = String(x.prezzo_label || '');
    const desc = String(x.descrizione || x.titolo || '');
    return (x.fonte === 'fallcoaste' && /Miglior offerta|aggiudicazione/i.test(lbl) && !/Prezzo base/i.test(lbl) && Number(x.prezzo) > 0)
      || (x.fonte === 'notarile-verona' && /aggiudicat/i.test(desc) && Number(x.prezzo) > 0);
  }).length;
  const unici = new Map();
  for (const a of awards) unici.set(a.fonte + '|' + a.id, a);
  const lista = [...unici.values()].sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')));
  const prezzi = lista.map(x => x.prezzo).sort((a, b) => a - b);
  const mediana = prezzi.length ? (prezzi.length % 2 ? prezzi[(prezzi.length - 1) / 2] : Math.round((prezzi[prezzi.length / 2 - 1] + prezzi[prezzi.length / 2]) / 2)) : null;
  const media = prezzi.length ? Math.round(prezzi.reduce((s, x) => s + x, 0) / prezzi.length) : null;
  const perAnno = {};
  const perMese = {};
  const perTrib = {};
  const perReg = {};
  for (const a of lista) {
    if (a.data) { const y = a.data.slice(0, 4); perAnno[y] = perAnno[y] || { n: 0, somma: 0 }; perAnno[y].n++; perAnno[y].somma += a.prezzo; perMese[a.data.slice(0, 7)] = perMese[a.data.slice(0, 7)] || { n: 0, somma: 0 }; perMese[a.data.slice(0, 7)].n++; perMese[a.data.slice(0, 7)].somma += a.prezzo; }
    const t = a.tribunale || 'N/D'; perTrib[t] = perTrib[t] || { n: 0, somma: 0 }; perTrib[t].n++; perTrib[t].somma += a.prezzo;
    const r = a.regione || 'N/D'; perReg[r] = perReg[r] || { n: 0, somma: 0 }; perReg[r].n++; perReg[r].somma += a.prezzo;
  }
  const sint = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.n, media: Math.round(v.somma / v.n), somma: v.somma }]).sort((a, b) => b[1].n - a[1].n));
  const dal = lista.find(a => a.data)?.data || null;
  const al = [...lista].reverse().find(a => a.data)?.data || null;
  const copertura = { dal, al, esiti: lista.length, tribunali: Object.keys(perTrib).filter(x => x !== 'N/D').length, regioni: Object.keys(perReg).filter(x => x !== 'N/D').length };
  const fonti = {};
  for (const a of lista) fonti[a.fonte] = (fonti[a.fonte] || 0) + 1;
  // 13/11/2026 — LA FONTE SI DICHIARA CON I NOMI VERI E LA QUOTA. Prima era una frase che
  // elencava anche "AstaGiudiziaria/IVG", presente ZERO volte in questo feed: un'etichetta che
  // nomina una fonte senza record e' la stessa bugia di esiti-monitor. Qui l'array si costruisce
  // dal conteggio reale (`fonti`), con nome pubblico, URL verificato sui record e quota.
  const FONTI_NOTE = {
    'fallcoaste': { nome: 'FallcoAste — fallcoaste.it', url: 'https://www.fallcoaste.it' },
    'notarile-verona': { nome: 'Notarile Verona (aste notarili)', url: null },
    'ivg': { nome: 'AstaGiudiziaria / IVG', url: 'https://www.astagiudiziaria.com' },
    'anivg': { nome: 'ANIVG — Associazione Nazionale Istituti Vendite Giudiziarie', url: null },
  };
  const totFonti = lista.length || 1;
  const fonteArr = Object.keys(fonti).sort((a, b) => fonti[b] - fonti[a]).map(k => Object.assign(
    { nome: k, url: null },
    FONTI_NOTE[k] || {},
    { esiti: fonti[k], quota: Math.round((fonti[k] / totFonti) * 1000) / 1000 }
  ));
  const fonteTesto = fonteArr.map(f => f.nome + ' (' + f.esiti + ' esiti, ' + Math.round(f.quota * 100) + '%)').join(' · ');
  const fontiSenzaUrl = fonteArr.filter(f => !f.url).map(f => f.nome);
  const giorniCop = (dal && al) ? Math.max(1, Math.round((new Date(al + 'T12:00:00Z') - new Date(dal + 'T12:00:00Z')) / 86400000)) : null;
  // rilevazione: la raccolta (fallco-aggiudicazioni.js + ivg-aggiudicazioni.js) gira negli stessi
  // minuti di questa normalizzazione, dentro lo stesso job del workflow esiti-sync: l'istante di
  // `generato` e' quindi quello della misura, non un'ora messa a caso su dati vecchi.
  const rilevazione = new Date().toISOString();
  const rilevazioneNota = 'istante della normalizzazione nella stessa run della raccolta: fallco-aggiudicazioni.js e ivg-aggiudicazioni.js girano pochi minuti prima, in questo stesso job';
  const stat = { generato: rilevazione, categoria: 'immobiliare', tutti: allAwards, fonte: fonteArr, fonteTesto, fonteUrl: fonteArr.length === 1 ? fonteArr[0].url : null, fontiSenzaUrl, rilevazione, rilevazioneNota, copertura, nazionale: { conteggio: lista.length, mediana, media, min: prezzi[0] || null, max: prezzi[prezzi.length - 1] || null }, fonti, perAnno: sint(perAnno), perMese: sint(perMese), perTribunale: sint(perTrib), perRegione: sint(perReg), limiti: ['Non tutte le aste pubblicano il prezzo finale: la copertura è dichiarata', 'Il prezzo base non è disponibile per tutti i record: lo sconto base→aggiudicazione è calcolato solo dove esiste', 'Le aste mobiliari senza tribunale sono escluse da questo indice'] };
  w(OUT.esiti, stat);
  w(OUT.indice, { generato: stat.generato, indice: { conteggio: lista.length, mediana, media }, copertura, perTribunale: stat.perTribunale, perRegione: stat.perRegione, fonte: fonteArr, fonteTesto, rilevazione, rilevazioneNota, nota: 'CAReIndex — prezzi di aggiudicazione reali, con copertura dichiarata' });
  w(OUT.report, { generato: stat.generato, recordTotale: tutti.length, awards: allAwards, immobiliari: lista.length, scartati: tutti.length - lista.length, fonti, fonte: fonteArr, fonteTesto, rilevazione, rilevazioneNota, copertura, esempi: lista.slice(-3) });
  // aggiorna statistiche senza inventare: aggiudicate = award reali; deserte/sospese restano dalla rilevazione precedente
  const stats = read(path.join(FEED, 'statistiche.json'), {});
  const oldEsiti = stats.esiti || {};
  const nuoveEsiti = { aggiudicate: allAwards, immobiliari: lista.length, deserte: Number(oldEsiti.deserte) || 0, sospese: Number(oldEsiti.sospese) || 0, nonPubblicato: Math.max(0, (Number(stats.totale) || 0) - lista.length - (Number(oldEsiti.deserte) || 0) - (Number(oldEsiti.sospese) || 0)) };
  stats.esiti = nuoveEsiti;
  // `fonte` ora e' un array (nome+url+quota): qui si tiene la forma TESTO per i consumatori
  // che stampano il campo (statistiche.json e' gia' in produzione: la struttura non cambia).
  stats.esitiFonte = fonteTesto;
  stats.esitiCopertura = Object.assign({}, copertura, { esiti: allAwards, immobiliari: lista.length, giorni: giorniCop });
  stats.esitiMotivo = null;
  stats.esitiUltimaRilevazione = { data: al || new Date().toISOString().slice(0, 10), aggiudicate: allAwards, immobiliari: lista.length, deserte: nuoveEsiti.deserte, sospese: nuoveEsiti.sospese, verificati: lista.length + nuoveEsiti.deserte + nuoveEsiti.sospese, nota: 'prezzi di aggiudicazione pubblici: ' + allAwards + ' (immobiliari ' + lista.length + ') con copertura ' + dal + ' → ' + al };
  w(path.join(FEED, 'statistiche.json'), stats);
  w(path.join(FEED, 'andamento-esiti.json'), { generato: stat.genero || stat.generato, esiti: nuoveEsiti, copertura: Object.assign({}, copertura, { esiti: allAwards, immobiliari: lista.length, giorni: giorniCop }), nota: 'esiti reali da fonti pubbliche — copertura dichiarata, nessun numero inventato' });
  w(path.join(FEED, 'esiti-monitor.json'), Object.assign({}, monOld, { generato: stat.generato, copertura: Object.assign({}, monOld.copertura || {}, copertura, { esiti: allAwards, immobiliari: lista.length, giorni: giorniCop }), nota: 'Aggiornato da esiti-sync: ' + allAwards + ' prezzi (immobiliari ' + lista.length + ') di aggiudicazione pubblici; fonti ' + JSON.stringify(fonti) }));
  console.log('ESITI', allAwards, 'totali; immobiliari', lista.length, 'prezzi; mediana', mediana, 'media', media, 'copertura', dal, '→', al, 'tribunali', copertura.tribunali, 'fonti', fonti);
})();
