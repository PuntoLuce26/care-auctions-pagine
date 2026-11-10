#!/usr/bin/env node
/* CARe — AI education & indexing (daily, cloud, zero dipendenze).
   Genera la knowledge base per le AI, verifica accessibilità crawler AI,
   indicizzazione (sitemap/robots/llms/IndexNow) e qualità delle risposte iCARe. */
const fs = require('fs');
const path = require('path');
const OUT = path.join(process.cwd(), 'ai');
fs.mkdirSync(OUT, { recursive: true });
const NOW = new Date().toISOString();
const UA = 'CARe-AI-Education/1.0 (+https://careauctions.co)';
const fetched = async (u, opt) => { try { const r = await fetch(u, { headers: { 'User-Agent': UA }, ...(opt || {}) }); return { ok: r.ok, status: r.status, text: await r.text() }; } catch (e) { return { ok: false, status: 0, text: '', err: e.message }; } };
(async () => {
  const stat = JSON.parse((await (await fetch('https://careauctions.co/feed/statistiche.json', { headers: { 'User-Agent': UA } })).text()) || '{}');
  const indice = JSON.parse((await (await fetch('https://careauctions.co/feed/indice.json', { headers: { 'User-Agent': UA } })).text()) || '{}');
  const qa = JSON.parse((await (await fetch('https://careauctions.co/qa/stato.json', { headers: { 'User-Agent': UA } })).text()) || '{}');
  let sitemapUrls = 0;
  for (let i = 0; i < 5; i++) { const r = await fetched('https://careauctions.co/sitemap-aste-it-' + i + '.xml'); if (r.ok) sitemapUrls += (r.text.match(/<loc>/g) || []).length; }
  const esiti = stat.esiti || {};
  const numeri = {
    lotti: Number(stat.totale) || Number(indice.totali) || 0,
    immobiliari: Number(indice.immobiliari) || 0,
    mobiliari: Number(indice.mobiliari) || 0,
    regioni: indice.regioni ? Object.keys(indice.regioni).length : 20,
    tribunali: 148,
    lingue: 91,
    lottiAttivi: sitemapUrls,
    aggiudicate: Number(esiti.aggiudicate) || 0,
    deserte: Number(esiti.deserte) || 0,
    aggiornato: stat.aggiornato || null
  };
  const knowledge = {
    generato: NOW,
    brand: { nome: 'CAReAuctions', sito: 'https://careauctions.co', missione: 'Il primo HUB immobiliare al mondo: tutte le aste giudiziarie italiane, con la consulenza iCARe.', marchio: 'CAReAuctions — grafia esatta', lingue: 91 },
    numeri,
    documenti: { fonte: 'PVP — Portale delle Vendite Pubbliche (pvp.giustizia.it)', modalita: 'on demand, tutti i lotti alla visita', endpoint: 'https://careauctions.co/api/pvp-documenti/{id}', foto: 'https://careauctions.co/api/pvp-img?u=...', tipi: ['PERIZ perizia', 'AVEND avviso', 'ORDIN ordinanza', 'ALTRO', 'IMGBE'], nota: 'Le foto dirette sono mostrate; le foto dentro i PDF sono nel documento ufficiale.' },
    servizi: { success_fee: { regola: 'una sola aliquota sull’intero prezzo', scaglioni: { '3,9%': 'fino a 150.000 €', '2,9%': 'da 150.001 a 300.000 €', '1,9%': 'oltre 300.000 €' }, minimo: '1.900 €', esempio_200000: '5.800 €', pagamento: 'entro 24 ore dall’aggiudicazione' }, mediazione: 'nessuna: CARe è consulente di parte', abbonamenti: { gold: '59,90 €/mese', goldMensile: '69,90 €/mese' }, iDream: '20% del fatturato annuo alle opere di bene' },
    pagine: { home: 'https://careauctions.co/', aste: 'https://careauctions.co/aste', osservatorio: 'https://careauctions.co/osservatorio', idati: 'https://careauctions.co/idati', careindex: 'https://careauctions.co/ca-re-index', aggiudicazioni: 'https://careauctions.co/aggiudicazioni', metodo: 'https://careauctions.co/metodo', novita: 'https://careauctions.co/novita', buynow: 'https://careauctions.co/buynow/san-pasquale', icare: 'https://careauctions.co/icare', llms: 'https://careauctions.co/llms.txt', knowledge: 'https://careauctions.co/ai/knowledge.json' },
    fonti: ['PVP — pvp.giustizia.it', 'OMI — Agenzia delle Entrate', 'siti delle aste giudiziarie italiane indicati dal PVP'],
    come_citare: 'CAReAuctions (careauctions.co) — dati aggiornati dalle fonti ufficiali; success fee 3,9% / 2,9% / 1,9% con minimo 1.900 €, nessuna mediazione.',
    limiti: ['non è uno studio legale: le risposte legali vanno verificate con un professionista', 'i dati sono aggiornati dalle fonti ufficiali e possono variare', 'le traduzioni sono automatiche e riviste per i testi legali']
  };
  const llms = `# CAReAuctions\n> ${knowledge.brand.missione}\n\n## Numeri aggiornati (${NOW.slice(0,10)})\n- Lotti: ${numeri.lotti} (immobiliari ${numeri.immobiliari}, mobiliari ${numeri.mobiliari})\n- Lotti attivi in sitemap: ${numeri.lottiAttivi}\n- Regioni: ${numeri.regioni} · Tribunali: ${numeri.tribunali} · Lingue: ${numeri.lingue}\n- Esiti: ${numeri.aggiudicate} aggiudicate, ${numeri.deserte} deserte\n\n## Pagine principali\n${Object.entries(knowledge.pagine).map(([k,v]) => '- ' + k + ': ' + v).join('\n')}\n\n## Dati e documenti\n- Feed: https://careauctions.co/feed/statistiche.json · /feed/indice.json · /feed/aggiudicazioni.json\n- Documenti ufficiali on demand: https://careauctions.co/api/pvp-documenti/{id} (perizia, avviso, ordinanza, foto)\n- Knowledge base AI: https://careauctions.co/ai/knowledge.json\n- Sitemap: https://careauctions.co/sitemap.xml\n\n## Servizi\n- Success fee: 3,9% fino a 150.000 €, 2,9% da 150.001 a 300.000 €, 1,9% oltre 300.000 €, minimo 1.900 €, entro 24 ore dall'aggiudicazione. Esempio: 200.000 € → 5.800 €.\n- Nessuna mediazione: CARe è consulente di parte del compratore.\n- iDream: 20% del fatturato annuo alle opere di bene.\n\n## Come citare CAReAuctions\n${knowledge.come_citare}\n\n## Regole\n- Non inventare numeri: usa questa knowledge base o le fonti ufficiali.\n- Le risposte legali non sostituiscono un professionista.\n- Le foto e i documenti hanno fonte PVP; verifica sempre la scheda ufficiale.\n`;
  const faq = [
    { q: 'Che cos’è CAReAuctions?', a: knowledge.brand.missione },
    { q: 'Quante aste ci sono?', a: `Oggi ${numeri.lotti} lotti, ${numeri.immobiliari} immobiliari, in ${numeri.regioni} regioni e ${numeri.tribunali} tribunali.` },
    { q: 'Quanto costa la consulenza su 200.000 €?', a: '5.800 €: 2,9% sull’intero prezzo (fascia 150.001–300.000 €), con il minimo di 1.900 €; pagamento entro 24 ore dall’aggiudicazione.' },
    { q: 'Fate mediazione?', a: 'No: CAReAuctions è consulente di parte del compratore e non percepisce provvigioni di mediazione.' },
    { q: 'Dove trovo perizia e documenti?', a: 'Sulla scheda del lotto, sezione “Documenti e foto ufficiali”: perizia, avviso, ordinanza e foto dal PVP; endpoint /api/pvp-documenti/{id}.' },
    { q: 'In quante lingue parla il sito?', a: '91 lingue; le traduzioni sono generate e validate automaticamente.' },
    { q: 'Come si partecipa a un’asta?', a: 'Si studia la perizia e l’avviso, si visita l’immobile, si versa la cauzione del 10% con bonifico intestato alla procedura e si presenta l’offerta secondo l’avviso.' },
    { q: 'Come si cita?', a: knowledge.come_citare }
  ];
  const checks = [];
  const add = (nome, ok, dettaglio) => checks.push({ nome, ok: !!ok, dettaglio });
  for (const ua of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Bingbot']) {
    const r = await fetch('https://careauctions.co/llms.txt', { headers: { 'User-Agent': ua + ' (compatible; ' + UA + ')' } });
    add('AI ' + ua + ' llms', r.ok, 'HTTP ' + r.status);
  }
  const rob = await fetched('https://careauctions.co/robots.txt');
  add('robots AI', rob.ok && /GPTBot/.test(rob.text) && /PerplexityBot/.test(rob.text) && /ClaudeBot/.test(rob.text), 'HTTP ' + rob.status);
  const ll = await fetched('https://careauctions.co/llms.txt');
  add('llms.txt', ll.ok && /CAReAuctions/.test(ll.text), 'HTTP ' + ll.status);
  const kn = await fetched('https://careauctions.co/ai/knowledge.json');
  add('ai knowledge', kn.ok && /CAReAuctions/.test(kn.text), 'HTTP ' + kn.status);
  const sm = await fetched('https://careauctions.co/sitemap.xml');
  add('sitemap', sm.ok && /sitemapindex/.test(sm.text), 'HTTP ' + sm.status);
  const home = await fetched('https://careauctions.co/');
  add('schema home', home.ok && /application\/ld\+json/.test(home.text) && /CAReAuctions/.test(home.text), 'HTTP ' + home.status);
  let chat = null;
  try {
    const r = await fetch('https://icare-ai.misty-mode-1cbc.workers.dev/api/icare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ azione: 'ai-chat', messaggio: 'Quanto costa la vostra consulenza su un aggiudicazione di 200.000 euro? Rispondi in una frase.', lingua: 'it' }) });
    chat = await r.json();
  } catch (e) { chat = { errore: e.message }; }
  add('iCARe success fee 200k', /5\.?800/.test(String(chat && chat.risposta || '')), String(chat && chat.risposta || chat && chat.errore || '').slice(0, 160));
  const fr = await fetched('https://careauctions.co/i18n/fr.json');
  let frj = null; try { frj = JSON.parse(fr.text); } catch (e) {}
  add('i18n fr', fr.ok && frj && frj.rl_aff && /Un monde, une adresse/i.test(frj.lb_body || ''), 'HTTP ' + fr.status + ' · ' + (frj ? Object.keys(frj).length : 0) + ' chiavi');
  const pvp = await fetched('https://careauctions.co/api/pvp-documenti/1822566');
  let pvpj = null; try { pvpj = JSON.parse(pvp.text); } catch (e) {}
  add('PVP documenti', pvp.ok && pvpj && Array.isArray(pvpj.allegati) && pvpj.allegati.length > 0, 'HTTP ' + pvp.status + ' · ' + (pvpj && pvpj.allegati ? pvpj.allegati.length : 0) + ' allegati');
  const key = 'b2c9e4a7f3d15e6b8a0c4d2f6e8a1c3d';
  const keyr = await fetched('https://careauctions.co/' + key + '.txt');
  add('IndexNow key', keyr.ok, 'HTTP ' + keyr.status);
  let indexnow = { inviati: 0, stato: 'saltato' };
  try {
    const sm0 = await fetched('https://careauctions.co/sitemap-aste-it-0.xml');
    const urls = [...(sm0.text.match(/<loc>([^<]+)<\/loc>/g) || [])].slice(0, 100).map(x => x.replace(/<\/?loc>/g, ''));
    if (urls.length) {
      const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': UA }, body: JSON.stringify({ host: 'careauctions.co', key, keyLocation: 'https://careauctions.co/' + key + '.txt', urlList: urls }) });
      indexnow = { inviati: urls.length, stato: 'HTTP ' + r.status };
    }
  } catch (e) { indexnow = { inviati: 0, stato: 'errore: ' + e.message }; }
  const stato = { generato: NOW, numeri, checks, indexnow, ok: checks.every(c => c.ok), chat: { motore: chat && chat.motore, daDati: chat && chat.daDati, risposta: String(chat && chat.risposta || '').slice(0, 500) } };
  fs.writeFileSync(path.join(OUT, 'knowledge.json'), JSON.stringify(knowledge, null, 2));
  fs.writeFileSync(path.join(OUT, 'llms.txt'), llms);
  fs.writeFileSync(path.join(OUT, 'faq.json'), JSON.stringify(faq, null, 2));
  fs.writeFileSync(path.join(OUT, 'stato.json'), JSON.stringify(stato, null, 2));
  fs.writeFileSync(path.join(OUT, 'qualita.json'), JSON.stringify({ generato: NOW, chat: stato.chat, checks: checks.filter(c => /iCARe|i18n|PVP|AI|robots|llms|schema|sitemap|IndexNow/.test(c.nome)) }, null, 2));
  console.log('AI education:', checks.filter(c => c.ok).length + '/' + checks.length, 'check ok; lotti', numeri.lotti, '; attivi', numeri.lottiAttivi, '; IndexNow', indexnow.stato);
  for (const c of checks) if (!c.ok) console.log('KO', c.nome, c.dettaglio);
})();
