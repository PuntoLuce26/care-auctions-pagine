// 20/11/2026 — Invio dell'esito del guardiano (Sam). Una strada sola per le email: l'azione del worker.
// Se la chiave non c'è, non si inventa niente: si scrive nel log e si esce puliti.
import { readFileSync } from 'node:fs';
const K = process.env.REGIA_KEY || '';
if (!K) { console.log('REGIA_KEY assente: email non inviata (il testo resta nel log del run)'); process.exit(0); }
let testo = '';
try { testo = readFileSync('guardiano-esito.txt', 'utf8'); } catch { console.log('nessun esito da inviare'); process.exit(0); }
const r = await fetch('https://icare-ai.misty-mode-1cbc.workers.dev', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ azione: 'invia-email', chiave: K, oggetto: 'CARe metrature — controllo periodico', testo })
});
console.log('invio email:', r.status, (await r.text()).slice(0, 120));
