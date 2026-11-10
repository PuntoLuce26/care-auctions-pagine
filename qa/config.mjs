// QA CAReAuctions — configurazione.
// Regola: qui si tocca solo ciò che è sicuro. Nessun click che compra, paga, invia, pubblica, cancella.
export const BASE = process.env.QA_BASE || 'https://careauctions.co';
export const ORIGIN = process.env.QA_ORIGIN || 'https://care-aste.emergent.host';
export const WAIT = Number(process.env.QA_WAIT || 3500);
export const NAV_TIMEOUT = Number(process.env.QA_TIMEOUT || 45000);
export const LINK_LIMIT = Number(process.env.QA_LINK_LIMIT || 45);
export const FAST = !!process.env.QA_FAST;

// Rotte: le pagine che vendono, che devono stare in piedi e che Google/AI leggono.
export const ROUTES = [
  { path: '/', name: 'home', critical: true },
  { path: '/aste', name: 'aste', critical: true },
  { path: '/idati', name: 'idati', critical: true },
  { path: '/osservatorio', name: 'osservatorio', critical: false },
  { path: '/aggiudicazioni', name: 'aggiudicazioni', critical: false },
  { path: '/dati', name: 'dati', critical: false },
  { path: '/ilive', name: 'ilive', critical: true },
  { path: '/stampa', name: 'stampa', critical: false },
  { path: '/emozioni', name: 'emozioni', critical: false },
  { path: '/novita', name: 'novita', critical: true },
  { path: '/affiliazione', name: 'affiliazione', critical: true },
  { path: '/buynow/san-pasquale', name: 'buynow-san-pasquale', critical: true },
  { path: '/compra-ora', name: 'compra-ora', critical: true },
  { path: '/ishop', name: 'ishop', critical: false },
  { path: '/icare', name: 'icare', critical: true },
  { path: '/faq', name: 'faq', critical: false },
  { path: '/mappa-prezzi', name: 'mappa-prezzi', critical: false },
  { path: '/stato', name: 'stato', critical: false }
];

export const FAST_ROUTES = ['/', '/novita', '/buynow/san-pasquale', '/compra-ora'];

// Smoke cross-browser: meno rotte, stesso motore di rendering.
export const SMOKE_ROUTES = ['/', '/novita', '/buynow/san-pasquale', '/compra-ora'];

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
];

// Click sicuri: solo cose che aprono/chiudono, mai transazioni.
export const SAFE_CLICK = /^(ok|accetta|accept|mostra|mostra di piu|mostra di più|leggi|leggi tutto|dettagli|filtri|apri|chiudi|indietro|avanti|prossimo|precedente|scopri|vedi|tutte|tutti|menu|it|italiano|english|deutsch|francais|français|espanol|español)$/i;

// Click vietati: qualunque cosa che possa creare un ordine, un invio, una cancellazione.
export const DANGER_CLICK = /(paga|pagamento|acquista|compra|invia|invia richiesta|pubblica|elimina|cancella|esci|logout|dona|abbonati|firma|prenota|richiedi|procedi|conferma|checkout|pay|buy|submit|send|delete|remove|ordina ora|aggiungi al carrello)/i;

export const SAFE_FIELD = ['text', 'email', 'tel', 'search', 'url', 'number', 'date'];
export const QA_TEXT = 'QA CARe test';
export const QA_EMAIL = 'qa@careauctions.co';

// Link interni da non controllare (404 voluti o percorsi non pubblici).
export const LINK_SKIP = [
  '/torre-di-controllo', '/t-x7k2m9q4v1', '/tab-x7k2m9q4v1', '/api/', '/feed/',
  '/static/', '/assets/', '/voce/', '/i18n/'
];

export const SEO_CHECKS = {
  llms: '/llms.txt',
  robots: '/robots.txt',
  sitemap: '/sitemap.xml',
  sitemapNovita: '/sitemap-novita.xml',
  sitemapPagine: '/sitemap-pagine.xml'
};
