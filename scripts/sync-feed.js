// scripts/sync-feed.js — sincronizzazione automatica del feed (GitHub Actions, costo 0, niente Mac)
// MODE=inc (ogni 15 min): raccoglie le prime 40 pagine PVP (le più recenti) e aggiunge i lotti nuovi al feed.
// MODE=full (ogni notte 01:00 UTC): raccolta completa PVP e ricostruzione del feed (nuove dentro, scadute fuori).
const fs = require('fs');
const path = require('path');
const https = require('https');

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

function get(url){return new Promise(res=>{const u=new URL(url);const r=https.request({host:u.hostname,path:u.pathname+u.search,method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 (compatible; careauctions-feed/1.0)','Accept':'application/json'}},x=>{let t='';x.on('data',c=>t+=c);x.on('end',()=>res({s:x.statusCode,t}));});r.on('error',()=>res({s:0,t:''}));r.setTimeout(30000,()=>{r.destroy();res({s:0,t:''});});r.write('{}');r.end();});}
const dormi = ms => new Promise(s=>setTimeout(s,ms));

function mappa(x){
  const prov=(x.indirizzo&&x.indirizzo.provincia)||''; const citta=(x.indirizzo&&x.indirizzo.citta)||'';
  const base=Number(x.prezzoBaseAsta)||0; const minima=Number(x.offertaMinima)||0;
  let sconto=base>0?Math.round((1-minima/base)*100):0; if(sconto<0)sconto=0; if(sconto>99)sconto=99;
  const disp=Array.isArray(x.disponibilita)?x.disponibilita.join(','):String(x.disponibilita||'');
  return { id:String(x.id), tipo:String(x.tipoLotto||'').indexOf('IMMOBIL')>=0?'IMMOBILIARE':'MOBILIARE',
    pubblicazione:x.dataPubblicazione||'', titolo:((x.categoriaBene&&x.categoriaBene[0])||String(x.categoriaLotto||''))+' · '+citta+' ('+prov+')',
    prezzoBase:base, minima, scontoPct:sconto, dataAsta:x.dataVendita||'', regione:regioneDi(prov), citta,
    tribunale:x.tribunale||'', occupazione:/OCCUP/.test(disp)?'OCCUPATO':'LIBERO',
    link:'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio='+x.id, foto:x.immagineCover||x.immagine||'',
    documenti:[{tipo:'pagina ufficiale',url:'https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio='+x.id}],
    descrizione:String(x.descLotto||'').slice(0,500) };
}

(async()=>{
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
    for(const f of fs.readdirSync(FEED)) if(f.endsWith('.json')&&f!=='indice.json'&&f!=='indice-completo.json'&&f!=='ore-aste.json') fs.unlinkSync(path.join(FEED,f));
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
  // INDICE-COMPLETO (statistiche vive per il CARe Index: totali, prezzi medi, sconti, bande)
  try {
    const tutti=[];
    for(const r of Object.keys(indice.regioni)){
      for(const f of [...(indice.regioni[r].filesImm||[]),...(indice.regioni[r].filesMob||[])]){ try{ tutti.push(...JSON.parse(fs.readFileSync(path.join(FEED,f),'utf8'))); }catch(e){} }
    }
    const med=(arr)=>arr.length?{prezzo:Math.round(arr.reduce((s,a)=>s+(a.prezzoBase||0),0)/arr.length),sconto:Math.round(arr.reduce((s,a)=>s+(a.scontoPct||0),0)/arr.length)}:{prezzo:0,sconto:0};
    const imm=tutti.filter(a=>a.tipo==='IMMOBILIARE'); const mob=tutti.filter(a=>a.tipo!=='IMMOBILIARE');
    const mi=med(imm), mm=med(mob);
    const bande={'fino_25k':0,'25_50k':0,'50_100k':0,'100_200k':0,'oltre_200k':0};
    for(const a of imm){ const b=a.prezzoBase||0; if(b<=25000)bande['fino_25k']++; else if(b<=50000)bande['25_50k']++; else if(b<=100000)bande['50_100k']++; else if(b<=200000)bande['100_200k']++; else bande['oltre_200k']++; }
    const perRegione={};
    for(const r of Object.keys(indice.regioni)){
      const arr=tutti.filter(a=>a.regione===r); const m=med(arr);
      perRegione[r]={lotti:arr.length,prezzoMedio:m.prezzo,scontoMedio:m.sconto};
    }
    const completo={ data:new Date().toISOString().slice(0,10), totaleLotti:tutti.length,
      settori:{ immobiliare:{lotti:imm.length,prezzoMedio:mi.prezzo,scontoMedio:mi.sconto,categorie:{IMMOBILIARE:imm.length}},
                mobiliare:{lotti:mob.length,prezzoMedio:mm.prezzo,scontoMedio:mm.sconto,categorie:{MOBILIARE:mob.length}} },
      bandePrezzo:bande, perRegione };
    fs.writeFileSync(path.join(FEED,'indice-completo.json'),JSON.stringify(completo));
    console.log('indice-completo aggiornato: totaleLotti',tutti.length,'prezzoMedio imm',mi.prezzo,'scontoMedio',mi.sconto);
  } catch(e){ console.log('indice-completo: errore',e.message); }

  try {
    let esitiFinali = esitiAcc;
    if (MODE !== 'full') { try { const prec = JSON.parse(fs.readFileSync(path.join(FEED, 'statistiche.json'), 'utf8')); if (prec && prec.esiti) esitiFinali = prec.esiti; } catch (ePrev) {} }
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
    storico.push({ data: oggiD, totale: ic.totaleLotti, prezzoMedio: Math.round(ic.settori.immobiliare.prezzoMedio || 0), scontoMedio: Math.round(ic.settori.immobiliare.scontoMedio || 0) });
    storico = storico.slice(-120);
    fs.writeFileSync(path.join(FEED, 'andamento-prezzi.json'), JSON.stringify({ generato: new Date().toISOString(), giorni: storico }));
    const ic = JSON.parse(fs.readFileSync(path.join(FEED, 'indice-completo.json'), 'utf8'));
    fs.writeFileSync(path.join(FEED, 'statistiche.json'), JSON.stringify({ generato: new Date().toISOString().slice(0, 10), totale: ic.totaleLotti, prezzoMedioImm: ic.settori.immobiliare.prezzoMedio, scontoMedioImm: ic.settori.immobiliare.scontoMedio, bandePrezzo: ic.bandePrezzo, esiti: esitiFinali, perData, nota: 'statistiche vive dal giro automatico — nessun numero inventato' }));
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
      if (aggiudicazioni) fs.writeFileSync(path.join(FEED, 'aggiudicazioni.json'), JSON.stringify(aggiudicazioni.slice(0, 2000)));
      console.log('esiti/prezzi aggiudicazione:', aggiudicazioni ? 'TROVATI (' + aggiudicazioni.length + ')' : 'non disponibili stasera — riprovo ogni notte');
    } catch (eE) { console.log('esiti: errore', eE.message); }
  }

})().catch(e=>{ console.error('FATALE',e); process.exit(1); });
