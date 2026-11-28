// canarino-api.mjs — 28/11/2026 — presidio delle API dell'app attraverso il nostro edge.
// Regola di Gianluca (02:19): 403 o 5xx DUE volte di fila = rollback dell'edge + allarme.
// Distinzione che conta: 403 {"detail":"Forbidden"} = origin guard, 200 = catena sana.
// Il canarino non giudica i pagamenti, solo che l'edge arrivi all'app.
const ROTTE = [
  ['/api/battito', 'GET', 200],
  ['/api/aste/item/1822566', 'GET', 200],
  ['/api/payments/config', 'GET', 200],
  ['/api/pulse/w', 'POST', 400]
];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const fs = await import('node:fs');

// stato precedente (per contare i fallimenti consecutivi)
let prima = {};
try { prima = JSON.parse(fs.readFileSync('qa/canarino-api.json', 'utf8')); } catch (e) { prima = { fallimentiConsecutivi: 0 }; }

const esiti = [];
for (const [rotta, metodo, atteso] of ROTTE) {
  let codice = 0, corpo = '';
  try {
    const r = await fetch('https://careauctions.co' + rotta, {
      method: metodo,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://careauctions.co/aste/1822566',
        'Origin': 'https://careauctions.co',
        'Content-Type': 'application/json'
      },
      body: metodo === 'POST' ? '{}' : undefined
    });
    codice = r.status;
    const t = await r.text();
    corpo = rotta === '/api/payments/config' ? '[corpo non conservato]' : t.slice(0, 80);
  } catch (e) { corpo = 'errore rete: ' + String(e.message).slice(0, 60); }
  esiti.push({ rotta, metodo, atteso, codice, ok: codice === atteso, corpo });
}

const guaste = esiti.filter((x) => !x.ok);
const serieGrave = guaste.some((x) => x.codice === 403 || x.codice >= 500);
const consecutivi = serieGrave ? Number(prima.fallimentiConsecutivi || 0) + 1 : 0;
const rollback = consecutivi >= 2;

const stato = {
  generato: new Date().toISOString(),
  esito: guaste.length ? 'guasto' : 'ok',
  fallimentiConsecutivi: consecutivi,
  rollback,
  rotte: esiti
};
fs.mkdirSync('qa', { recursive: true });
fs.writeFileSync('qa/canarino-api.json', JSON.stringify(stato, null, 1) + '\n');
console.log(JSON.stringify(stato, null, 1));

if (process.env.GITHUB_OUTPUT) {
  const out = [
    `guasto=${guaste.length ? 'si' : 'no'}`,
    `rollback=${rollback ? 'si' : 'no'}`,
    `consecutivi=${consecutivi}`,
    `dettaglio=${guaste.map((x) => x.rotta + '=' + x.codice).join(' ')}`
  ].join('\n');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, out + '\n');
}
if (guaste.length) process.exitCode = 1;
