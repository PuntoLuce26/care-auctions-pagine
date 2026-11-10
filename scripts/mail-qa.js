#!/usr/bin/env node
/* mail-qa: legge info@careauctions.co e info@puntoluce26.com, riconosce le mail di errore
   e lancia il QA cloud (repository_dispatch email-alert). Cloud, ogni 10 minuti. */
const fs = require('fs'), path = require('path');
const CRED = JSON.parse(process.env.GMAIL_CREDENTIALS || '{}');
const TOK = JSON.parse(process.env.GMAIL_TOKEN || '{}');
const C = CRED.installed || CRED.web || CRED;
const REPO = process.env.GITHUB_REPOSITORY || 'PuntoLuce26/care-auctions-pagine';
const GH = process.env.GITHUB_TOKEN;
const STATE = path.join(process.cwd(), 'mail', 'stato.json');
let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) {}
const done = new Set(st.processati || []);
const Q = '(to:info@careauctions.co OR deliveredto:info@careauctions.co OR to:info@puntoluce26.com OR deliveredto:info@puntoluce26.com) newer_than:2d';
const ERR = /run failed|failed|failure|errore|error|exception|critical|\u26a0|qualcosa non va|not working|down|500|502|503|504|timeout|build and deployment|deploy|pages build|guardiano|sospeso|suspended|payment failed|rifiutato|insoluto|scadenza|dns|ssl|dmarc|spf|bounce|postmaster|credits|quota/i;
const IGNORE = /nuovo pagamento|newsletter|offers|what.s new|share ai skills|test intestazioni|richiesta di visita|pagamento da|nuovo pagamento|fattura|ricevuta|ordine/i;
/* Le mail che le NOSTRE automazioni mandano a info@ dicendo "tutto ok" non sono allarmi:
   senza questo filtro il digest notturno diventa un allarme critico e rilancia il QA in loop. */
const SELF_OK = /^info@(puntoluce26\.com|careauctions\.co)$/i;
const SELF_OK_SUBJ = /qa tutto ok|prova patch|\(0 problemi\)|nessun problema/i;
function comp(from, sub, txt) {
  const t = (from + ' ' + sub + ' ' + txt).toLowerCase();
  if (/pages build|build and deployment|deploy pages/.test(t)) return 'pages';
  if (/prerender/.test(t)) return 'prerender';
  if (/app-ci|care-aste-app/.test(t)) return 'app-ci';
  if (/second-brain|peso/.test(t)) return 'second-brain';
  if (/guardiano|care: qualcosa|non va/.test(t)) return 'guardiano';
  if (/feed|statistiche/.test(t)) return 'feed';
  if (/cloudflare|edge|worker/.test(t)) return 'edge';
  if (/emergent/.test(t)) return 'emergent';
  if (/paypal|stripe|finom|klarna|payment|pagamento|insoluto/.test(t)) return 'pagamenti';
  if (/gmail|dmarc|spf|dns|postmaster|bounce/.test(t)) return 'email';
  if (/github|actions|run failed/.test(t)) return 'github-actions';
  return 'altro';
}
function sev(comp, txt) {
  const t = txt.toLowerCase();
  if (/500|502|503|504|down|not working|sospeso|suspended|insoluto|critical/.test(t)) return 'critica';
  if (comp === 'guardiano' || comp === 'pages' || comp === 'app-ci' || comp === 'second-brain') return 'alta';
  return 'media';
}
async function access() {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: C.client_id, client_secret: C.client_secret, refresh_token: TOK.refresh_token, grant_type: 'refresh_token' }) });
  const j = await r.json(); if (!j.access_token) throw new Error('refresh fallito'); return j.access_token;
}
async function gget(at, u) { const r = await fetch(u, { headers: { Authorization: 'Bearer ' + at } }); return r.json(); }
function bodyText(p) {
  if (!p) return '';
  if (p.body && p.body.data) { try { return Buffer.from(p.body.data, 'base64url').toString('utf8'); } catch (e) {} }
  return (p.parts || []).map(bodyText).join('\n');
}
(async () => {
  const at = await access();
  const list = await gget(at, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=' + encodeURIComponent(Q));
  const msgs = list.messages || []; const nuovi = [];
  for (const m of msgs) {
    if (done.has(m.id)) continue;
    const d = await gget(at, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id + '?format=full');
    const h = {}; for (const x of (d.payload && d.payload.headers) || []) h[x.name.toLowerCase()] = x.value;
    const testo = ((h.subject || '') + ' ' + (h.from || '') + ' ' + (d.snippet || '') + ' ' + bodyText(d.payload)).slice(0, 4000);
    const fromAddr = ((h.from || '').match(/<([^>]+)>/) || [null, h.from || ''])[1].trim();
    if (SELF_OK.test(fromAddr) && SELF_OK_SUBJ.test((h.subject || '') + ' ' + (d.snippet || ''))) { done.add(m.id); continue; }
    if (IGNORE.test(testo) || !ERR.test(testo)) { done.add(m.id); continue; }
    const c = comp(h.from || '', h.subject || '', testo);
    const s = sev(c, testo);
    const link = (testo.match(/https?:\/\/[^\s"'<>]+/) || [])[0] || '';
    /* mail/stato.json e la issue [QA] finiscono in un repo PUBBLICO: il soggetto di una mail
       non-GitHub puo' contenere nomi di clienti, importi, conti o link di pagamento.
       Si pubblica solo l'allarme (componente + gravita'), mai il testo della mail. */
    const daGithub = /(^|@)github\.com$/i.test(fromAddr) || /\[PuntoLuce26\//.test(h.subject || '');
    const oggetto = daGithub ? (h.subject || '').slice(0, 200) : '[oggetto riservato · ' + c + ']';
    nuovi.push({ id: m.id, data: new Date(Number(d.internalDate)).toISOString(), da: daGithub ? (h.from || '').slice(0, 160) : ('mittente riservato · ' + c), oggetto, a: (h.to || h['delivered-to'] || '').slice(0, 160), componente: c, gravita: s, link: daGithub ? link.slice(0, 300) : '' });
    done.add(m.id);
  }
  const qaAlerts = nuovi.filter(x => x.gravita !== 'bassa');
  let qaEsito = 'nessun allarme nuovo';
  if (qaAlerts.length) {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/dispatches', { method: 'POST', headers: { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json', 'User-Agent': 'care-mail-qa', 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'email-alert', client_payload: { fonte: 'mail-qa', generato: new Date().toISOString(), conteggio: qaAlerts.length, alerts: qaAlerts } }) });
    qaEsito = 'QA dispatch HTTP ' + r.status;
  }
  const out = { ultimoControllo: new Date().toISOString(), ultimoQa: nuovi.length ? new Date().toISOString() : (st.ultimoQa || null), qaEsito, nuoveMail: nuovi.length, allarmi: nuovi, processati: Array.from(done).slice(-600) };
  fs.mkdirSync(path.join(process.cwd(), 'mail'), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ nuove: nuovi.length, alert: qaAlerts.length, qa: qaEsito, componenti: qaAlerts.map(x => x.componente) }));
})().catch(e => { console.error('MAIL-QA ERRORE', e.message); process.exit(1); });

