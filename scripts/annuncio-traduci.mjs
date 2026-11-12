#!/usr/bin/env node
/** annuncio-traduci.mjs — l'annuncio tradotto in TUTTE le lingue, con la stessa voce.
 *  Perché: una casa a Santa Teresa di Gallura deve poter essere trovata da chi cerca in
 *  tedesco, giapponese o arabo. Il motore è Workers AI (m2m100, free tier) via worker icare-ai.
 *  Ingresso: i testi italiani dell'annuncio (qui sotto, presi dal JSON-LD pubblicato).
 *  Uscita: feed/annuncio-san-pasquale-i18n.json — per ogni lingua: titolo, h1, descrizione, faq.
 *  Riprendibile: se il file esiste, salta le lingue già fatte.
 */
import fs from 'node:fs';

const KEY = 'OFiwoWQ3uuPpLv4hrmqu_zl0y-01MXBgVW_nyosKfiw';
const OUT = 'feed/annuncio-san-pasquale-i18n.json';
const DA = 'it';

const IT = {
  titolo: 'Santa Teresa Gallura, San Pasquale — 259.000 € in BuyNow · CAReAuctions',
  h1: 'Santa Teresa Gallura, San Pasquale. Vista mare, garage doppio, messo a nuovo.',
  descrizione: 'Trilocale di circa 78 mq a San Pasquale, Santa Teresa Gallura: balcone abitabile con vista mare sul Golfo di Gallura, garage doppio, completamente arredato e rinnovato. Prezzo di lancio 259.000 € in BuyNow, Compralo Subito.',
  corpo: 'La casa si trova in Via Graziani 2, località San Pasquale, a Santa Teresa Gallura, in provincia di Sassari, nel nord della Sardegna. Dal balcone abitabile si vede il mare del Golfo di Gallura. È un trilocale di circa 78 metri quadrati, con garage doppio, completamente arredato e rinnovato: si entra e si abita. La casa è libera, senza inquilini, e si vende con tutti gli arredi. Santa Teresa Gallura è a un\'ora dall\'aeroporto di Olbia, a pochi minuti dal porto di Palau e dalle spiagge della Costa Smeralda.',
  faq1d: 'Dove si trova la casa di San Pasquale?',
  faq1r: 'In Via Graziani 2, località San Pasquale, a Santa Teresa Gallura (SS), nel nord della Sardegna. Dal balcone abitabile si vede il mare del Golfo di Gallura.',
  faq2d: 'Quanto costa?',
  faq2r: 'Il prezzo di lancio è 259.000 €, in BuyNow con Compralo Subito.',
  faq3d: 'È pronta da abitare?',
  faq3r: 'Sì. La casa è libera, pronta da abitare, con finiture e arredi nuovi, e si vende completamente arredata.',
  faq4d: 'Come si compra?',
  faq4r: 'Con BuyNow, Compralo Subito, al prezzo di lancio di 259.000 €. CAReAuctions segue la vendita con un incarico esclusivo di consulenza immobiliare: lascia nome ed email in questa pagina e ti scriviamo per fissare la visita.'
};

const CHIAVI = Object.keys(IT);
const lingue = fs.readFileSync('/tmp/langs.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

let out = { meta: { titolo: 'Annuncio San Pasquale — tutte le lingue', fonte: 'Workers AI m2m100 via worker icare-ai', generatoIl: new Date().toISOString(), lingue: 0, nota: 'Traduzione automatica: non sostituisce la revisione legale per contratti e privacy.' }, it: IT, lingue: {} };
try { const v = JSON.parse(fs.readFileSync(OUT, 'utf8')); if (v && v.lingue) out = v; } catch {}

async function traduci(testi, a) {
  const r = await fetch('https://icare-ai.misty-mode-1cbc.workers.dev', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ azione: 'traduci', chiave: KEY, testi, da: DA, a })
  });
  const j = await r.json();
  return j.traduzioni || [];
}

const daFare = lingue.filter((l) => l !== 'it' && !out.lingue[l]);
console.log('lingue totali:', lingue.length, '· da tradurre:', daFare.length);
let fatte = 0;
for (const l of daFare) {
  try {
    const valori = CHIAVI.map((k) => IT[k]);
    const t = await traduci(valori, l);
    if (!t || t.length !== valori.length) { console.log('  salto', l, '(risposta incompleta)'); continue; }
    const obj = {}; CHIAVI.forEach((k, i) => { obj[k] = t[i]; });
    out.lingue[l] = obj;
    fatte++;
    if (fatte % 10 === 0) {
      out.meta.lingue = Object.keys(out.lingue).length;
      fs.writeFileSync(OUT, JSON.stringify(out));
      console.log('  fatte', fatte, '/', daFare.length);
    }
    await new Promise((r) => setTimeout(r, 150));
  } catch (e) { console.log('  errore', l, e.message.slice(0, 60)); }
}
out.meta.lingue = Object.keys(out.lingue).length;
out.meta.generatoIl = new Date().toISOString();
fs.mkdirSync('feed', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('FINE — lingue tradotte:', out.meta.lingue, '· file:', (fs.statSync(OUT).size / 1024).toFixed(0), 'KB');
