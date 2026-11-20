// 20/11/2026 — Lista degli id dei lotti da leggere per le metrature (Sam).
// Lezione del primo giro (misurata): ordinando per data CRESCENTE arrivano per prime le aste
// scadute (2010-2017) e il PVP non ha più i documenti: 0 allegati su 40 lotti, estrazione inutile.
// Quindi si scende dalla data più lontana e si tengono solo i lotti con vendita FRA OGGI e +3 anni
// (la quarantena già in uso nel feed), scartando le date impossibili (es. 3019).
// Filtro: residenziale e descrizione SENZA metri quadri = la coda da recuperare.
// Uso: node lista-id.mjs --shard=0 --shards=4 --limite=300 > ids.txt
const PAGINE = 60, SIZE = 100, OGGI = new Date().toISOString().slice(0, 10);
const LIMITE_ANNI = 3;
const arg = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const SHARD = Number(arg.shard || 0), SHARDS = Number(arg.shards || 1), LIMITE = Number(arg.limite || 300);
const RE_MQ = /(m\.?\s?q\.?|metri\s+quadri|m²)\s*\.?\s*[\d.,]+/i;
const fine = (() => { const d = new Date(); d.setFullYear(d.getFullYear() + LIMITE_ANNI); return d.toISOString().slice(0, 10); })();
const base = 'https://pvp.giustizia.it/ric-496b258c-986a1b71/ric-ms/ricerca/vendite';
const ids = [];
for (let p = 0; p < PAGINE && ids.length < LIMITE * SHARDS; p++) {
  let lista;
  try {
    const r = await fetch(`${base}?page=${p}&size=${SIZE}&language=it&sort=dataOraVendita%2Cdesc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CAReAuctions-metrature/1.0 (+https://careauctions.co)' }, body: '{}' });
    if (!r.ok) break;
    lista = ((await r.json()).body || {}).content || [];
  } catch (e) { break; }
  if (!lista.length) break;
  let passatoIlFuturo = false;
  for (const e of lista) {
    const d = String(e.dataVendita || '');
    if (!d) continue;
    if (d > fine) continue;                                  // data impossibile o troppo lontana
    if (d < OGGI) { passatoIlFuturo = true; continue; }       // asta già passata: qui finisce la coda utile
    if (String(e.categoriaLotto) !== 'IMMOBILE_RESIDENZIALE') continue;
    if (RE_MQ.test(String(e.descLotto || ''))) continue;      // ha già i mq: fuori da questa coda
    ids.push(e.id);
  }
  // quando una pagina intera è sotto la data di oggi, inutile continuare
  if (passatoIlFuturo && p > 2) break;
}
const mia = ids.filter((_, i) => i % SHARDS === SHARD).slice(0, LIMITE);
process.stdout.write(mia.join('\n') + (mia.length ? '\n' : ''));
