// stato-unico.mjs — un solo stato per tutta la piattaforma CAReAuctions.
// Raccoglie le sonde che prima gridavano ognuna per conto suo e produce DUE file:
//   stato/unico.json  (macchina)   stato/unico.md (umano, 15 righe)
// Non esce mai in errore: se una sonda non risponde, la dichiara "non verificabile".
// Node 22, zero dipendenze, solo fetch.
import { writeFileSync, mkdirSync } from 'node:fs';

const SITO='https://careauctions.co', ORIG='https://care-aste.emergent.host';
const WORKER='https://icare-ai.misty-mode-1cbc.workers.dev/';
const RAW='https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BOT='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const REGIA=process.env.REGIA_KEY||'';
const GH=process.env.GITHUB_TOKEN||'';
const T=15000;
const voci=[];
const add=(sezione,nome,stato,valore,dettaglio='')=>voci.push({sezione,nome,stato,valore,dettaglio});

async function req(url,{ua=UA,method='GET',body=null,headers={}}={}){
  const c=new AbortController(); const to=setTimeout(()=>c.abort(),T);
  try{
    const r=await fetch(url,{method,signal:c.signal,headers:{'User-Agent':ua,...(body?{'Content-Type':'application/json'}:{}) ,...headers},body:body?JSON.stringify(body):undefined,redirect:'follow'});
    const t=await r.text();
    return {ok:r.ok,status:r.status,text:t};
  }catch(e){ return {ok:false,status:0,text:s=>'',err:String(e.message||e)}; }
  finally{ clearTimeout(to); }
}
const hashMain=h=>{const m=String(h||'').match(/main\.[a-f0-9]{8}\.js/);return m?m[0]:null;};

// 1 · ROTTE
const ROTTE=['/','/idati','/osservatorio','/mercato','/aggiudicazioni','/aste','/buynow/san-pasquale','/ilive','/iworld','/qa/stato.json'];
let rotti=0;
for(const p of ROTTE){
  const r=await req(SITO+p);
  const atteso404 = p==='/iworld';                 // sezione in costruzione: 404 è normale
  if(atteso404){
    add('rotte',p, r.status===404?'in_arrivo':'ok', String(r.status), r.status===404?'non ancora pubblicata':'pubblicata');
    continue;
  }
  if(!r.ok){ rotti++; add('rotte',p,'rosso',String(r.status||'ERR')); } else add('rotte',p,'ok',String(r.status));
}
add('rotte','rotte non 200','ok'=== (rotti===0?'ok':'rosso') ? 'ok':'rosso', String(rotti), rotti?`${rotti} rotte non rispondono`:'tutte le rotte rispondono');

// 2 · FEED
for(const f of ['statistiche','world','ricevute','san-pasquale-foto']){
  const r=await req(`${SITO}/feed/${f}.json?ts=${Date.now()}`);
  if(!r.ok){ add('feed',f,'rosso',String(r.status)); continue; }
  let d=null; try{ d=JSON.parse(r.text); }catch{}
  if(!d){ add('feed',f,'rosso','json non valido'); continue; }
  const agg=d.aggiornato||d.generato||null;
  let eta=null;
  if(agg){ const ms=Date.now()-Date.parse(agg); if(!isNaN(ms)) eta=Math.round(ms/60000); }
  // un feed LEGITTIMAMENTE vuoto non e in ritardo: le ricevute nascono all'incasso
  const vuotoLegittimo = f==='ricevute' && (d.ricevute||[]).length===0;
  // ogni feed ha il suo ritmo: le statistiche girano ogni pochi minuti, gli altri cambiano di rado.
  // Una soglia unica produce falsi gialli (misurato il 12/11: world e san-pasquale-foto a 101 e 81 min).
  const SOGLIE={statistiche:[60,180], world:[1440,2880], ricevute:[1440,2880], 'san-pasquale-foto':[1440,2880]};
  const [gialla,rossa]=SOGLIE[f]||[60,180];
  const stato = vuotoLegittimo ? 'ok'
              : eta===null?'giallo' : eta>rossa?'rosso' : eta>gialla?'giallo':'ok';
  const extra = f==='statistiche'?`${d.totale||'?'} lotti` : f==='world'?`${(d.paesi||[]).length} paesi` : f==='ricevute'?`${(d.ricevute||[]).length} ricevute` : `${(d.foto||[]).length} foto`;
  add('feed',f,stato, eta===null?'data assente':`${eta} min`, extra);
}

// 3 · BUILD: sito vs origine
const hs=await req(SITO+'/'); const ho=await req(ORIG+'/');
const hSito=hashMain(hs.text), hOrig=hashMain(ho.text);
add('build','sito vs origine', hSito&&hOrig&&hSito===hOrig?'ok':'rosso', hSito?`${hSito} / ${hOrig||'?'}`:'hash non trovato', hSito!==hOrig?'le due copie servono bundle diversi':'');

// 4 · PRERENDER: snapshot dei crawler vs build viva
const pp=await req(`${RAW}prerender/idati.html?ts=${Date.now()}`);
const hSnap=hashMain(pp.text);
const hBot=hashMain((await req(SITO+'/idati',{ua:BOT})).text);
add('prerender','snapshot vs vivo', hSnap&&hBot&&hSnap===hBot?'ok':'giallo', hSnap?`${hSnap} / ${hBot||'?'}`:'snapshot non letto', hSnap!==hBot?'drift: i crawler ricevono un bundle vecchio':'');
add('prerender','bot allineato', hBot? (hBot===hSito?'ok':'giallo') : 'giallo', hBot||'non letto');

// 5 · WORKER
if(!REGIA){ add('worker','stato-automazioni','non_verificabile','REGIA_KEY assente'); }
else{
  const r=await req(WORKER,{method:'POST',body:{azione:'stato-automazioni',chiave:REGIA}});
  if(r.ok){ let d=null; try{d=JSON.parse(r.text);}catch{} const n=(d&&(d.automazioni||d.lista||[]).length)||0; add('worker','stato-automazioni','ok','200',`${n} automazioni`); }
  else add('worker','stato-automazioni','rosso',String(r.status||'ERR'));
  const pz=await req(WORKER,{method:'POST',body:{azione:'paypal-lunghezze'}});
  add('worker','cancello (paypal-lunghezze senza chiave)', pz.status===403?'ok':'rosso', String(pz.status), pz.status===403?'protetta':'risponde senza chiave');
}

/* stato interno da R2 (bucket care-stato): un solo punto, così i lettori non divergono. */
let _statoMod=null;
async function statoInterno(percorso){
  try{
    if(!_statoMod) _statoMod=await import('./stato-pubblica.mjs');
    return await _statoMod.leggiStato(percorso);
  }catch(e){ return {ok:false}; }
}
// 6 · FILE DI STATO STORICI (le vecchie sonde, lette in un posto)
const file=[['qa/stato.json','qa','summary'],['mail/stato.json','mail','allarmi'],['ai/sentinella-stato.json','sentinella','ok'],['perf/stato.json','perf','']];
for(const [f,sez] of file){
  // 12/11/2026 — gli stati interni si leggono da R2 (fonte vera); la raw resta come ripiego.
  let r=null;
  try{ const l=await statoInterno(f.replace(/^\//,'')); if(l&&l.ok&&l.json) r={ok:true,status:200,text:l.testo}; }catch(e){}
  if(!r) r=await req(`${RAW}${f}?ts=${Date.now()}`);
  if(!r.ok){ add(sez,f,'non_verificabile',String(r.status)); continue; }
  let d=null; try{ d=JSON.parse(r.text); }catch{}
  if(!d){ add(sez,f,'non_verificabile','json'); continue; }
  if(sez==='qa'){ const c=(d.summary&&(d.summary.critical||0))||0; add('qa','critici', c>0?'rosso':'ok', String(c), `${(d.summary&&d.summary.total)||0} controlli`); }
  else if(sez==='mail'){ const a=Array.isArray(d.allarmi)?d.allarmi.length:(d.allarmi||0); add('mail','allarmi', a>0?'giallo':'ok', String(a), d.ultimoControllo||''); }
  else if(sez==='sentinella'){
    const an=(d.anomalie||[]).map(function(x){return JSON.stringify(x).toLowerCase();});
    const note=an.filter(function(x){return x.includes('qa_stato')||x.includes('perf_stato')||x.includes('qa-stat')||x.includes('p95');});
    const vere=an.length-note.length;
    add('sentinella','ok', vere>0?'giallo':'ok', vere>0?(vere+' anomalie vere'):'nessuna anomalia vera',
        note.length?(note.length+' note dichiarate, ignorate'):'');
  }
  else add('perf','letto','ok','200');
}

// 7 · GITHUB: run rossi recenti
if(GH){
  const r=await req('https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/actions/runs?per_page=30',{headers:{Authorization:'Bearer '+GH,Accept:'application/vnd.github+json'}});
  if(r.ok){ let d=null; try{d=JSON.parse(r.text);}catch{}
    const lim=Date.now()-2*3600e3;
    const rossi=(d.workflow_runs||[]).filter(x=>x.conclusion==='failure'&&Date.parse(x.created_at)>lim);
    // un fallimento ISOLATO non è un guasto: i workflow che committano in parallelo si scontrano
    // (mail-qa il 12/11: success 18:12:32, failure 18:13:14 — è una race, non un errore di contenuto).
    // Giallo solo se lo STESSO workflow fallisce due volte nelle due ore.
    const perNome={};
    rossi.forEach(function(x){ perNome[x.name]=(perNome[x.name]||0)+1; });
    const veri=Object.keys(perNome).filter(function(k){ return perNome[k]>=2; });
    add('github','run rossi (2h)', veri.length>0?'giallo':'ok',
        veri.length?veri.length+' workflow con 2+ fallimenti':String(rossi.length)+' isolati',
        veri.length?veri.join(' · '):(rossi.length?rossi.map(function(x){return x.name;}).slice(0,3).join(' · ')+' (una volta sola: race nota)':''));
  } else add('github','api','non_verificabile',String(r.status));
}

// 8 · SEMAFORO
const rosso=voci.some(v=>v.stato==='rosso'), giallo=voci.some(v=>v.stato==='giallo');
const semaforo= rosso?'rosso' : giallo?'giallo':'verde';
const generato=new Date().toISOString();
const out={generato,semaforo,conteggi:{
  ok:voci.filter(v=>v.stato==='ok').length,
  giallo:voci.filter(v=>v.stato==='giallo').length,
  rosso:voci.filter(v=>v.stato==='rosso').length,
  non_verificabile:voci.filter(v=>v.stato==='non_verificabile').length},voci};

mkdirSync('stato',{recursive:true});
writeFileSync('stato/unico.json',JSON.stringify(out,null,1));

const icona={ok:'·',giallo:'!',rosso:'X',non_verificabile:'?'};
const sez=[...new Set(voci.map(v=>v.sezione))];
let md=`# Stato CAReAuctions — ${semaforo.toUpperCase()}\n\n> ${generato} · ${out.conteggi.ok} ok · ${out.conteggi.giallo} gialli · ${out.conteggi.rosso} rossi · ${out.conteggi.non_verificabile} non verificabili\n\n`;
for(const s of sez){
  md+=`## ${s}\n\n`;
  for(const v of voci.filter(x=>x.sezione===s)) md+=`- ${icona[v.stato]} **${v.nome}** — ${v.valore}${v.dettaglio?' · '+v.dettaglio:''}\n`;
  md+='\n';
}
md+=`\n_Generato da scripts/stato-unico.mjs. Un solo stato, un solo posto: se una sonda non risponde la dichiara non verificabile, mai rotta._\n`;
writeFileSync('stato/unico.md',md);
console.log(`stato/unico.json → ${semaforo} (${out.conteggi.ok} ok, ${out.conteggi.rosso} rossi, ${out.conteggi.giallo} gialli)`);
