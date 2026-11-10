// icarewall-archivio.js — conserva OGNI messaggio della iCAReWall, per sempre.
// Regole: si aggiunge soltanto. Un archivio vuoto non si scrive mai. Il file non si accorcia mai.
const fs = require('fs');
const path = require('path');
const BASE = 'https://care-aste.emergent.host/api/battito';
const FILE = path.join(__dirname, '..', 'feed', 'icarewall-archivio.json');
const LINGUE = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ar', 'ja', 'zh', 'ru'];
const leggiArchivio = () => {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(j.messaggi) ? j : { messaggi: [] }; }
  catch (e) { return { messaggi: [] }; }
};
(async () => {
  const ar = leggiArchivio();
  const perId = new Map(ar.messaggi.map(m => [m.id, m]));
  const primaTot = perId.size;
  let nuovi = 0;
  for (const l of LINGUE) {
    try {
      const r = await fetch(BASE + '?lang=' + l, { headers: { 'User-Agent': 'CARe-archivio/1.0' } });
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.messaggi || []);
      for (const m of arr) {
        const id = m.id || (m.nome + '|' + m.data);
        if (!perId.has(id)) { perId.set(id, { id, nome: m.nome || '', data: m.data || '', lingua: m.lingua || l, testo: m.testo || m.originale || '', fissato: !!m.fissato }); nuovi++; }
      }
    } catch (e) {}
  }
  const messaggi = [...perId.values()].sort((a, b) => String(b.data).localeCompare(String(a.data)));
  if (!messaggi.length) { console.log('archivio: nessun messaggio letto, non scrivo niente'); process.exit(0); }
  if (messaggi.length < primaTot) { console.log('archivio: la lettura sarebbe piu corta (' + messaggi.length + ' < ' + primaTot + '), non scrivo'); process.exit(0); }
  const out = { aggiornato: new Date().toISOString(), totale: messaggi.length, nuovi_ultimo_giro: nuovi, regola: 'append-only: questo archivio non perde un messaggio. Un messaggio di una persona non si cancella mai.', messaggi };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(out, null, 0));
  console.log('archivio: ' + messaggi.length + ' messaggi totali (' + nuovi + ' nuovi), prima erano ' + primaTot);
})();
