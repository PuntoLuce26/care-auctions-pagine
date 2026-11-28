// canarino-api.mjs — 28/11/2026 — verifica ogni 5 minuti che le API dell'app rispondano
// attraverso il nostro edge, e avvisa quando torna il 403 dell'origin guard.
// Distinzione che conta: 403 {"detail":"Forbidden"} = guard dell'app, 200 = catena sana.
// Le rotte webhook NON si controllano qui: rispondono 400 di firma ed e' corretto.
const ROTTE = [
  ['/api/aste/item/1822566', 200],
  ['/api/payments/config', 200],
  ['/api/pulse/w', 400]
];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const esiti = [];
for (const [rotta, atteso] of ROTTE) {
  let codice = 0, corpo = '';
  try {
    const r = await fetch('https://careauctions.co' + rotta, {
      method: rotta === '/api/pulse/w' ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        'Referer': 'https://careauctions.co/aste/1822566',
        'Origin': 'https://careauctions.co',
        'Content-Type': 'application/json'
      },
      body: rotta === '/api/pulse/w' ? '{}' : undefined
    });
    codice = r.status;
    // il corpo della config contiene il client_id pubblico: non lo conserviamo
    const t = await r.text();
    corpo = rotta === '/api/payments/config' ? '[corpo non conservato]' : t.slice(0, 120);
  } catch (e) { corpo = 'errore rete: ' + String(e.message).slice(0, 80); }
  esiti.push({ rotta, atteso, codice, ok: codice === atteso, corpo });
}
const rotti = esiti.filter((x) => !x.ok);
const stato = {
  generato: new Date().toISOString(),
  esito: rotti.length ? 'guasto' : 'ok',
  rotte: esiti
};
console.log(JSON.stringify(stato, null, 1));
if (process.env.GITHUB_OUTPUT) {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `eGuasto=${rotti.length ? 'si' : 'no'}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `dettaglio=${JSON.stringify(rotti.map((x) => x.rotta + '=' + x.codice))}\n`);
}
if (rotti.length) process.exitCode = 1;
