// metodo-guard — nessun dettaglio di calcolo (formula, filtri, soglie, pipeline) sulle pagine pubbliche.
// Regola ferma: si pubblica il fatto (numero + perimetro + data + fonte), non il metodo.
const ROTTE = ['/metodo', '/dati', '/sconto-reale-certificato', '/ca-re-index', '/osservatorio', '/idati'];
const BASI = ['https://careauctions.co', 'https://care-aste.emergent.host'];
const PATTERNS = [
  [/15\.000\s*(?:€|euro|&euro;)?\s*(?:\/|al)?\s*m/i, 'soglia 15.000 €/m²'],
  [/sotto\s+100\s*(?:€|euro|&euro;)/i, 'soglia 100 €'],
  [/normalizzat/i, 'normalizzazione a 100'],
  [/metodo completo/i, 'link al metodo completo'],
  [/1\s*[−–-]\s*\(\s*prezzo/i, 'formula Sconto Reale'],
  [/dividiamo il prezzo/i, 'formula CAReIndex'],
  [/media di questi valori/i, 'formula CAReIndex (media)'],
  [/valore di mercato OMI mediano/i, 'dettaglio formula OMI'],
  [/quasi sempre errori di battitura/i, 'spiegazione dei filtri'],
];
const pulisci = (h) => h.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&euro;/gi,'€')
  .replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ');
let ko = 0, viste = 0;
for (const base of BASI) {
  for (const r of ROTTE) {
    let t = '';
    try { const res = await fetch(base + r, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/131 metodo-guard' } }); if (!res.ok) { console.log('NON VERIFICABILE', base + r, res.status); continue; } t = pulisci(await res.text()); viste++; }
    catch (e) { console.log('NON VERIFICABILE', base + r, e.message); continue; }
    for (const [re, nome] of PATTERNS) {
      const m = t.match(re);
      if (m) { ko++; console.log('KO', base + r, '→', nome, '·', JSON.stringify(m[0].slice(0, 60))); }
    }
  }
}
console.log(`pagine lette: ${viste} · ${ko ? 'METODO IN CHIARO: ' + ko + ' occorrenze' : 'OK: nessun dettaglio di calcolo pubblico'}`);
process.exit(ko ? 1 : 0);
