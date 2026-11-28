// deploy-guardia.mjs — 28/11/2026 — regola ferma di Gianluca (02:19):
// niente deploy di edge/worker senza la lista COMPLETA dei binding.
// Uso: node deploy-guardia.mjs prima  <file-nomi.json>     (salva i nomi dei binding attuali)
//      node deploy-guardia.mjs dopo   <file-nomi.json>     (confronta; se manca un nome, esce 2 → rollback)
// Non stampa e non salva i VALORI: solo i nomi dei binding.
import fs from 'node:fs';
const [modo, file] = process.argv.slice(2);
const SCRIPT = process.env.SCRIPT || 'careauctions-edge';
const CF = process.env.CLOUDFLARE_API_TOKEN || fs.readFileSync('careauctions/.tools/cloudflare-token.txt', 'utf8').trim();
const ACC = process.env.CF_ACCOUNT || 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACC}/workers/scripts/${SCRIPT}`;

async function nomi() {
  const r = await fetch(`${API}/settings`, { headers: { Authorization: 'Bearer ' + CF } });
  const j = await r.json();
  if (!j.success) throw new Error('settings: ' + JSON.stringify(j.errors).slice(0, 120));
  const b = (j.result && j.result.bindings) || [];
  return b.map((x) => x.name).sort();
}

const attuali = await nomi();
if (modo === 'prima') {
  fs.writeFileSync(file, JSON.stringify({ script: SCRIPT, quando: new Date().toISOString(), nomi: attuali }, null, 1));
  console.log(`PRIMA  · ${SCRIPT} · ${attuali.length} binding: ${attuali.join(', ')}`);
  process.exit(0);
}
if (modo === 'dopo') {
  const prima = JSON.parse(fs.readFileSync(file, 'utf8')).nomi;
  const mancanti = prima.filter((n) => !attuali.includes(n));
  const nuovi = attuali.filter((n) => !prima.includes(n));
  console.log(`DOPO   · ${SCRIPT} · ${attuali.length} binding (prima ${prima.length})`);
  if (nuovi.length) console.log('  nuovi:', nuovi.join(', '));
  if (mancanti.length) {
    console.log('  MANCANTI:', mancanti.join(', '));
    console.log('  -> rollback immediato, senza chiedere (regola 02:19)');
    process.exit(2);
  }
  console.log('  nessun binding perso');
  process.exit(0);
}
console.log('uso: node deploy-guardia.mjs prima|dopo <file-nomi.json>');
process.exit(1);
