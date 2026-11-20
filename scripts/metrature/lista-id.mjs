// 20/11/2026 — Lista degli id dei lotti da leggere per le metrature (Sam, per il workflow).
// Fonte: ricerca pubblica del PVP, ordinata per data di vendita CRESCENTE (prima i lotti che
// servono al sito adesso). Filtro: residenziale e descrizione SENZA metri quadri, che è la coda
// da recuperare. Output: un id per riga, solo la fetta richiesta (--shard/--shards).
// Uso: node lista-id.mjs --shard=0 --shards=4 --limite=300 > ids.txt
const PAGINE = 40, SIZE = 100;
const arg = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const SHARD = Number(arg.shard || 0), SHARDS = Number(arg.shards || 1), LIMITE = Number(arg.limite || 300);
const RE_MQ = /(m\.?\s?q\.?|metri\s+quadri|m²)\s*\.?\s*[\d.,]+/i;
const base = 'https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite';
const ids = [];
for (let p = 0; p < PAGINE && ids.length < LIMITE * SHARDS; p++) {
  let body;
  try {
    const r = await fetch(`${base}?page=${p}&size=${SIZE}&language=it&sort=dataOraVendita%2Casc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CAReAuctions-metrature/1.0 (+https://careauctions.co)' }, body: '{}' });
    if (!r.ok) break;
    body = (await r.json()).body;
  } catch (e) { break; }
  const lista = (body && body.content) || [];
  if (!lista.length) break;
  for (const e of lista) {
    if (String(e.categoriaLotto) !== 'IMMOBILE_RESIDENZIALE') continue;
    if (RE_MQ.test(String(e.descLotto || ''))) continue;
    ids.push(e.id);
  }
}
// fetta: gli id si distribuiscono a rotazione (0,4,8… al primo shard), così ogni fetta ha
// lotti diversi anche in ordine di data
const mia = ids.filter((_, i) => i % SHARDS === SHARD).slice(0, LIMITE);
process.stdout.write(mia.join('\n') + (mia.length ? '\n' : ''));
