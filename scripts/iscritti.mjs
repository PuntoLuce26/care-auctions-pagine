#!/usr/bin/env node
/**
 * iscritti.mjs — solo NUMERI, pubblici e redatti: nessun nome, email, telefono.
 * Fonti: azione `pionieri` del worker icare-ai, KV TRAFFICO (conteggi chat), R2 care-stato (allarmi).
 * Quello che vive solo nel database dell'app si dichiara "non leggibile da qui": non si inventa.
 */
import fs from 'node:fs';

const CF = process.env.CLOUDFLARE_API_TOKEN || '';
const ACC = process.env.CF_ACCOUNT || 'd5d20864ee7f83c32c9eeb5fcbda6edb';
const KV = process.env.CF_KV || '432827253eed4b6a97eef2977f096ce9';
const WORKER = 'https://icare-ai.misty-mode-1cbc.workers.dev';
const OUT = 'qa/iscritti.json';
const RUN_MD = 'qa/RUN.md';

const rome = () => new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour12: false });

async function pionieri(tipo) {
  try {
    const r = await fetch(WORKER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ azione: 'pionieri', tipo }) });
    const j = await r.json();
    return { numero: j.pionieri ?? null, obiettivo: j.obiettivo ?? null, fonte: 'worker icare-ai · azione pionieri · tabella Supabase pionieri' };
  } catch (e) { return { numero: null, fonte: 'worker icare-ai · azione pionieri', stato: 'non leggibile ora: ' + e.message }; }
}

async function kvValore(chiave) {
  if (!CF) return null;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/storage/kv/namespaces/${KV}/values/${encodeURIComponent(chiave)}`, { headers: { Authorization: 'Bearer ' + CF } });
    if (!r.ok) return null;
    const t = await r.text();
    const n = Number(t.trim());
    return isFinite(n) ? n : null;
  } catch { return null; }
}

async function r2(chiave) {
  if (!CF) return null;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/care-stato/objects/${encodeURIComponent(chiave)}`, { headers: { Authorization: 'Bearer ' + CF } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const oggi = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const giorni = Array.from({ length: 8 }, (_, i) => { const d = new Date(oggi); d.setUTCDate(d.getUTCDate() - i); return iso(d); });

const [pIcare, pPartner] = await Promise.all([pionieri('icare'), pionieri('ipartner')]);
const chatGiorni = {};
for (const g of giorni) { const v = await kvValore('icare:ai:' + g); if (v !== null) chatGiorni[g] = v; }
const chat24 = chatGiorni[iso(oggi)] ?? null;
const chat7 = Object.values(chatGiorni).reduce((s, x) => s + x, 0);
const mail = await r2('stato/mail/stato.json');

const out = {
  generato: new Date().toISOString(),
  ora_roma: rome(),
  nota: 'Solo numeri. Nessun dato personale, nessun token. Rigenerato a ogni attività e almeno ogni 30 minuti.',
  voci: {
    pionieri_icare: { ...pIcare, misurato: pIcare.numero !== null },
    pionieri_ipartner: { ...pPartner, misurato: pPartner.numero !== null },
    utenti_registrati_sito: { numero: null, fonte: 'database dell app (Emergent)', stato: 'non leggibile da qui' },
    professionisti_icarepro: { numero: null, fonte: 'database dell app (Emergent)', stato: 'non leggibile da qui' },
    accettazioni_termini_pro: { numero: null, fonte: 'database dell app (Emergent)', stato: 'non leggibile da qui' },
    ipartner_attivi: { numero: null, fonte: 'database dell app (Emergent)', stato: 'non leggibile da qui' },
    abbonamenti_attivi_per_piano: { numero: null, fonte: 'app + PayPal/Stripe', stato: 'non leggibile da qui' },
    allarmi_attivi: { numero: mail && Array.isArray(mail.allarmi) ? mail.allarmi.length : null, fonte: 'R2 care-stato · stato/mail/stato.json', misurato: !!(mail && mail.allarmi), ultimoControllo: mail ? mail.ultimoControllo : null },
    chat_icare_24h: { numero: chat24, fonte: 'KV TRAFFICO · icare:ai:<data>', misurato: chat24 !== null },
    chat_icare_7g: { numero: chat7, fonte: 'KV TRAFFICO · icare:ai:<data>', misurato: Object.keys(chatGiorni).length > 0, giorni_con_dato: Object.keys(chatGiorni).length },
  },
  fonti_non_leggibili: ['utenti_registrati_sito', 'professionisti_icarepro', 'accettazioni_termini_pro', 'ipartner_attivi', 'abbonamenti_attivi_per_piano'],
  via_a_costo_minimo: 'Una rotta /api/conteggi nell app (Emergent) che restituisce SOLO questi numeri, protetta da un segreto gestito da Sam, letta da questo stesso workflow.',
};
fs.mkdirSync('qa', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

const riga = `\n## Iscritti (${out.ora_roma})\n\n- pionieri iCARe **${pIcare.numero ?? 'n/d'}** (obiettivo ${pIcare.obiettivo ?? 'n/d'}) · iPartner **${pPartner.numero ?? 'n/d'}** · chat iCARE **${chat24 ?? 'n/d'}** nelle 24 h · **${chat7}** negli ultimi giorni con dato · allarmi attivi **${out.voci.allarmi_attivi.numero ?? 'n/d'}**\n- non leggibili da qui (database dell'app): utenti registrati, professionisti iCARePro, accettazioni Termini Pro, iPartner, abbonamenti per piano\n- file completo: \`qa/iscritti.json\`\n`;
try { fs.appendFileSync(RUN_MD, riga); } catch { fs.writeFileSync(RUN_MD, '# Run GitHub — riassunto redatto\n' + riga); }
console.log(JSON.stringify({ ok: true, generato: out.generato, pionieri: pIcare.numero, chat24, chat7, allarmi: out.voci.allarmi_attivi.numero }));
