#!/usr/bin/env node
/** aggiornamento-mail.js — digest del QA Orchestra, inviato in cloud (senza il Mac).
 *  Se ci sono i secret Gmail manda l'email; altrimenti stampa il corpo (il workflow lo
 *  pubblica come commento su una issue, che GitHub recapita per email). */
const fs = require('fs');
const RAW = 'https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main';
const ts = () => Math.floor(Date.now() / 1000);
async function j(u) { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch (e) { return null; } }

(async () => {
  const o = await j(RAW + '/qa/orchestra.json?ts=' + ts());
  const m = await j(RAW + '/mail/stato.json?ts=' + ts());
  const ora = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  if (!o) { console.log('Orchestra non leggibile'); process.exit(1); }
  const ko = (o.controlli || []).filter((c) => !c.ok && !c.skip);
  const nv = (o.controlli || []).filter((c) => c.skip);
  const pick = (n) => (o.controlli || []).find((c) => c.nome === n) || { dettaglio: 'n/d' };
  const righe = [];
  righe.push('Report del QA Orchestra — ' + ora);
  righe.push('');
  righe.push('ESITO: ' + o.esito);
  righe.push('Sintesi: ' + o.sintesi);
  righe.push('');
  if (ko.length) {
    righe.push('Controlli NON passati:');
    for (const c of ko.slice(0, 8)) righe.push('- ' + c.nome + ': ' + c.dettaglio);
  } else {
    righe.push('Controlli chiave:');
    for (const n of ['qa/stato.json', 'build sito = origine', 'feed statistiche', 'feed aggiudicazioni', 'iCARe chat', 'posta: ultima scansione (<6 h)']) righe.push('- ' + n + ': ' + pick(n).dettaglio);
  }
  righe.push('');
  if (nv.length) righe.push(nv.length + ' controlli non verificabili dal cloud (token di un solo repo).');
  if (m) righe.push('Posta: ultima scansione ' + (m.ultimoControllo || '?') + ' · ' + (m.nuoveMail || 0) + ' mail · ' + ((m.allarmi || []).length) + ' allarmi.');
  righe.push('');
  righe.push(ko.length ? 'Da fare: ' + ko.slice(0, 2).map((c) => c.nome).join(', ') : 'Nessun intervento richiesto.');
  righe.push('— aggiornamento automatico CARe (cloud)');
  const body = righe.join('\n');
  const subject = 'CARe — QA ' + o.esito + ' · ' + ora;

  const CID = process.env.GMAIL_CLIENT_ID, CSEC = process.env.GMAIL_CLIENT_SECRET, RT = process.env.GMAIL_REFRESH_TOKEN;
  if (CID && CSEC && RT) {
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: CID, client_secret: CSEC, refresh_token: RT, grant_type: 'refresh_token' }) });
    const tj = await tr.json();
    if (!tr.ok) { console.error('refresh fallito:', tj.error); process.exit(1); }
    const H = { Authorization: 'Bearer ' + tj.access_token };
    const prof = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: H })).json();
    const mime = ['From: ' + prof.emailAddress, 'To: ' + (process.env.MAIL_TO || prof.emailAddress),
      'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=',
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n');
    const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const s = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ raw }) })).json();
    if (!s.id) { console.error('invio fallito:', JSON.stringify(s)); process.exit(1); }
    console.log('EMAIL INVIATA · id ' + s.id + ' · a ' + (process.env.MAIL_TO || prof.emailAddress));
    fs.writeFileSync('/tmp/aggiornamento.txt', body);
    process.exit(0);
  }
  console.log('Secret Gmail assenti: digest pubblicato come issue (GitHub manda l email).');
  fs.writeFileSync('/tmp/aggiornamento.txt', body);
  console.log('\n' + body);
})();
