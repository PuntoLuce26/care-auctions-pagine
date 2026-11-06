// RICONCILIAZIONE ESITI — 6/11/2026
// feed/aggiudicazioni.json contiene 16.771 aggiudicazioni reali (immobiliari e mobiliari)
// ma nei conteggi del sito ne comparivano solo 2.183: l'esito non veniva riscritto sui lotti.
// Questo script incrocia gli ID e scrive esito=AGGIU.
//
// ATTENZIONE: il "prezzo" dell'archivio NON è il prezzo base: spesso è la MIGLIOR OFFERTA
// (etichetta "Miglior offerta €:"). Va salvato come prezzoAggiudicazione, non confrontato
// con il prezzo base del lotto. Il confronto serve solo come avviso, non come blocco.
import fs from 'fs';
import path from 'path';

const FEED = process.argv[2] || 'feed';
const SOLO_PROVA = process.argv.includes('--prova');

const legg = (f) => JSON.parse(fs.readFileSync(path.join(FEED, f), 'utf8'));
const scriv = (f, o) => fs.writeFileSync(path.join(FEED, f), JSON.stringify(o));

const agg = legg('aggiudicazioni.json');
const perId = new Map();
for (const a of agg) {
  const id = String(a.id || '').trim();
  if (!id) continue;
  perId.set(id, {
    prezzo: Number(a.prezzo) || 0,
    migliore: /miglior offerta/i.test(String(a.prezzo_label || '')),
    tribunale: a.tribunale || '', termina: a.termina || '', fonte: a.fonte || a.ivg || '',
  });
}
console.log(`archivio aggiudicazioni: ${perId.size} id`);

const indice = legg('indice.json');
const fileLotti = new Set();
for (const v of Object.values(indice.regioni || {})) {
  for (const f of (v.filesImm || [])) fileLotti.add(f);
  for (const f of (v.filesMob || [])) fileLotti.add(f);
}
console.log(`file lotto da leggere: ${fileLotti.size}`);

let riconciliati = 0, gia = 0, avvisi = 0, toccati = 0, ambigui = 0;
const esempiAmbigui = [];
const orfani = new Set(perId.keys());
const esempiAvviso = [];

for (const f of fileLotti) {
  let lotti;
  try { lotti = legg(f); } catch (e) { console.log('  salto', f, e.message); continue; }
  if (!Array.isArray(lotti)) continue;
  let cambiato = false;
  for (const l of lotti) {
    const id = String(l.id || '').trim();
    if (!perId.has(id)) continue;
    orfani.delete(id);
    const a = perId.get(id);
    if (String(l.esito || '').toUpperCase() === 'AGGIU') { gia++; continue; }
    // REGOLA DI SICUREZZA (6/11): gli ID possono collidere tra immobiliare e mobiliare.
    // Si scrive l'esito SOLO se il prezzo dell'archivio e' plausibile rispetto al prezzo base
    // (rapporto tra 0,35 e 3) oppure se l'archivio non ha prezzo. Altrimenti si mette da parte:
    // meglio 2.000 riconciliati certi che 16.000 sbagliati che falsano le statistiche.
    const pbL = Number(l.prezzoBase) || 0;
    const plausibile = !(a.prezzo > 0) || !(pbL > 0) || (a.prezzo / pbL >= 0.35 && a.prezzo / pbL <= 3);
    if (!plausibile) { ambigui++; if (esempiAmbigui.length < 10) esempiAmbigui.push(`${id}: base ${pbL} vs archivio ${a.prezzo}`); continue; }
    l.esito = 'AGGIU';
    if (a.prezzo > 0) {
      l.prezzoAggiudicazione = a.prezzo;
      l.prezzoAggiudicazioneTipo = a.migliore ? 'migliore offerta' : 'importo archivio';
      (globalThis.__prezzi = globalThis.__prezzi || []).push({ id, prezzo: a.prezzo });
      // avviso (non blocco): se il prezzo dell'archivio è molto diverso dal prezzo base
      const pb = Number(l.prezzoBase) || 0;
      if (pb > 0 && Math.abs(pb - a.prezzo) / pb > 0.5) {
        avvisi++;
        if (esempiAvviso.length < 10) esempiAvviso.push(`${id}: base ${pb} vs archivio ${a.prezzo}`);
      }
    }
    if (a.termina) l.dataAggiudicazione = a.termina;
    if (a.tribunale) l.tribunaleArchivio = a.tribunale;
    l.esitoFonte = 'archivio CARe (' + (a.fonte || 'fallco/ivg') + ')';
    riconciliati++; cambiato = true;
  }
  if (cambiato) { toccati++; if (!SOLO_PROVA) scriv(f, lotti); }
}

// ricalcolo le statistiche degli esiti su tutti i file
const conta = { AGGIU: 0, ASDES: 0, SOSPE: 0, DESER: 0 };
for (const f of fileLotti) {
  let lotti; try { lotti = legg(f); } catch (e) { continue; }
  if (!Array.isArray(lotti)) continue;
  for (const l of lotti) {
    const e = String(l.esito || '').toUpperCase();
    if (conta[e] != null) conta[e]++;
  }
}
console.log(`\n=== ESITO ===`);
console.log(` riconciliati:        ${riconciliati}`);
console.log(` già aggiudicati:     ${gia}`);
console.log(` AMBIGUI (scartati):   ${ambigui}`);
console.log(` orfani (id assenti): ${orfani.size}`);
console.log(` file modificati:     ${toccati}${SOLO_PROVA ? ' (PROVA: nessuna scrittura)' : ''}`);
console.log(`\n esiti ricalcolati: AGGIU=${conta.AGGIU} ASDES=${conta.ASDES} SOSPE=${conta.SOSPE}`);
if (esempiAmbigui.length) { console.log('\n esempi AMBIGUI (non toccati):'); esempiAmbigui.forEach(s => console.log('  ', s)); }

if (!SOLO_PROVA) {
  // archivio dei prezzi di aggiudicazione verificati
  const prezzi = {};
  for (const l of (globalThis.__prezzi||[])) prezzi[l.id]=l.prezzo;
  try { fs.writeFileSync(path.join(FEED,'prezzi-aggiudicazione.json'), JSON.stringify(prezzi)); } catch(e) {}
  try {
    const st = legg('statistiche.json');
    const note = st.esiti || {};
    st.esiti = {
      aggiudicate: conta.AGGIU, deserte: conta.ASDES + conta.DESER, sospese: conta.SOSPE,
      nonPubblicato: note.nonPubblicato,
    };
    st.esitiAggiornati = '2026-11-06';
    st.esitiFonte = 'riconciliazione archivio aggiudicazioni';
    scriv('statistiche.json', st);
    console.log('\n statistiche.json aggiornato:', JSON.stringify(st.esiti));
  } catch (e) { console.log(' statistiche non aggiornate:', e.message); }
  fs.writeFileSync(path.join(FEED, 'esiti-riconciliazione.json'), JSON.stringify({
    quando: new Date().toISOString(), riconciliati, gia, orfani: orfani.size, conteggi: conta }, null, 1));
}
