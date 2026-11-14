#!/usr/bin/env node
/**
 * EMERGENT+ v1 — gate dopo una pubblicazione Emergent, sull'artefatto servito.
 * Contratto: node emergent-plus.mjs; exit 0 PASS, 2 FAIL.
 */
const BASE = process.env.BASE || 'https://careauctions.co';
const UA = 'Mozilla/5.0 (compatible; CARe-EMERGENT+/1.0)';
const checks = [];
async function get(url, ua = UA, redirect = 'follow') {
  const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': 'text/html,application/json' }, redirect, signal: AbortSignal.timeout(20000) });
  return { status: r.status, text: await r.text(), url: r.url };
}
try {
  const home = await get(BASE + '/?gate=' + Date.now());
  checks.push({ nome: 'home 200', ok: home.status === 200 });
  const builds = [...new Set((home.text.match(/main\.[a-f0-9]{6,}\.js/gi) || []))];
  checks.push({ nome: 'build presente', ok: builds.length >= 1, trovato: builds.slice(0, 3) });
  const gb = await get(BASE + '/?gate=' + Date.now(), 'Googlebot');
  checks.push({ nome: 'home statica contiene /buynow', ok: /href="https?:\/\/careauctions\.co\/buynow"/i.test(gb.text) });
  checks.push({ nome: 'home statica contiene Vai al negozio', ok: /Vai al negozio/i.test(gb.text) });
  const buy = await get(BASE + '/buynow?gate=' + Date.now());
  checks.push({ nome: '/buynow 200', ok: buy.status === 200 });
  checks.push({ nome: '/buynow H1', ok: /<h1[^>]*>\s*BuyNow/i.test(buy.text) });
  const ishop = await get(BASE + '/ishop?gate=' + Date.now());
  checks.push({ nome: '/ishop 200', ok: ishop.status === 200 });
  checks.push({ nome: '/ishop Vai al negozio', ok: /Vai al negozio/i.test(ishop.text) });
  const cerca = await get(BASE + '/cerca?q=Roma&gate=' + Date.now(), UA, 'manual');
  checks.push({ nome: '/cerca 200 (non 301)', ok: cerca.status === 200 });
  const sp = await get(BASE + '/buynow/san-pasquale?gate=' + Date.now());
  const foto = [...new Set((sp.text.match(/san-pasquale\/thumb\/\d+\.jpg/g) || []))];
  checks.push({ nome: 'San Pasquale >= 37 foto', ok: foto.length >= 37, trovate: foto.length });
  let fotoKo = 0;
  for (const f of foto.slice(0, 37)) {
    const u = 'https://puntoluce26.github.io/care-auctions-pagine/foto/' + f.replace('/thumb/', '/');
    try { const r = await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(10000) }); if (r.status !== 200) fotoKo++; } catch { fotoKo++; }
  }
  checks.push({ nome: 'tutte le foto 200', ok: fotoKo === 0, ko: fotoKo });
} catch (e) {
  checks.push({ nome: 'esecuzione', ok: false, errore: String(e.message || e).slice(0, 160) });
}
const verdetto = checks.every(c => c.ok) ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ gate: 'EMERGENT+', checks, verdetto }, null, 2));
process.exit(verdetto === 'PASS' ? 0 : 2);
