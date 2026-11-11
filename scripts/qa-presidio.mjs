#!/usr/bin/env node
/** qa-presidio.mjs — il presidio che parla: chi sbaglia, chi risolve, e una mail quando cambia qualcosa.
 *  Ogni 15 minuti (GitHub Actions) guarda i run del repo e le issue aperte, capisce il DETENTORE
 *  del problema (edge, worker, feed, app/Emergent, infrastruttura GitHub) e manda UNA mail solo
 *  quando lo stato cambia: nuovo rosso, o rosso risolto. Mai una mail per confermare il silenzio.
 *
 *  Guardia sui costi: questo script NON lancia publish né workflow di Emergent. Classifica e basta.
 *  Se il problema è dell'app, la mail dice cosa chiedere — non pubblica niente da sola. */
import fs from 'node:fs';

const GH = process.env.GITHUB_TOKEN;
const TO = (process.env.MAIL_TO || 'info@puntoluce26.com').split(',').map((s) => s.trim()).filter(Boolean);
const FROM = process.env.MAIL_FROM || 'info@puntoluce26.com';
const REPO = process.env.GITHUB_REPOSITORY || 'PuntoLuce26/care-auctions-pagine';
const STATO = 'qa/presidio.json';
const H = { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json', 'User-Agent': 'CARe-QA-presidio' };

const get = async (u) => { const r = await fetch(u, { headers: H }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); };

/** Chi deve risolvere: si decide dal nome del workflow e dalla rotta, non a naso. */
function detentore(nome, fallimento) {
  const n = (nome || '').toLowerCase();
  if (/traduzioni|i18n/.test(n)) return { chi: 'noi · traduzioni (GitHub Actions)', cosa: 'rigenerare i18n (workflow traduzioni)' };
  if (/feed|esiti|oshi|ocr|perizie|npl/.test(n)) return { chi: 'noi · feed cloud', cosa: 'controllare il workflow e il feed servito da raw' };
  if (/qa|verifica|shell|guardiano|presidio/.test(n)) return { chi: 'noi · QA', cosa: 'rileggere il report QA e la rotta indicata' };
  if (/pages|deploy/.test(n)) return { chi: 'GitHub Pages (piattaforma)', cosa: 'attendere e verificare l\'artefatto; se dura, forzare un rebuild' };
  if (/edge|worker|careauctions-edge|icare-ai/.test(n)) return { chi: 'noi · edge/worker', cosa: 'deployare la correzione e verificare sull\'artefatto' };
  if (/emergent|prerender/.test(n)) return { chi: 'Emergent (app)', cosa: 'inviare il brief del difetto; NON ripubblicare in automatico' };
  return { chi: 'da capire', cosa: 'leggere il log e assegnare' };
}

const run = async () => {
  const corre = await get(`https://api.github.com/repos/${REPO}/actions/runs?per_page=60`);
  const ora = Date.now();
  const recenti = corre.workflow_runs.filter((r) => ora - new Date(r.created_at).getTime() < 90 * 60 * 1000);
  // un run cancellato da un commit nuovo NON è un guasto
  const rossi = recenti.filter((r) => ['failure', 'timed_out'].includes(r.conclusion));
  const issue = (await get(`https://api.github.com/repos/${REPO}/issues?state=open&per_page=30`)).filter((i) => !i.pull_request);

  let prima = { rossi: [], risolti: [], ultimaMail: null };
  try { prima = JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (e) {}

  const firma = (r) => `${r.name}#${r.run_number}`;
  const primaSet = new Set(prima.rossi || []);
  const oraSet = new Set(rossi.map(firma));

  const nuovi = rossi.filter((r) => !primaSet.has(firma(r)));
  // risolti: erano rossi nel giro prima e ora quel workflow ha un success più recente
  const risolti = [];
  for (const vecchio of (prima.rossi || [])) {
    const [nome] = vecchio.split('#');
    const ultimo = corre.workflow_runs.find((r) => r.name === nome);
    if (ultimo && ultimo.conclusion === 'success' && !oraSet.has(vecchio)) risolti.push(nome);
  }

  const righe = [];
  for (const r of nuovi) {
    const d = detentore(r.name, r.conclusion);
    righe.push({ tipo: 'nuovo', quando: r.created_at, nome: r.name, num: r.run_number, chi: d.chi, cosa: d.cosa, url: r.html_url });
  }
  for (const nome of risolti) righe.push({ tipo: 'risolto', nome, chi: '', cosa: '', url: '' });

  const stato = { aggiornato: new Date().toISOString(), rossi: [...oraSet], issue: issue.map((i) => i.title).slice(0, 20), ultimaMail: prima.ultimaMail };
  fs.mkdirSync('qa', { recursive: true });
  fs.writeFileSync(STATO, JSON.stringify(stato, null, 1));

  if (!righe.length) { console.log('presidio: nessun cambiamento (' + rossi.length + ' rossi aperti)'); return; }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<div style="font-family:-apple-system,system-ui,sans-serif;color:#0F1E3A;max-width:640px">
    <p style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#A2977E;margin:0 0 6px">CAReAuctions · presidio QA</p>
    <h2 style="font-weight:400;margin:0 0 14px">${nuovi.length} nuovi problemi · ${risolti.length} risolti</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><th align="left" style="border-bottom:1px solid #E3D9C0;padding:6px 4px">Stato</th><th align="left" style="border-bottom:1px solid #E3D9C0;padding:6px 4px">Workflow</th><th align="left" style="border-bottom:1px solid #E3D9C0;padding:6px 4px">Chi</th><th align="left" style="border-bottom:1px solid #E3D9C0;padding:6px 4px">Cosa fare</th></tr>
      ${righe.map((r) => `<tr><td style="padding:6px 4px;white-space:nowrap">${r.tipo === 'risolto' ? '✅ risolto' : '🔴 nuovo'}</td><td style="padding:6px 4px">${esc(r.nome)}${r.num ? ' <span style="color:#8A7F68">#' + r.num + '</span>' : ''}</td><td style="padding:6px 4px">${esc(r.chi)}</td><td style="padding:6px 4px">${esc(r.cosa)}${r.url ? ' · <a href="' + r.url + '">log</a>' : ''}</td></tr>`).join('')}
    </table>
    <p style="font-size:12px;color:#8A7F68;margin-top:16px">Presidio ogni 15 minuti. Nessun publish automatico: i problemi dell'app vanno a Emergent come brief, mai come deploy a sorpresa.</p>
  </div>`;

  // invio con Gmail API (le stesse credenziali del worker), mai più di una mail ogni 20 minuti
  const ultima = prima.ultimaMail ? new Date(prima.ultimaMail).getTime() : 0;
  if (Date.now() - ultima < 20 * 60 * 1000) { console.log('presidio: mail saltata (meno di 20 minuti dall\'ultima)'); return; }
  try {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET, refresh_token: process.env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' })
    }).then((r) => r.json());
    if (!tok.access_token) throw new Error('refresh fallito: ' + JSON.stringify(tok).slice(0, 150));
    const mime = ['From: ' + FROM, 'To: ' + TO.join(', '), 'Subject: =?UTF-8?B?' + Buffer.from('CARe presidio: ' + nuovi.length + ' nuovi · ' + risolti.length + ' risolti').toString('base64') + '?=', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', '', html].join('\r\n');
    const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw })
    });
    const j = await r.json();
    if (j.id) { stato.ultimaMail = new Date().toISOString(); fs.writeFileSync(STATO, JSON.stringify(stato, null, 1)); console.log('mail inviata', j.id); }
    else console.log('mail KO', JSON.stringify(j).slice(0, 200));
  } catch (e) { console.log('mail non inviata:', e.message); }
};

run().catch((e) => { console.error('ERRORE presidio:', e.message); process.exit(1); });
