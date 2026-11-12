#!/usr/bin/env node
/** ronda-notturna.js — sorveglianza notturna CAReAuctions, interamente in cloud (GitHub Actions).
 *
 *  Ogni 2 ore controlla: rotte del sito, freschezza del feed, QA cloud, orchestra, sentinella AI,
 *  watcher careauctions.it, monitor posta, allineamento della build e gli ultimi run dei workflow.
 *  Scrive `qa/ronda-notturna.json` (stato, controlli, storico degli ultimi 8 giri).
 *  Esce con codice 2 SOLO per problemi veri e SOLO quando cambiano (una run rossa = una mail
 *  di GitHub, quindi niente spam). Alle 06:10 UTC (07:10 Europe/Rome) manda il riepilogo della
 *  notte via Gmail API con i secret del repo.
 *
 *  Regole del progetto rispettate: verifica sull'artefatto, numeri solo con fonte e data,
 *  nessun dato interno, nessun segreto stampato.
 */
const fs = require('fs');
const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main';
const BASE = 'https://careauctions.co';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUT = 'qa/ronda-notturna.json';
const ts = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const etaMin = (t) => { const d = new Date(t); return isNaN(d) ? null : Math.round((Date.now() - d.getTime()) / 60000); };

async function http(url, opt = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opt.timeout || 20000);
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      signal: ctl.signal,
      headers: Object.assign({
        'User-Agent': opt.ua || UA,
        'Accept': opt.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.5'
      }, opt.headers || {})
    });
    const testo = opt.leggiCorpo ? await r.text() : '';
    return { status: r.status, location: r.headers.get('location'), tipo: r.headers.get('content-type'), testo };
  } catch (e) {
    return { status: 0, errore: String((e && e.message) || e).slice(0, 120) };
  } finally { clearTimeout(to); }
}

/* 12/11/2026 — lo STATO INTERNO (qa/, mail/, perf/) vive su Cloudflare R2, non più nel repo
 * pubblico: la fonte vera è l'oggetto su R2. Il ripiego sulla raw resta solo per quando il token
 * non c'è (sessione locale) o R2 è irraggiungibile: così l'automazione non resta mai cieca. */
const STATO_SU_R2 = ['/qa/stato.json', '/mail/stato.json', '/perf/stato.json', '/qa/ronda-notturna.json'];
let _statoMod = null;
async function daR2(percorso) {
  try {
    if (!_statoMod) _statoMod = await import('./stato-pubblica.mjs');
    const l = await _statoMod.leggiStato(String(percorso).replace(/^\//, ''));
    return l.ok ? l.json : null;
  } catch (e) { return null; }
}
async function json(t) {
  if (STATO_SU_R2.includes(t)) {
    const j = await daR2(t);
    if (j) return j;
  }
  try {
    const r = await fetch(RAW + t + '?ts=' + ts(), { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function gh(path) {
  const T = process.env.GITHUB_TOKEN;
  if (!T) return null;
  try {
    const r = await fetch('https://api.github.com' + path, { headers: { Authorization: 'Bearer ' + T, Accept: 'application/vnd.github+json', 'User-Agent': 'CARe-Ronda-Notturna' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

const C = [];            // controlli: {nome, ok, livello: 'ok'|'attenzione'|'problemi', dettaglio}
function add(nome, livello, dettaglio) { C.push({ nome, livello, ok: livello === 'ok', dettaglio }); }

(async () => {
  const inizio = iso();

  // ── 1. Rotte del sito ───────────────────────────────────────────────────────
  const ROTTE = ['/', '/idati', '/osservatorio', '/aggiudicazioni', '/ilive', '/novita', '/termini', '/privacy',
    '/cookie', '/affiliazione', '/buynow/san-pasquale', '/ishop', '/compra-ora', '/qa/stato.json',
    '/feed/statistiche.json', '/llms.txt', '/ai/knowledge.json', '/stato', '/robots.txt', '/sitemap.xml'];
  const esitiRotte = await Promise.all(ROTTE.map(async (p) => ({ p, r: await http(BASE + p, { timeout: 15000 }) })));
  const rotteKO = esitiRotte.filter((x) => x.r.status !== 200);
  add('sito: ' + (ROTTE.length - rotteKO.length) + '/' + ROTTE.length + ' rotte 200',
    rotteKO.length ? 'problemi' : 'ok',
    rotteKO.length ? rotteKO.map((x) => x.p + '→' + (x.r.status || 'errore')).join(', ') : 'tutte 200');

  // ── 2. Feed vivo e non svuotato ─────────────────────────────────────────────
  const st = await json('/feed/statistiche.json');
  const etaSt = st && st.aggiornato ? etaMin(st.aggiornato) : null;
  const livSt = etaSt == null ? 'problemi' : (etaSt > 360 ? 'problemi' : (etaSt > 120 ? 'attenzione' : 'ok'));
  add('feed statistiche', livSt, st ? ((st.totale || '?') + ' lotti · aggiornato ' + st.aggiornato + ' (' + etaSt + ' min fa)') : 'irraggiungibile');

  const agg = await json('/feed/aggiudicazioni.json');
  const nAgg = Array.isArray(agg) ? agg.length : (agg && agg.record ? agg.record.length : null);
  add('feed aggiudicazioni', nAgg === 0 ? 'problemi' : (nAgg ? 'ok' : 'attenzione'), nAgg == null ? 'irraggiungibile' : nAgg + ' record');

  // ── 3. QA cloud e QA Orchestra ─────────────────────────────────────────────
  const qa = await json('/qa/stato.json');
  const etaQa = qa && qa.generatedAt ? etaMin(qa.generatedAt) : null;
  add('QA cloud', etaQa == null ? 'problemi' : (etaQa > 360 ? 'problemi' : (etaQa > 120 ? 'attenzione' : 'ok')),
    qa ? ('run ' + (qa.runId || '?') + ' · ' + etaQa + ' min fa · ' + JSON.stringify(qa.summary || {})) : 'irraggiungibile');

  const orch = await json('/qa/orchestra.json');
  const etaOrch = orch && orch.generato ? etaMin(orch.generato) : null;
  add('QA Orchestra', etaOrch == null ? 'attenzione' : (etaOrch > 900 ? 'problemi' : (etaOrch > 480 ? 'attenzione' : 'ok')),
    orch ? (orch.esito + ' · ' + etaOrch + ' min fa') : 'irraggiungibile');

  const sent = await json('/ai/sentinella-stato.json');
  const etaSent = sent && sent.aggiornato ? etaMin(sent.aggiornato) : null;
  /* GitHub strozza la schedule di ai-sentinel (dichiarata ogni 15 minuti, misurata 1 run ogni 6-8 h):
     uno stato vecchio ma verde e senza anomalie e' un buco di monitoraggio, non un guasto del
     sito. Si dichiara «attenzione» e la ronda sveglia il workflow (sezione 7b); «problemi»
     resta per quando la sentinella dice ok:false o segnala anomalie. */
  const sentOk = !!(sent && sent.ok === true && !(sent.anomalie || []).length);
  add('AI Sentinel', etaSent == null ? 'attenzione' : (etaSent > 360 ? (sentOk ? 'attenzione' : 'problemi') : (etaSent > 120 ? 'attenzione' : 'ok')),
    sent ? (etaSent + ' min fa · anomalie: ' + JSON.stringify(sent.anomalie || []).slice(0, 120)) : 'irraggiungibile');

  // ── 4. careauctions.it: DNS (DoH, immune alla cache locale) + watcher + 301 ──
  const vit = await json('/qa/verifica-it.json');
  add('careauctions.it (watcher)', !vit ? 'attenzione' : (vit.stato === 'ok' ? 'ok' : (vit.stato === 'pending' ? 'attenzione' : 'problemi')),
    vit ? (vit.stato + ' · ' + vit.generato) : 'irraggiungibile');

  let dnsNs = [], dnsA = [];
  try {
    const [rNs, rA] = await Promise.all([
      fetch('https://cloudflare-dns.com/dns-query?name=careauctions.it&type=NS', { headers: { accept: 'application/dns-json' } }).then((r) => r.json()),
      fetch('https://cloudflare-dns.com/dns-query?name=careauctions.it&type=A', { headers: { accept: 'application/dns-json' } }).then((r) => r.json())
    ]);
    dnsNs = (rNs.Answer || []).map((x) => x.data);
    dnsA = (rA.Answer || []).map((x) => x.data);
  } catch (e) {}
  const nsOk = dnsNs.some((x) => /cloudflare\.com\.?$/.test(x));
  add('careauctions.it (DNS DoH)', (nsOk && dnsA.length) ? 'ok' : 'problemi',
    'NS ' + (dnsNs.join(', ') || '?') + ' · A ' + (dnsA.join(', ') || '?'));
  async function itTarget(url) {
    let cur = url, hops = 0;
    for (let i = 0; i < 4; i++) {
      const r = await http(cur, { timeout: 12000 });
      if (r.status === 0) return { ok: false, dettaglio: 'rete/TLS a ' + cur, hops };
      if (r.status >= 300 && r.status < 400 && r.location) {
        cur = new URL(r.location, cur).toString(); hops++;
        if (hops > 2) return { ok: false, dettaglio: 'oltre 2 salti (' + cur + ')', hops };
        continue;
      }
      return { ok: cur.startsWith('https://careauctions.co'), dettaglio: cur + ' (' + r.status + ')', hops };
    }
    return { ok: false, dettaglio: 'loop', hops };
  }
  const IT = ['http://careauctions.it/', 'https://careauctions.it/', 'http://www.careauctions.it/', 'https://www.careauctions.it/'];
  const esitiIt = await Promise.all(IT.map(itTarget));
  const itKO = esitiIt.filter((x) => !x.ok);
  // Se il watcher cloud dice ok e qui fallisce solo per TLS/rete, e' quasi sempre la cache DNS
  // del resolver locale (il record vecchio del parcheggio): non e' un guasto del sito.
  const itLiv = itKO.length === 0 ? 'ok' : (vit && vit.stato === 'ok' ? 'attenzione' : 'problemi');
  add('careauctions.it (301 dal vivo)', itLiv,
    esitiIt.map((x, i) => IT[i].replace('https://', '').replace('http://', '') + '→' + x.dettaglio).join(' · '));

  // ── 5. Monitor posta ───────────────────────────────────────────────────────
  const posta = await json('/mail/stato.json');
  const etaPosta = posta && posta.ultimoControllo ? etaMin(posta.ultimoControllo) : null;
  add('monitor posta', etaPosta == null ? 'attenzione' : (etaPosta > 180 ? 'problemi' : (etaPosta > 90 ? 'attenzione' : 'ok')),
    posta ? ('ultimo controllo ' + posta.ultimoControllo + ' (' + etaPosta + ' min fa) · allarmi: ' + ((posta.allarmi || []).length)) : 'irraggiungibile');

  // ── 6. Build allineata ─────────────────────────────────────────────────────
  const [hSito, hOrig] = await Promise.all([
    http(BASE + '/', { leggiCorpo: true, timeout: 20000 }),
    http('https://care-aste.emergent.host/', { leggiCorpo: true, timeout: 20000 })
  ]);
  const hash = (t) => { const m = String(t || '').match(/main\.([a-f0-9]{8})\.js/); return m ? m[1] : null; };
  const h1 = hash(hSito.testo), h2 = hash(hOrig.testo);
  add('build sito = origine', h1 && h2 && h1 === h2 ? 'ok' : 'attenzione',
    'sito ' + (h1 || '?') + ' · origine ' + (h2 || '?'));

  // ── 7. Ultimi run dei workflow che contano ─────────────────────────────────
  const WF = ['feed-sync.yml', 'qa.yml', 'verifica-it.yml', 'mail-qa.yml', 'aggiornamento-mail.yml', 'qa-orchestra.yml', 'ai-sentinel.yml', 'feed-sync.yml'];
  const nomi = [...new Set(WF)];
  const runKo = [];
  for (const wf of nomi) {
    const d = await gh('/repos/PuntoLuce26/care-auctions-pagine/actions/workflows/' + wf + '/runs?per_page=1');
    const r0 = d && d.workflow_runs && d.workflow_runs[0];
    if (!r0) { runKo.push(wf + ': nessuna run'); continue; }
    const eta = etaMin(r0.updated_at);
    if (r0.conclusion === 'failure' && eta < 180) runKo.push(wf + ' rossa ' + eta + ' min fa (run ' + r0.run_number + ')');
  }
  add('workflow GitHub', runKo.length ? 'attenzione' : 'ok', runKo.length ? runKo.join(' · ') : 'nessun rosso nelle ultime 3 h');

  // ── 7b. Sveglia dei monitoraggi che GitHub dirada ──────────────────────────
  // GitHub strozza le schedule: mail-qa, verifica-it e il digest ogni 3 ore possono restare
  // fermi per ore. La ronda fa da battito: se li vede fermi, li lancia.
  const sveglie = [];
  async function sveglia(wf) {
    try {
      const r = await fetch('https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/actions/workflows/' + wf + '/dispatches', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'CARe-Ronda-Notturna', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main' })
      });
      sveglie.push(wf + (r.status === 204 ? ' lanciato' : ' http ' + r.status));
    } catch (e) { sveglie.push(wf + ' errore'); }
  }
  if (process.env.GITHUB_TOKEN) {
    if (etaSt != null && etaSt > 90) await sveglia('feed-sync.yml');
    if (etaPosta != null && etaPosta > 45) await sveglia('mail-qa.yml');
    if (etaSent != null && etaSent > 150) await sveglia('ai-sentinel.yml');
    const etaVit = vit && vit.generato ? etaMin(vit.generato) : null;
    if (etaVit != null && etaVit > 40) await sveglia('verifica-it.yml');
    const dAgg = await gh('/repos/PuntoLuce26/care-auctions-pagine/actions/workflows/aggiornamento-mail.yml/runs?per_page=1');
    const rAgg = dAgg && dAgg.workflow_runs && dAgg.workflow_runs[0];
    const etaAgg = rAgg ? etaMin(rAgg.updated_at) : null;
    if (etaAgg != null && etaAgg > 240) await sveglia('aggiornamento-mail.yml');
  }
  add('sveglie dei monitoraggi', 'ok', sveglie.length ? sveglie.join(' · ') : 'nessuna necessaria');

  // ── Verdetto ───────────────────────────────────────────────────────────────
  const problemi = C.filter((c) => c.livello === 'problemi');
  const attenzioni = C.filter((c) => c.livello === 'attenzione');
  const stato = problemi.length ? 'problemi' : (attenzioni.length ? 'attenzione' : 'ok');

  let prec = null;
  try { prec = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { prec = null; }
  const firma = (s) => JSON.stringify((s || []).map((x) => x.nome).sort());
  const firmaOra = firma(problemi);
  const cambiato = !prec || prec.stato !== stato || firma(prec.problemi || []) !== firmaOra;
  const storico = ((prec && prec.storico) || []).slice(-7);
  storico.push({ t: inizio, stato, problemi: problemi.map((x) => x.nome) });

  const out = {
    generato: inizio,
    stato,
    controlli: C,
    problemi: problemi.map((x) => ({ nome: x.nome, dettaglio: x.dettaglio })),
    attenzioni: attenzioni.map((x) => ({ nome: x.nome, dettaglio: x.dettaglio })),
    storico
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  const righe = C.map((c) => (c.livello === 'ok' ? 'OK  ' : (c.livello === 'attenzione' ? 'ATT ' : 'KO  ')) + c.nome + ' — ' + c.dettaglio);
  console.log('RONDA ' + inizio + ' · stato: ' + stato.toUpperCase());
  righe.forEach((r) => console.log('  ' + r));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '## Ronda ' + inizio + ' — **' + stato.toUpperCase() + '**\n\n' +
      C.map((c) => '| ' + (c.livello === 'ok' ? '✅' : (c.livello === 'attenzione' ? '⚠️' : '❌')) + ' | ' + c.nome + ' | ' + String(c.dettaglio).replace(/\|/g, '/') + ' |').join('\n') + '\n');
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'stato=' + stato + '\ncommit=' + ((cambiato || process.env.RONDA_MAIL === '1') ? 'true' : 'false') + '\n');
  }

  // ── 8. Riepilogo del mattino via Gmail (una volta sola, alle 06:10 UTC) ────
  if (process.env.RONDA_MAIL === '1') {
    const notte = storico.filter((s) => /T(2[0-3]|0[0-6]):/.test(s.t) || true);
    const email = [
      'Ronda notturna CARe — ' + new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' }),
      '',
      'STATO: ' + stato.toUpperCase(),
      'Giri nelle ultime ore: ' + notte.length + ' (problemi: ' + notte.filter((s) => s.stato === 'problemi').length + ')',
      '',
      ...C.map((c) => (c.livello === 'ok' ? 'OK  ' : (c.livello === 'attenzione' ? 'ATT ' : 'KO  ')) + c.nome + ': ' + c.dettaglio),
      '',
      sveglie.length ? 'Monitoraggi svegliati stanotte: ' + sveglie.join(', ') : '',
      problemi.length ? 'DA FARE OGGI: ' + problemi.map((p) => p.nome).join(', ') : 'DA FARE OGGI: niente di urgente dalla ronda.',
      attenzioni.length ? 'Da tenere d occhio: ' + attenzioni.map((p) => p.nome).join(', ') : '',
      '',
      '— ronda notturna automatica CARe (cloud)'
    ].filter((x) => x !== '').join('\n');
    const CID = process.env.GMAIL_CLIENT_ID, CSEC = process.env.GMAIL_CLIENT_SECRET, RT = process.env.GMAIL_REFRESH_TOKEN;
    if (CID && CSEC && RT) {
      try {
        const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: CID, client_secret: CSEC, refresh_token: RT, grant_type: 'refresh_token' }) });
        const tj = await tr.json();
        if (!tr.ok) throw new Error('refresh fallito: ' + JSON.stringify(tj).slice(0, 150));
        const H = { Authorization: 'Bearer ' + tj.access_token };
        const prof = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: H })).json();
        const oggetto = 'CARe — notte ' + new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }) + ': ' + stato.toUpperCase() + ' (' + problemi.length + ' problemi)';
        const mime = ['From: ' + prof.emailAddress, 'To: ' + (process.env.MAIL_TO || prof.emailAddress),
          'Subject: =?UTF-8?B?' + Buffer.from(oggetto, 'utf8').toString('base64') + '?=',
          'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', email].join('\r\n');
        const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const s = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ raw }) })).json();
        if (!s.id) throw new Error('invio fallito: ' + JSON.stringify(s).slice(0, 150));
        console.log('EMAIL MATTINO INVIATA · id ' + s.id + ' · a ' + (process.env.MAIL_TO || prof.emailAddress));
      } catch (e) {
        console.log('EMAIL MATTINO NON INVIATA: ' + String(e.message || e).slice(0, 200));
      }
    } else {
      console.log('Secret Gmail assenti: riepilogo solo nel log.');
      console.log(email);
    }
  }

  // Run rossa solo per problemi veri e nuovi: una mail di GitHub per condizione, non per giro.
  if (problemi.length && cambiato) {
    console.log('::error::Ronda: ' + problemi.length + ' problemi (' + problemi.map((p) => p.nome).join(', ') + ')');
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => {
  console.log('::error::ronda-notturna: ' + String((e && e.stack) || e).slice(0, 500));
  process.exit(1);
});
