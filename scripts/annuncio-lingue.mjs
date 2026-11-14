#!/usr/bin/env node
/**
 * annuncio-lingue.mjs — rigenera le lingue dell'annuncio San Pasquale che il traduttore
 * automatico ha reso illeggibili, e VERIFICA il risultato prima di scrivere.
 *
 * Perché esiste (14/11/2026): `@cf/meta/m2m100-1.2b` su 8 lingue a risorse basse non traduce —
 * restituisce frasi memorizzate senza rapporto col testo (es. irlandese: «Tá tús á chur amárach
 * le hobair athchóirithe…», cioè un pezzo di cronaca sui lavori in 22 scuole). Il titolo servito
 * non conteneva né «BuyNow» né «259», quindi quelle 8 pagine erano fuori dalla sitemap buynon.
 *
 * Motori, in ordine (decisione del 14/11, direttiva: prima il modello, poi l'inglese):
 *   1. llm     — azione `traduci-llm` del worker icare-ai (Workers AI llama, prompt di traduzione)
 *   2. m2m100  — azione `traduci` (documenta che il vecchio motore restituisce ancora testo rotto)
 *   3. inglese — fallback dichiarato: titolo e testo in inglese + nota nel feed (mai un «�»)
 *
 * Regola: una lingua si scrive nel feed SOLO se il titolo passa la verifica
 * (contiene BuyNow e 259, nessun U+FFFD, nessuna ripetizione patologica, non è l'italiano copiato).
 *
 * Uso:
 *   LINGUE=ga,gu,km,lv,mg,my,ne,kn REGIA_KEY=… node scripts/annuncio-lingue.mjs
 *   MOTORE=inglese …  (salta i motori e va dritto al fallback dichiarato)
 *   SECCO=1 …         (scrive e basta, senza chiamare i motori: per riallineare il file)
 */
import fs from 'node:fs';

const WORKER = process.env.WORKER || 'https://icare-ai.misty-mode-1cbc.workers.dev';
const KEY = process.env.REGIA_KEY || '';
const FEED = 'feed/annuncio-san-pasquale-i18n.json';
const REPORT = 'feed/annuncio-san-pasquale-i18n-report.json';
const CAMPI = ['titolo', 'h1', 'descrizione', 'corpo', 'faq1d', 'faq1r', 'faq2d', 'faq2r', 'faq3d', 'faq3r', 'faq4d', 'faq4r'];
const MODELLI = (process.env.MODELLI || '@cf/meta/llama-3.1-8b-instruct,@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/meta/llama-3.2-3b-instruct').split(',').map((s) => s.trim()).filter(Boolean);
const MOTORE = (process.env.MOTORE || 'auto').toLowerCase();
const LINGUE = (process.env.LINGUE || 'ga,gu,km,lv,mg,my,ne,kn').split(',').map((s) => s.trim()).filter(Boolean);

const NOMI = {
  ga: 'Irish (Gaeilge)', gu: 'Gujarati', km: 'Khmer', lv: 'Latvian', mg: 'Malagasy',
  my: 'Burmese (Myanmar)', ne: 'Nepali', kn: 'Kannada', gl: 'Galician', cy: 'Welsh',
  mt: 'Maltese', lb: 'Luxembourgish', fil: 'Filipino', tl: 'Filipino'
};

const fffd = (s) => String(s || '').includes('\uFFFD');

/** ripetizione patologica: una sequenza di 4 parole che torna 3+ volte (mg/km/my ne erano pieni) */
function ripetitivo(s) {
  const w = String(s || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (w.length < 12) return false;
  const viste = new Map();
  for (let i = 0; i + 4 <= w.length; i++) {
    const g = w.slice(i, i + 4).join(' ');
    viste.set(g, (viste.get(g) || 0) + 1);
  }
  for (const n of viste.values()) if (n >= 3) return true;
  return false;
}

const rapportoOk = (testo, fonte, min = 0.3, max = 4) => {
  const r = String(testo || '').length / Math.max(1, String(fonte || '').length);
  return r >= min && r <= max;
};

/** il titolo è la prova che conta: BuyNow + 259 + niente caratteri rotti */
function titoloValido(t, fonte) {
  const s = String(t || '').trim();
  if (!s || s.length < 15 || s.length > 180) return 'lunghezza';
  if (fffd(s)) return 'U+FFFD';
  if (!/buynow/i.test(s)) return 'senza BuyNow';
  if (!/259/.test(s)) return 'senza 259';
  if (/[<>]/.test(s)) return 'HTML';
  if (ripetitivo(s)) return 'ripetizione';
  if (s.toLowerCase() === String(fonte || '').toLowerCase().trim()) return 'identico all\'italiano';
  return null;
}

function recordValido(obj, it, en) {
  const motivi = [];
  const t = titoloValido(obj.titolo, it.titolo);
  if (t) motivi.push('titolo: ' + t);
  for (const k of CAMPI) {
    const v = String(obj[k] || '').trim();
    if (!v) { motivi.push(k + ': vuoto'); continue; }
    if (fffd(v)) motivi.push(k + ': U+FFFD');
    if (ripetitivo(v)) motivi.push(k + ': ripetizione');
    if (!rapportoOk(v, it[k], 0.25, 4)) motivi.push(k + ': lunghezza fuori scala');
    if (k !== 'titolo' && en && v === String(en[k] || '').trim()) motivi.push(k + ': identico all\'inglese');
  }
  return motivi;
}

async function chiama(azione, corpo) {
  const r = await fetch(WORKER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ azione, chiave: KEY }, corpo))
  });
  const testo = await r.text();
  let j = null;
  try { j = JSON.parse(testo); } catch { /* risposta non JSON */ }
  if (!j) throw new Error(azione + ': risposta non JSON (' + r.status + ') ' + testo.slice(0, 120));
  return { stato: r.status, corpo: j };
}

async function traduciLLM(lingua, valori) {
  const out = [];
  let modello = null;
  const tentativi = [];
  for (const m of MODELLI) {
    const { corpo } = await chiama('traduci-llm', { testi: valori, da: 'it', a: lingua, linguaNome: NOMI[lingua] || lingua, modelli: [m] });
    tentativi.push({ modello: m, ok: !!corpo.ok, errore: corpo.errore || null });
    if (corpo.ok && Array.isArray(corpo.traduzioni) && corpo.traduzioni.length === valori.length) {
      modello = m;
      corpo.traduzioni.forEach((x) => out.push(String(x || '').trim()));
      break;
    }
  }
  return { modello, valori: out, tentativi };
}

async function traduciM2M(lingua, valori) {
  const { corpo } = await chiama('traduci', { testi: valori, da: 'it', a: lingua });
  return Array.isArray(corpo.traduzioni) ? corpo.traduzioni.map((x) => String(x || '').trim()) : [];
}

const daObj = (valori) => { const o = {}; CAMPI.forEach((k, i) => { o[k] = valori[i]; }); return o; };

(async () => {
  const feed = JSON.parse(fs.readFileSync(FEED, 'utf8'));
  const IT = feed.it;
  const EN = (feed.lingue && feed.lingue.en) || null;
  if (!IT || !IT.titolo) { console.error('feed senza record italiano: mi fermo'); process.exit(1); }
  const sanoIT = titoloValido(IT.titolo, '');
  if (sanoIT) { console.error('il titolo italiano non è sano (' + sanoIT + '): mi fermo, va corretto a monte'); process.exit(1); }
  const valoriIT = CAMPI.map((k) => String(IT[k] || ''));
  console.log('fonte italiana:', JSON.stringify(IT.titolo));
  console.log('lingue da rigenerare:', LINGUE.join(' ') || '(nessuna)', '| motore:', MOTORE, '| modelli:', MODELLI.join(' '));

  const report = { generatoIl: new Date().toISOString(), fonte: IT.titolo, motoreRichiesto: MOTORE, lingue: {} };
  const inInglese = [];

  for (const lingua of LINGUE) {
    const riga = { lingua, motore: null, ok: false, motivi: [], tentativi: [], titolo: null };
    const prima = feed.lingue[lingua] ? String(feed.lingue[lingua].titolo || '') : null;
    riga.prima = prima;

    let scelto = null;

    if (MOTORE === 'auto' || MOTORE === 'llm') {
      try {
        const r = await traduciLLM(lingua, valoriIT);
        riga.tentativi = riga.tentativi.concat(r.tentativi);
        if (r.modello) {
          const obj = daObj(r.valori);
          const motivi = recordValido(obj, IT, EN);
          if (!motivi.length) { scelto = { obj, motore: 'llm:' + r.modello }; }
          else riga.motivi.push('llm → ' + motivi.join('; '));
        } else {
          riga.motivi.push('llm → nessun modello ha risposto');
        }
      } catch (e) { riga.motivi.push('llm → errore: ' + e.message.slice(0, 120)); }
    }

    if (!scelto && (MOTORE === 'auto' || MOTORE === 'm2m100')) {
      try {
        const valori = await traduciM2M(lingua, valoriIT);
        if (valori.length === valoriIT.length) {
          const obj = daObj(valori);
          const motivi = recordValido(obj, IT, EN);
          if (!motivi.length) { scelto = { obj, motore: 'm2m100' }; }
          else riga.motivi.push('m2m100 → ' + motivi.join('; '));
        } else {
          riga.motivi.push('m2m100 → risposta incompleta');
        }
      } catch (e) { riga.motivi.push('m2m100 → errore: ' + e.message.slice(0, 120)); }
    }

    // (b) FALLBACK DICHIARATO: l'inglese è meglio di un titolo rotto, e lo si dice nel feed.
    if (!scelto) {
      if (!EN) { console.error(lingua, ': nessun record inglese da cui copiare, salto'); riga.motivi.push('nessun inglese'); report.lingue[lingua] = riga; continue; }
      const obj = {}; CAMPI.forEach((k) => { obj[k] = String(EN[k] || '').trim(); });
      const motivi = recordValido(obj, IT, null);
      const senzaTitolo = motivi.filter((m) => !m.startsWith('titolo'));
      if (senzaTitolo.length) { console.error(lingua, ': inglese non valido →', senzaTitolo.join('; ')); riga.motivi.push('inglese non valido'); report.lingue[lingua] = riga; continue; }
      scelto = { obj, motore: 'inglese' };
      inInglese.push(lingua);
    }

    scelto.obj.nota = scelto.motore === 'inglese'
      ? 'Questa lingua mostra il titolo e il testo in inglese perché il traduttore automatico non la copre: m2m100 restituisce testo senza senso e i modelli linguistici non hanno prodotto una traduzione verificabile. Traduzione umana da fare.'
      : 'Rigenerata il ' + new Date().toISOString().slice(0, 10) + ' con ' + scelto.motore + ' (verifica superata: BuyNow + 259 nel titolo).';
    scelto.obj.motore = scelto.motore;
    scelto.obj.rigenerataIl = new Date().toISOString();
    feed.lingue[lingua] = scelto.obj;

    riga.motore = scelto.motore;
    riga.ok = true;
    riga.titolo = scelto.obj.titolo;
    report.lingue[lingua] = riga;
    console.log('  ' + lingua.padEnd(3) + ' OK  [' + scelto.motore + '] ' + JSON.stringify(scelto.obj.titolo));
  }

  feed.meta = feed.meta || {};
  feed.meta.lingue = Object.keys(feed.lingue).length;
  feed.meta.generatoIl = new Date().toISOString();
  // 12/11/2026 — il motore è CAMBIATO per le lingue a risorse basse: si dichiara nel feed,
  // così chi legge il file sa quale motore ha prodotto quale testo (e l'edge può filtrare).
  feed.meta.fonte = 'Workers AI — m2m100 per le lingue coperte, llama (azione traduci-llm) per le lingue a risorse basse, inglese dichiarato dove nessuno dei due regge';
  feed.meta.lingueInInglese = inInglese.slice().sort();
  const notaNuova = '14/11/2026: rigenerate ' + LINGUE.length + ' lingue (' + LINGUE.join(', ') + ') con la catena llm → m2m100 → inglese. ' +
    (inInglese.length ? 'In inglese dichiarato: ' + inInglese.join(', ') + '. ' : '') +
    'm2m100 su queste lingue restituisce ancora testo senza senso (verificato nella stessa run).';
  feed.meta.correzioni = (feed.meta.correzioni ? feed.meta.correzioni + ' | ' : '') + notaNuova;

  fs.writeFileSync(FEED, JSON.stringify(feed));
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));

  console.log('\n--- RAPPORTO ---');
  console.log('lingue rigenerate:', Object.values(report.lingue).filter((r) => r.ok).length, '/', LINGUE.length);
  console.log('in inglese dichiarato:', inInglese.length ? inInglese.join(' ') : '(nessuna)');
  console.log('file:', FEED, (fs.statSync(FEED).size / 1024).toFixed(0) + ' KB');
  const ko = Object.values(report.lingue).filter((r) => !r.ok);
  if (ko.length) { console.log('KO:', ko.map((r) => r.lingua).join(' ')); process.exit(2); }
})().catch((e) => { console.error('ERRORE:', e && e.message); process.exit(1); });
