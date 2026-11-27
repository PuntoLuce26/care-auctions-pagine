#!/usr/bin/env node
/**
 * gate-lingua.mjs — controllo di qualità PRIMA di aprire una lingua sul sito.
 * Uso: node gate-lingua.mjs es fr de [--dom cartella]
 * Controlli: (1) chiavi i18n uguali all'inglese; (2) niente italiano rimasto nei testi;
 *            (3) se --dom <cartella> contiene <lang>.html, il corpo deve essere nella lingua.
 * Esce 0 solo se TUTTE le lingue passano. Una lingua che non passa resta 301 (non si apre).
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const domDir = args.includes('--dom') ? args[args.indexOf('--dom') + 1] : null;
const lingue = args.filter((a) => /^[a-z]{2}(-[A-Za-z]{2})?$/.test(a));

const ITA = [' della ', ' degli ', ' della casa ', ' prezzo ', ' acquisto ', ' asta ', ' tribunale ', ' offerta minima ', ' senza ', ' con il '];
const LINGUE_MARCATORI = {
  es: [' la casa ', ' precio ', ' subasta ', ' oferta ', ' tribunal ', ' comprar '],
  fr: [' la maison ', ' prix ', ' enchères ', ' offre ', ' tribunal ', ' acheter '],
  de: [' das haus ', ' preis ', ' auktion ', ' angebot ', ' gericht ', ' kaufen '],
  pt: [' a casa ', ' preço ', ' leilão ', ' oferta ', ' tribunal ', ' comprar '],
  nl: [' het huis ', ' prijs ', ' veiling ', ' bod ', ' rechtbank ', ' kopen '],
  pl: [' dom ', ' cena ', ' aukcja ', ' oferta ', ' sąd ', ' kupić '],
  sv: [' huset ', ' pris ', ' auktion ', ' bud ', ' domstol ', ' köpa '],
  ru: [' дом ', ' цена ', ' аукцион ', ' предложение ', ' суд ', ' купить '],
  ar: [' المنزل ', ' السعر ', ' المزاد ', ' عرض ', ' المحكمة ', ' شراء '],
  ja: [' 家 ', ' 価格 ', ' オークション ', ' 入札 ', ' 裁判所 ', ' 購入 '],
  zh: [' 房子 ', ' 价格 ', ' 拍卖 ', ' 报价 ', ' 法院 ', ' 购买 '],
};

async function testo(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'CARe-Gate/1.0' } });
  if (!r.ok) throw new Error(u + ' → ' + r.status);
  return r.text();
}

// it/en non si giudicano dalla rotta (l'edge serve solo le sovrascritture): si legge il file del repo
const en = JSON.parse(await testo('https://raw.githubusercontent.com/PuntoLuce26/care-auctions-pagine/main/i18n/en.json'));
const chiaviEn = Object.keys(en).length;
console.log('inglese: ' + chiaviEn + ' chiavi');
let tuttiOk = true;
for (const lang of lingue) {
  const problemi = [];
  let chiavi = 0, ita = 0, marc = 0, campione = '';
  try {
    const d = JSON.parse(await testo('https://careauctions.co/i18n/' + lang + '.json'));
    const voci = Object.entries(d).filter(([, v]) => typeof v === 'string' && v.trim().length > 2);
    chiavi = voci.length;
    if (chiavi < chiaviEn * 0.95) problemi.push('chiavi ' + chiavi + ' su ' + chiaviEn);
    const testoIntero = ' ' + voci.map(([, v]) => String(v).toLowerCase()).join(' \n ') + ' ';
    for (const m of ITA) ita += testoIntero.split(m).length - 1;
    const marcatori = (LINGUE_MARCATORI[lang] || []).filter((m) => testoIntero.includes(m.toLowerCase()));
    marc += marcatori.length;
    campione = String(voci[0] ? voci[0][1] : '').slice(0, 90);
    if (ita > Math.max(20, chiavi * 0.05)) problemi.push('italiano residuo: ' + ita + ' occorrenze');
    if ((LINGUE_MARCATORI[lang] || []).length && marc === 0) problemi.push('nessun marcatore della lingua trovato');
  } catch (e) {
    problemi.push('i18n non leggibile: ' + e.message);
  }
  if (domDir) {
    const f = domDir.replace(/\/$/, '') + '/' + lang + '.html';
    if (fs.existsSync(f)) {
      const h = fs.readFileSync(f, 'utf8').toLowerCase();
      const mm = (LINGUE_MARCATORI[lang] || []).filter((m) => h.includes(m.toLowerCase()));
      if (!mm.length) problemi.push('DOM reso non nella lingua (nessun marcatore)');
    } else {
      problemi.push('DOM reso mancante: ' + f);
    }
  }
  const ok = problemi.length === 0;
  if (!ok) tuttiOk = false;
  console.log((ok ? 'OK   ' : 'KO   ') + lang + ' · chiavi ' + chiavi + ' · italiano ' + ita + ' · marcatori ' + marc + (problemi.length ? ' · ' + problemi.join('; ') : '') + (campione ? ' · es. «' + campione + '»' : ''));
}
process.exit(tuttiOk ? 0 : 1);
