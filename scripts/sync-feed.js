// scripts/sync-feed.js — sincronizzazione automatica del feed (GitHub Actions, costo 0, niente Mac)
// MODE=inc (ogni 15 min): raccoglie le prime 40 pagine PVP (le più recenti) e aggiunge i lotti nuovi al feed.
// MODE=full (ogni notte 01:00 UTC): raccolta completa PVP e ricostruzione del feed (nuove dentro, scadute fuori).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { fileDaCancellare, scegliEsiti, FONTI_PUBBLICHE } = require('./feed-regole');
const { ricalcolaPartecipazione } = require('./andamento-partecipazione');

const MODE = process.env.MODE || 'inc';
const PAGINE = MODE === 'full' ? 99999 : 40;
const SIZE = 100;

const PROV = {
  TORINO:'Piemonte',VERCELLI:'Piemonte',NOVARA:'Piemonte',CUNEO:'Piemonte',ASTI:'Piemonte',ALESSANDRIA:'Piemonte',BIELLA:'Piemonte','VERBANO-CUSIO-OSSOLA':'Piemonte',VERBANIA:'Piemonte',
  AOSTA:'Valle d Aosta','VALLE D AOSTA':'Valle d Aosta',
  MILANO:'Lombardia','MONZA E DELLA BRIANZA':'Lombardia','MONZA BRIANZA':'Lombardia',COMO:'Lombardia',VARESE:'Lombardia',LECCO:'Lombardia',SONDRIO:'Lombardia',BERGAMO:'Lombardia',BRESCIA:'Lombardia',PAVIA:'Lombardia',CREMONA:'Lombardia',MANTOVA:'Lombardia',LODI:'Lombardia',
  TRENTO:'Trentino-Alto Adige',BOLZANO:'Trentino-Alto Adige',BOZEN:'Trentino-Alto Adige',
  VENEZIA:'Veneto',VERONA:'Veneto',VICENZA:'Veneto',PADOVA:'Veneto',TREVISO:'Veneto',BELLUNO:'Veneto',ROVIGO:'Veneto',
  UDINE:'Friuli-Venezia Giulia',TRIESTE:'Friuli-Venezia Giulia',GORIZIA:'Friuli-Venezia Giulia',PORDENONE:'Friuli-Venezia Giulia',
  GENOVA:'Liguria',IMPERIA:'Liguria',SAVONA:'Liguria','LA SPEZIA':'Liguria',
  BOLOGNA:'Emilia-Romagna',MODENA:'Emilia-Romagna','REGGIO EMILIA':'Emilia-Romagna',"REGGIO NELL'EMILIA":'Emilia-Romagna',PARMA:'Emilia-Romagna',PIACENZA:'Emilia-Romagna',FERRARA:'Emilia-Romagna',RAVENNA:'Emilia-Romagna','FORLI-CESENA':'Emilia-Romagna',RIMINI:'Emilia-Romagna',
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
  CAGLIARI:'Sardegna',SASSARI:'Sardegna',NUORO:'Sardegna',ORISTANO:'Sardegna','SUD SARDEGNA':'Sardegna','CARBONIA-IGLESIAS':'Sardegna','MEDIO CAMPIDANO':'Sardegna',OGLIASTRA:'Sardegna'
};
const SLUG_REG = {'Emilia-Romagna':'emilia-romagna','Friuli-Venezia Giulia':'friuli-venezia-giulia','Trentino-Alto Adige':'trentino-alto-adige','Valle d Aosta':'valle-d-aosta'};
const slug = r => SLUG_REG[r] || r.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
const norm = s => String(s||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/['\u2019]/g,"'").trim();
const regioneDi = p => PROV[norm(p)] || PROV[norm(p).replace(/'/g,'')] || 'Italia';

function get1(url){return new Promise(res=>{const u=new URL(url);const r=https.request({host:u.hostname,path:u.pathname+u.search,method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 (compatible; careauctions-feed/1.0)','Accept':'application/json'}},x=>{let t='';x.on('data',c=>t+=c);x.on('end',()=>res({s:x.statusCode,t}));});r.on('error',()=>res({s:0,t:''}));r.setTimeout(30000,()=>{r.destroy();res({s:0,t:''});});r.write('{}');r.end();});}
const dormi = ms => new Promise(s=>setTimeout(s,ms));

// 5.971 — RETRY DI RETE: una pagina che fallisce non si salta piu' in silenzio
// (era la causa dei ~4.300 lotti mancanti: alcune delle 3.264 pagine tornavano errore).
async function get(url){
  for (let k = 0; k < 4; k++) {
    const r = await get1(url);
    if (r && r.s === 200) return r;
    await dormi(500 * (k + 1));
  }
  return { s: 0, t: '' };
}

// MAPPER-5.9xx: i 15 campi storici restano identici (l'app li legge così); in coda ai campi
// arrivano i campi di mercato che il PVP espone già e che prima buttavamo via. Nomi brevi,
// e la chiave viene scritta SOLO se il dato esiste davvero (niente zeri o stringhe vuote inventate).
function mappa(x){
  const prov=(x.indirizzo&&x.indirizzo.provincia)||''; const citta=(x.indirizzo&&x.indirizzo.citta)||'';
  const base=Number(x.prezzoBaseAsta)||0; const minima=Number(x.offertaMinima)||0;
  let scartoBaseMinima=base>0?Math.round((1-minima/base)*100):0; if(scartoBaseMinima<0)scartoBaseMinima=0; if(scartoBaseMinima>99)scartoBaseMinima=99;
  const disp=Array.isArray(x.disponibilita)?x.disponibilita.join(','):String(x.disponibilita||'');
  const o = { id:String(x.id), tipo:String(x.tipoLotto||'').indexOf('IMMOBIL')>=0?'IMMOBILIARE':'MOBILIARE',
    pubblicazione:x.dataPubblicazione||'', titolo:((x.categoriaBene&&x.categoriaBene[0])||String(x.categoriaLotto||''))+' · '+citta+' ('+prov+')',
    prezzoBase:base, minima, scontoPct:scartoBaseMinima, scartoBaseMinimaPct:scartoBaseMinima, dataAsta:x.dataVendita||'', regione:regioneDi(prov), citta,
    tribunale:x.tribunale||'', occupazione:/OCCUP/.test(disp)?'OCCUPATO':'LIBERO',
    link:'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio='+x.id, foto:x.immagineCover||x.immagine||'',
    documenti:[{tipo:'pagina ufficiale',url:'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio='+x.id}],
    descrizione:String(x.descLotto||'').slice(0,500) };
  // --- campi di mercato (nostri, per le statistiche) ---
  // cat: tutte le categorie bene (di solito una) separate da | — es. "APPARTAMENTO|BOX_AUTORIMESSA"
  const cat=(Array.isArray(x.categoriaBene)?x.categoriaBene:[x.categoriaBene]).filter(v=>v!=null&&v!=='').map(String);
  if(cat.length) o.cat=cat.join('|');
  // proc: identificativo della procedura esecutiva/concorsuale (numero interno PVP, non il numero di ruolo)
  if(x.procedura!=null&&x.procedura!=='') o.proc=String(x.procedura);
  // num: numero del lotto dentro la procedura (es. "4")
  if(x.numeroLotto!=null&&x.numeroLotto!=='') o.num=String(x.numeroLotto);
  // rialzo: rialzo minimo d'asta in euro, come lo pubblica il PVP
  const ri=Number(x.rialzoMinimo); if(x.rialzoMinimo!=null&&x.rialzoMinimo!==''&&isFinite(ri)) o.rialzo=ri;
  // disp: disponibilità (stato di occupazione) senza i doppioni che il PVP ripete — es. "LIBER" / "OCCUP"
  const dispU=[...new Set((Array.isArray(x.disponibilita)?x.disponibilita:[x.disponibilita]).filter(v=>v!=null&&v!=='').map(String))];
  if(dispU.length) o.disp=dispU.join('|');
  // ora: orario di vendita HH:MM (serve alla distribuzione per ora)
  if(x.orarioVendita) o.ora=String(x.orarioVendita).slice(0,5);
  // esito: AGGIU / ASDES / SOSPE / DESER ... solo se il PVP lo pubblica (spesso è null)
  if(x.esito) o.esito=String(x.esito);
  // lat/lon: coordinate dell'immobile (dedotte dalla toponomastica, non dal catasto)
  const co=x.indirizzo&&x.indirizzo.coordinate;
  if(co&&co.latitudine!=null&&co.longitudine!=null){
    const la=Number(co.latitudine), lo=Number(co.longitudine);
    if(isFinite(la)&&isFinite(lo)&&la!==0&&lo!==0){ o.lat=Number(la.toFixed(5)); o.lon=Number(lo.toFixed(5)); }
  }
  return o;
}

// il corpo resta identico: è solo incapsulato in main() così statistiche-mercato.js può
// riusare lo STESSO mappa() invece di duplicarne una copia che poi diverge.
async function main(){
  console.log('sync-feed MODE='+MODE);
  const pagine=[];
  let totAtteso=0; // totAtteso-tdz-fix 5.844: dichiarata prima dell uso nel blocco full
  if(MODE==='full'){
    const p0=await get('https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite?page=0&size='+SIZE+'&language=it&sort=dataOraVendita%2Cdesc');
    let tot=0; try{ tot=JSON.parse(p0.t).body.totalElements||0; }catch(e){}
    totAtteso=tot;
    console.log('totalElements:',tot);
    for(let p=0;p<Math.ceil(tot/SIZE);p++) pagine.push(p);
  } else {
    for(let p=0;p<PAGINE;p++) pagine.push(p);
  }
  const lotti=[]; const visti=new Set(); const esitiAcc={aggiudicate:0,deserte:0,sospese:0,nonPubblicato:0};
  for(let i=0;i<pagine.length;i+=2){
    const [a,b]=await Promise.all([get('https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite?page='+pagine[i]+'&size='+SIZE+'&language=it&sort=dataOraVendita%2Cdesc'), pagine[i+1]!==undefined?get('https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite?page='+pagine[i+1]+'&size='+SIZE+'&language=it&sort=dataOraVendita%2Cdesc'):Promise.resolve({s:0,t:''})]);
    for(const r of [a,b]){ if(r.s===200){ try{ const j=JSON.parse(r.t); if(j.body&&Array.isArray(j.body.content)) for(const x of j.body.content){ if(x&&x.id!=null&&!visti.has(String(x.id))){ visti.add(String(x.id)); const tL=String(x.tipoLotto||''); if(tL==='IMMOBILI'||tL==='MOBILI') lotti.push(mappa(x)); const es=String(x.esito||''); if(es==='AGGIU')esitiAcc.aggiudicate++; else if(es==='ASDES')esitiAcc.deserte++; else if(es==='SOSPE')esitiAcc.sospese++; else esitiAcc.nonPubblicato++; } } }catch(e){} } }
    await dormi(200);
    if(lotti.length&&lotti.length%2000===0) console.log('raccolti:',lotti.length);
  }
  console.log('lotti raccolti (questo giro):',lotti.length);

  const FEED=path.join(__dirname,'..','feed');
  const indice=JSON.parse(fs.readFileSync(path.join(FEED,'indice.json'),'utf8'));
  const esistenti=new Set();
  const nuoviIds=new Set();
  for(const r of Object.keys(indice.regioni)){
    for(const f of [...(indice.regioni[r].filesImm||[]),...(indice.regioni[r].filesMob||[])]){ try{ const j=JSON.parse(fs.readFileSync(path.join(FEED,f),'utf8')); for(const x of j) esistenti.add(String(x.id)); }catch(e){} }
  for(const a of lotti) nuoviIds.add(String(a.id));
  }
  let nuovi=0;
  const daAggiungere={};
  const esitiCambiati={};
  for(const a of lotti){
    if(!esistenti.has(a.id)){ (daAggiungere[a.regione]=daAggiungere[a.regione]||{imm:[],mob:[]})[a.tipo==='IMMOBILIARE'?'imm':'mob'].push(a); nuovi++; }
    else if(a.esito && a.esito!==undefined) esitiCambiati[a.id]=a.esito;
  }
  let esitiAggiornati=0;
  if(Object.keys(esitiCambiati).length){ for(const [r,g] of Object.entries(indice.regioni||{})){ const files=[...(g.filesImm||[]),...(g.filesMob||[])]; let toc=0; for(const f of files){ try{ const arr=JSON.parse(fs.readFileSync(path.join(FEED,f),'utf8')); let camb=0; for(const x of arr){ if(esitiCambiati[x.id]!==undefined && (x.esito||'')!==esitiCambiati[x.id]){ x.esito=esitiCambiati[x.id]; camb++; } } if(camb){ fs.writeFileSync(path.join(FEED,f),JSON.stringify(arr)); toc+=camb; } }catch(e){} } if(toc){ esitiAggiornati+=toc; } } console.log('esiti aggiornati in questo giro:',esitiAggiornati); }
  console.log('nuovi da inserire:',nuovi);
  if (esistenti.size === 0 && lotti.length < 300000) { console.log('ABORT: base feed vuota (' + esistenti.size + ' esistenti, ' + lotti.length + ' raccolti) — serve il ripristino completo'); process.exit(2); }
  if (lotti.length === 0) { console.log('ABORT: nessun lotto raccolto in questo giro — nessuna scrittura'); process.exit(0); }

  if(MODE==='full'){
    if (totAtteso > 0 && lotti.length < totAtteso * 0.95) { console.log('ABORT: raccolta incompleta ' + lotti.length + '/' + totAtteso + ' — nessun file toccato'); process.exit(2); }
    // ricostruzione completa (come pvp-feed.js): i file vengono riscritti con TUTTI i lotti raccolti
    const perReg={};
    for(const a of lotti) (perReg[a.regione]=perReg[a.regione]||{imm:[],mob:[]})[a.tipo==='IMMOBILIARE'?'imm':'mob'].push(a);
    // B — 6/11/2026: la ricostruzione completa rigenera i file di regione dal PVP, ma NON
    // cancella la storia: andamento-esiti.json e' una rilevazione datata (non si ricalcola),
    // andamento-prezzi.json e andamento-partecipazione.json sono serie storiche. Se li
    // cancellasse, il giorno che il full completa perderemmo la memoria del progetto.
    // L'elenco protetto sta in scripts/feed-regole.js (PROTETTI_FEED).
    // 9/11/2026 — si cancella SOLO cio' che l'indice vecchio elenca: i file di regione
    // che stiamo per riscrivere. Prima era "tutto tranne i protetti" e il full delle
    // 01:58 ha portato via 39 file, compresi 10 feed di altri workflow (404 per ore).
    for(const f of fileDaCancellare(FEED, indice)) fs.unlinkSync(path.join(FEED,f));
    indice.totali=lotti.length; indice.immobiliari=0; indice.mobiliari=0; indice.regioni={};
    for(const [r,g] of Object.entries(perReg)){
      const s=slug(r); const filesImm=[],filesMob=[];
      const chunk=(arr,pref,files)=>{ const N=Math.ceil(arr.length/4000)||1;
        if(N===1){ files.push(pref+'.json'); fs.writeFileSync(path.join(FEED,pref+'.json'),JSON.stringify(arr)); return; }
        for(let i=0;i<N;i++){ const nome=pref+'-'+(i+1)+'.json'; files.push(nome); fs.writeFileSync(path.join(FEED,nome),JSON.stringify(arr.slice(i*4000,(i+1)*4000))); } };
      chunk(g.imm,s+'-imm',filesImm); chunk(g.mob,s+'-mob',filesMob);
      indice.immobiliari+=g.imm.length; indice.mobiliari+=g.mob.length;
      indice.regioni[r]={totale:g.imm.length+g.mob.length,immobiliari:g.imm.length,mobiliari:g.mob.length,filesImm,filesMob};
    }
  } else {
    // incrementale: append dei nuovi nelle regioni + re-chunk
    for(const [r,g] of Object.entries(daAggiungere)){
      indice.regioni[r]=indice.regioni[r]||{filesImm:[],filesMob:[],immobiliari:0,mobiliari:0,totale:0};
      const s=slug(r);
      for(const [tipo,arr] of [['imm',g.imm],['mob',g.mob]]){
        if(!arr.length) continue;
        const reg=indice.regioni[r]||{filesImm:[],filesMob:[]};
        const files=tipo==='imm'?reg.filesImm:reg.filesMob;
        let contenuto=[];
        for(const f of files){ try{ contenuto.push(...JSON.parse(fs.readFileSync(path.join(FEED,f),'utf8'))); }catch(e){} }
        for(const f of files){ try{ fs.unlinkSync(path.join(FEED,f)); }catch(e){} }
        contenuto.push(...arr);
        const pref=s+'-'+tipo; const nuoviFiles=[]; const N=Math.ceil(contenuto.length/4000)||1;
        if(N===1){ nuoviFiles.push(pref+'.json'); fs.writeFileSync(path.join(FEED,pref+'.json'),JSON.stringify(contenuto)); }
        else for(let i=0;i<N;i++){ const nome=pref+'-'+(i+1)+'.json'; nuoviFiles.push(nome); fs.writeFileSync(path.join(FEED,nome),JSON.stringify(contenuto.slice(i*4000,(i+1)*4000))); }
        if(tipo==='imm') indice.regioni[r].filesImm=nuoviFiles; else indice.regioni[r].filesMob=nuoviFiles;
        const im=(indice.regioni[r].immobiliari||0)+(tipo==='imm'?arr.length:0);
        const mb=(indice.regioni[r].mobiliari||0)+(tipo==='mob'?arr.length:0);
        indice.regioni[r].immobiliari=im; indice.regioni[r].mobiliari=mb; indice.regioni[r].totale=im+mb;
        indice.immobiliari+=(tipo==='imm'?arr.length:0); indice.mobiliari+=(tipo==='mob'?arr.length:0);
      }
    }
    // monitoraggio retention PVP: quanti lotti spariscono a ogni giro completo
  const rimossi = [...esistenti].filter(id => !nuoviIds.has(id)).length;
  console.log('rimossi da PVP in questo giro completo:', rimossi);
  indice.totali=esistenti.size+nuovi;
  }
  fs.writeFileSync(path.join(FEED,'indice.json'),JSON.stringify(indice));
  console.log('indice aggiornato: totali',indice.totali,'(nuovi inseriti:',nuovi+')');
  // ESITI RITIRATI — C, 6/11/2026: toglie gli esiti scritti su un incrocio per id non valido
  // (id di portale, non idAnnuncio del PVP). Registro: feed/esiti-ritirati.json. Passata unica,
  // dopo la scrittura dei file di regione e PRIMA dei contatori, cosi' non tornano nemmeno
  // dopo una ricostruzione completa. Il registro resta (non viene cancellato dal full).
  try { require('./esiti-ritirati').applicaEsitiRitirati(FEED, indice, console.log); }
  catch (e) { console.log('esiti ritirati: errore', e.message); }
  // INDICE-COMPLETO (statistiche vive per il CARe Index: totali, prezzi medi, sconti, bande)
  try {
    const tutti=[];
    for(const r of Object.keys(indice.regioni)){
      for(const f of [...(indice.regioni[r].filesImm||[]),...(indice.regioni[r].filesMob||[])]){ try{ tutti.push(...JSON.parse(fs.readFileSync(path.join(FEED,f),'utf8'))); }catch(e){} }
    }
    const med=(arr)=>arr.length?{prezzo:Math.round(arr.reduce((s,a)=>s+(a.prezzoBase||0),0)/arr.length),scartoBaseMinima:Math.round(arr.reduce((s,a)=>s+(a.scartoBaseMinimaPct!=null?a.scartoBaseMinimaPct:(a.scontoPct||0)),0)/arr.length)}:{prezzo:0,scartoBaseMinima:0};
    const imm=tutti.filter(a=>a.tipo==='IMMOBILIARE'); const mob=tutti.filter(a=>a.tipo!=='IMMOBILIARE');
    const mi=med(imm), mm=med(mob);
    const bande={'fino_25k':0,'25_50k':0,'50_100k':0,'100_200k':0,'oltre_200k':0};
    for(const a of imm){ const b=a.prezzoBase||0; if(b<=25000)bande['fino_25k']++; else if(b<=50000)bande['25_50k']++; else if(b<=100000)bande['50_100k']++; else if(b<=200000)bande['100_200k']++; else bande['oltre_200k']++; }
    const perRegione={};
    for(const r of Object.keys(indice.regioni)){
      const arr=tutti.filter(a=>a.regione===r); const m=med(arr);
      perRegione[r]={lotti:arr.length,prezzoMedio:m.prezzo,scartoBaseMinimaMedio:m.scartoBaseMinima};
    }
    const completo={ data:new Date().toISOString().slice(0,10), totaleLotti:tutti.length,
      settori:{ immobiliare:{lotti:imm.length,prezzoMedio:mi.prezzo,scartoBaseMinimaMedio:mi.scartoBaseMinima,categorie:{IMMOBILIARE:imm.length}},
                mobiliare:{lotti:mob.length,prezzoMedio:mm.prezzo,scartoBaseMinimaMedio:mm.scartoBaseMinima,categorie:{MOBILIARE:mob.length}} },
      bandePrezzo:bande, perRegione };
    fs.writeFileSync(path.join(FEED,'indice-completo.json'),JSON.stringify(completo));
    console.log('indice-completo aggiornato: totaleLotti',tutti.length,'prezzoMedio imm',mi.prezzo,'scartoBaseMinimaMedio',mi.scartoBaseMinima);
  } catch(e){ console.log('indice-completo: errore',e.message); }

  try {
    // FIX 31/10: ic va letto SUBITO (era usato prima della dichiarazione: TDZ → statistiche e andamenti fermi al giorno prima)
    const ic = JSON.parse(fs.readFileSync(path.join(FEED, 'indice-completo.json'), 'utf8'));
    // C — 6/11/2026: si pubblica solo una misura VIVA e DATATA. Se la rilevazione degli esiti
    // (feed/andamento-esiti.json) e' piu' vecchia di 7 giorni NON si ricopia: esiti:null con il
    // motivo. I numeri della vecchia rilevazione restano in esitiUltimaRilevazione, con la data
    // e la riserva, cosi' il sito puo' dire "fonte in verifica" invece di fingere un dato vivo.
    // (Prima, riga 220, il 2.183 del 30/10 veniva ricopiato a ogni run: sembrava aggiornato.)
    let canoneEsiti = null;
    try { canoneEsiti = JSON.parse(fs.readFileSync(path.join(FEED, 'andamento-esiti.json'), 'utf8')); } catch (eCan) {}
    const sceltaEsiti = scegliEsiti({ modo: MODE, esitiAcc, canone: canoneEsiti });
    const esitiFinali = sceltaEsiti.esiti;
    const esitiMotivo = sceltaEsiti.motivo || null;
    let esitiUltimaRilevazione = null;
    if (sceltaEsiti.rilevazione) {
      const r = sceltaEsiti.rilevazione;
      const verificati = (Number(r.aggiudicate) || 0) + (Number(r.deserte) || 0) + (Number(r.sospese) || 0);
      const lotti = ic.totaleLotti || 0;
      const pct = lotti ? Math.round((verificati / lotti) * 1000) / 10 : null;
      const [aa, mm, gg] = String(r.data || '').split('-');
      const dataIt = (gg && mm && aa) ? (gg + '/' + mm + '/' + aa) : String(r.data || '?');
      esitiUltimaRilevazione = {
        data: r.data, aggiudicate: r.aggiudicate, deserte: r.deserte, sospese: r.sospese,
        verificati, lotti, percentuale: pct, stato: 'fonte in verifica',
        nota: 'esiti verificati: ' + verificati.toLocaleString('it-IT') + ' su ' + lotti.toLocaleString('it-IT') +
          ' lotti (' + String(pct).replace('.', ',') + '%) — rilevazione del ' + dataIt + ', fonte in verifica'
      };
    }
    if (MODE === 'full' && sceltaEsiti.scriviCanone) {
      // giro completo: gli esiti contati sono la verità del giorno → aggiorna il file canonico
      fs.writeFileSync(path.join(FEED, 'andamento-esiti.json'), JSON.stringify({ generato: new Date().toISOString(), esiti: esitiAcc, nota: 'esiti reali delle aste italiane — nessun numero inventato' }));
    }
    // PERDATA-5.836: conta le aste per dataAsta (passate / oggi / prossime)
    let passate = 0, future = 0, oggi = 0, prossimi30 = 0, prossimi90 = 0;
    try {
      const oggiS = new Date().toISOString().slice(0, 10);
      const t30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const t90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      for (const r of Object.keys(indice.regioni)) {
        for (const f of [...(indice.regioni[r].filesImm || []), ...(indice.regioni[r].filesMob || [])]) {
          try { for (const x of JSON.parse(fs.readFileSync(path.join(FEED, f), 'utf8'))) {
            const d = String(x.dataAsta || '').slice(0, 10);
            if (!d) continue;
            if (d < oggiS) passate++; else if (d === oggiS) oggi++; else { future++; if (d <= t30) prossimi30++; if (d <= t90) prossimi90++; }
          } } catch (eX) {}
        }
      }
    } catch (eP) {}
    const perData = { passate, future, oggi, prossimi30, prossimi90, totale: passate + future + oggi };
    // STORICO-5.852: l archivio giornaliero del prezzo medio (per il grafico CAReIndex)
    let storico = [];
    try { storico = (JSON.parse(fs.readFileSync(path.join(FEED, 'andamento-prezzi.json'), 'utf8')) || {}).giorni || []; } catch (eS) {}
    const oggiD = new Date().toISOString().slice(0, 10);
    storico = storico.filter(x => x && x.data && x.data !== oggiD);
    storico.push({ data: oggiD, totale: ic.totaleLotti, prezzoMedio: Math.round(ic.settori.immobiliare.prezzoMedio || 0), scartoBaseMinimaMedio: Math.round(ic.settori.immobiliare.scartoBaseMinimaMedio || 0) });
    storico = storico.slice(-730); // 5.860: 2 anni di storia, per sempre
    fs.writeFileSync(path.join(FEED, 'andamento-prezzi.json'), JSON.stringify({ generato: new Date().toISOString(), giorni: storico }));
    // A — 6/11/2026: la partecipazione si RICALCOLA da zero dai lotti di ogni giorno
    // (scripts/andamento-partecipazione.js). Prima si partiva dai giorni gia' in archivio e si
    // incrementava: a ogni run (~3-5 min) si riaggiungeva il catalogo intero, fino a una somma
    // di ~177 milioni, ~542 volte i 324k lotti. Un giorno senza lotti resta vuoto: mai stimato.
    try { ricalcolaPartecipazione(FEED, indice, { log: console.log }); }
    catch (eP3) { console.log('partecipazione: errore', eP3.message); }
    // 5.914: "aggiornato" ISO con l'ora esatta — il guardiano calcola le ore di stallo da qui (2 ore = fermo).
    const statOut = { generato: new Date().toISOString().slice(0, 10), aggiornato: new Date().toISOString(), totale: ic.totaleLotti, prezzoMedioImm: ic.settori.immobiliare.prezzoMedio, scartoBaseMinimaMedioImm: ic.settori.immobiliare.scartoBaseMinimaMedio, bandePrezzo: ic.bandePrezzo, esiti: esitiFinali, perData, nota: 'statistiche vive dal giro automatico — nessun numero inventato' };
    // 13/11/2026 — figura sweep: la fonte PUBBLICA e la data di rilevazione stanno DENTRO il feed.
    // `rilevazione` è l'istante della raccolta: si riusa `aggiornato` (stesso giro, stessa misura).
    // Un numero senza fonte e data non si pubblica: il sito nasconde ciò che il feed non dichiara.
    statOut.fonte = FONTI_PUBBLICHE.pvp;
    statOut.rilevazione = statOut.aggiornato;
    if (esitiMotivo) statOut.esitiMotivo = esitiMotivo;
    if (esitiUltimaRilevazione) statOut.esitiUltimaRilevazione = esitiUltimaRilevazione;
    fs.writeFileSync(path.join(FEED, 'statistiche.json'), JSON.stringify(statOut));
    console.log('statistiche.json sempre aggiornato');
  } catch (eS) { console.log('statistiche: errore', eS.message); }
  if(MODE==='full'){
    try {
      const candidates = ['https://model-office-pvp.giustizia.it/ve-3f723b85-986a1b71/ve-ms/vendite/esiti?page=0&size=100','https://model-office-pvp.giustizia.it/ve-3f723b85-986a1b71/ve-ms/esiti?page=0&size=100'];
      let aggiudicazioni = null;
      for (const u of candidates) {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; careauctions-feed/1.0)', 'Accept': 'application/json' } });
        if (r.ok) { const j = await r.json(); const arr = j && (j.body || j.content || j); if (Array.isArray(arr) && arr.length) { aggiudicazioni = arr; break; } }
      }
      // 9/11/2026 - non si sovrascrive piu' l'archivio dei prezzi (era la terza penna sullo
      // stesso foglio: sync-feed, fallco, IVG). Si UNISCE per fonte|id: scripts/aggiudicazioni-merge.js.
      if (aggiudicazioni) {
        const { mergeRecords } = require('./aggiudicazioni-merge');
        const voci = aggiudicazioni.slice(0, 2000).map(a => (a && a.fonte ? a : Object.assign({ fonte: 'pvp' }, a)));
        mergeRecords(path.join(FEED, 'aggiudicazioni.json'), voci, { log: console.log });
      }
      console.log('esiti/prezzi aggiudicazione:', aggiudicazioni ? 'TROVATI (' + aggiudicazioni.length + ')' : 'non disponibili stasera — riprovo ogni notte');
    } catch (eE) { console.log('esiti: errore', eE.message); }
  }

}

if (require.main === module) main().catch(e=>{ console.error('FATALE',e); process.exit(1); });
module.exports = { mappa };
