#!/usr/bin/env node
/**
 * watchdog-parete.mjs — avvisa se la parete iCAReWall smette di pubblicare.
 *
 * PERCHÉ ESISTE (15/11/2026): il 15/11 si è scoperto che la parete era ferma dal 10/11 04:00Z,
 * quattro giorni senza pubblicare, con i giri del cron "chiusi" e nessun allarme. Questo
 * controllo guarda la parete dal di fuori (GitHub Actions, ogni 2 ore) e non si fida del log
 * del worker che pubblica: legge la parete vera.
 *
 * SCHEMA REALE DELLA RISPOSTA (ispezionato il 15/11/2026, NON inventato):
 *   GET https://care-aste.emergent.host/api/battito?lang=it
 *   → { "messaggi": [ { id, nome, nazione, citta, data, lingua, originale, testo, tradotto, fissatoIl } ],
 *       "fissato": null, "aggiornato": "2026-11-15T14:51:03.711770+00:00" }
 *   - i messaggi sono ordinati dal più recente al più vecchio (verificato);
 *   - `data` è ISO 8601 in UTC ed è il campo usato per l'età;
 *   - l'id è `B` + epoch in millisecondi (B1794752115016 → 2026-11-15T14:15:15.016Z): su tre
 *     messaggi l'id convertito coincide al millisecondo con `data`, quindi vale come riserva;
 *   - `lingua` è la lingua ORIGINALE del pensiero, non quella della parete interrogata
 *     (su ?lang=it il messaggio più recente ha lingua "de" e testo già tradotto in italiano);
 *   - su ?lang=en il campo `testo` può essere null (traduzione assente) → si mostra `originale`.
 *
 * COSA FA
 *   1. legge la parete in it e in en e prende il messaggio più recente in assoluto;
 *   2. calcola l'età in ore;
 *   3. età > 8 h → apre (o aggiorna) UNA issue «[ALLARME] iCAReWall ferma da più di 8 ore»;
 *   4. parete viva (età ≤ 8 h) e issue aperta → la chiude da sola con un commento;
 *   5. scrive `stato/parete.json` = { controllatoIl, ultimoMessaggio, lingua, etaOre, ok }
 *      con la Contents API e lo sha corrente (niente clone del repo da 790 MB).
 *
 * ESITO DEL PROCESSO: exit 0 se la misura è stata fatta e registrata (anche se ok=false: l'allarme
 * è l'issue, non un job rosso ogni 2 ore); exit 1 se NON si è potuto misurare o scrivere — perché
 * «non ho potuto leggere» è un guasto, non un silenzio da nascondere.
 *
 * PROVE LOCALI (non toccano la produzione):
 *   node scripts/watchdog-parete.mjs --prova
 *   node scripts/watchdog-parete.mjs --prova --simula-ora=2026-11-17T00:00:00Z
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://care-aste.emergent.host/api/battito';
const LINGUE = ['it', 'en'];
const SOGLIA_ORE = 8;
const TITOLO_ISSUE = '[ALLARME] iCAReWall ferma da più di 8 ore';
const STATO_PATH = 'stato/parete.json';
const UA = 'careauctions-watchdog-parete/1.0 (+https://careauctions.co)';

// ---------------------------------------------------------------- lettura parete

/** Età del messaggio: `data` (ISO) e, solo se manca, l'id `B<epoch-ms>`. */
export function dataMessaggio(m) {
  const iso = m && typeof m.data === 'string' ? Date.parse(m.data) : NaN;
  if (Number.isFinite(iso)) return { ms: iso, fonte: 'data' };
  const id = m && typeof m.id === 'string' ? m.id : '';
  const g = /^B(\d{12,16})$/.exec(id);
  if (g) {
    const ms = Number(g[1]);
    if (Number.isFinite(ms) && ms > 1e12) return { ms, fonte: 'id' };
  }
  return null;
}

/** Messaggi databili di una risposta; solleva se lo schema non è quello atteso. */
export function leggiParete(json, lingua) {
  if (!json || !Array.isArray(json.messaggi)) {
    const chiavi = json && typeof json === 'object' ? Object.keys(json).join(', ') : String(json);
    throw new Error(`risposta senza array "messaggi" (chiavi lette: ${chiavi})`);
  }
  const letti = [];
  for (const m of json.messaggi) {
    const d = dataMessaggio(m);
    if (d) letti.push({ m, ms: d.ms, fonte: d.fonte, parete: lingua });
  }
  return letti;
}

/** Il più recente fra tutte le pareti lette. */
export function piuRecente(letti) {
  let best = null;
  for (const x of letti) if (!best || x.ms > best.ms) best = x;
  return best;
}

/** Il record pubblico (esattamente cinque chiavi, come da contratto). */
export function recordStato(nuovo, adesso) {
  // Il giudizio si dà sull età NON arrotondata: arrotondare a 2 decimali sposterebbe il
  // confine delle 8 ore di 18 secondi. Nel file va il numero arrotondato, nel confronto no.
  const etaGrezza = nuovo ? (adesso - nuovo.ms) / 3600000 : null;
  const etaOre = etaGrezza === null ? null : Math.round(etaGrezza * 100) / 100;
  return {
    controllatoIl: new Date(adesso).toISOString(),
    ultimoMessaggio: nuovo ? new Date(nuovo.ms).toISOString() : null,
    lingua: nuovo ? String(nuovo.m.lingua || '?') : '?',
    etaOre,
    ok: etaGrezza !== null && etaGrezza <= SOGLIA_ORE,
  };
}

// ---------------------------------------------------------------- testo issue

const ore = (n) => String(Math.round(n * 10) / 10).replace('.', ',');

export function corpoIssue({ stato, nuovo, lette, adesso }) {
  const testo = nuovo ? String(nuovo.m.testo || nuovo.m.originale || '(testo assente)') : '';
  const originale = nuovo && nuovo.m.originale && nuovo.m.originale !== nuovo.m.testo ? String(nuovo.m.originale) : '';
  const righe = [
    `**Watchdog della parete iCAReWall** — controllo del ${new Date(adesso).toISOString()}`,
    '',
    stato.ok
      ? `La parete **ha pubblicato** entro la soglia: età ${ore(stato.etaOre)} h (soglia ${SOGLIA_ORE} h).`
      : `La parete **non pubblica** da più di ${SOGLIA_ORE} ore.`,
    '',
    '| misura | valore |',
    '|---|---|',
    `| ultimo messaggio | ${stato.ultimoMessaggio || 'nessun messaggio databile'} |`,
    `| lingua | ${stato.lingua}${nuovo && nuovo.m.lingua ? ' (lingua originale del pensiero)' : ''} |`,
    `| età | ${stato.etaOre === null ? 'non calcolabile' : ore(stato.etaOre) + ' h'} |`,
    `| soglia | ${SOGLIA_ORE} h |`,
    nuovo ? `| id | \`${nuovo.m.id || '?'}\` |` : '| id | — |',
    nuovo ? `| parete letta | ?lang=${nuovo.parete} (campo \`${nuovo.fonte}\`) |` : '| parete letta | — |',
    '',
  ];
  if (!nuovo) {
    righe.push(
      '**Nessun messaggio databile**: la parete risponde ma non contiene messaggi utilizzabili.',
      'È il caso peggiore dello stesso guasto: pubblicare zero pensieri equivale a essere ferma.',
      '',
    );
  } else {
    righe.push('**Ultimo pensiero**', '', '> ' + testo.replace(/\n/g, '\n> '), '');
    if (originale) righe.push('_Originale:_ ' + originale, '');
  }
  righe.push(
    '---',
    `Aperta o aggiornata da \`.github/workflows/watchdog-parete.yml\` (cron ogni 2 ore). ` +
      `Si chiude da sola quando la parete torna a pubblicare entro ${SOGLIA_ORE} ore: non va chiusa a mano.`,
    `Pareti interrogate: ${[...new Set(lette.map((l) => l.parete))].map((p) => '?lang=' + p).join(' · ')} — ` +
      '`https://care-aste.emergent.host/api/battito`.',
  );
  return righe.join('\n');
}

// ---------------------------------------------------------------- API GitHub

const API = 'https://api.github.com';

async function gh(percorso, metodo = 'GET', corpo) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN assente: impossibile parlare con l API GitHub');
  const r = await fetch(API + percorso, {
    method: metodo,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      'Content-Type': 'application/json',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const testo = await r.text();
  let json = null;
  try {
    json = testo ? JSON.parse(testo) : null;
  } catch {
    /* risposta non JSON: resta il codice */
  }
  return { stato: r.status, json };
}

const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * La issue [ALLARME] aperta, se c'è. Si rilegge una seconda volta dopo 2 s quando la prima
 * lettura non trova nulla: l'indice delle issue di GitHub è in ritardo di qualche secondo dopo
 * una scrittura (misurato il 15/11/2026 su un repo appena creato, issue creata e lista vuota per
 * ~3 s). Senza la rilettura un falso vuoto aprirebbe una SECONDA issue: due allarmi per lo
 * stesso guasto sono peggio di nessun allarme.
 */
async function cercaAperta(repo) {
  const leggi = async () => {
    const r = await gh(`/repos/${repo}/issues?state=open&per_page=100`);
    if (r.stato !== 200) throw new Error(`elenco issue HTTP ${r.stato}`);
    return (r.json || []).filter(
      (i) => !i.pull_request && typeof i.title === 'string' && i.title.trim() === TITOLO_ISSUE,
    );
  };
  let trovate = await leggi();
  if (!trovate.length) {
    await dormi(2000);
    trovate = await leggi();
  }
  return trovate[0] || null;
}

/**
 * UNA sola issue. Si cerca per titolo esatto (non per etichetta: un'etichetta assente fa
 * fallire la creazione con 422 e l'allarme si perderebbe). Se la parete è viva e l'issue è
 * aperta, si commenta «rientrato» e si chiude.
 */
export async function gestisciIssue({ stato, corpo }) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY assente');
  const aperta = await cercaAperta(repo);

  if (stato.ok) {
    if (!aperta) return { azione: 'nessuna', dettaglio: 'parete viva, nessuna issue aperta' };
    await gh(`/repos/${repo}/issues/${aperta.number}/comments`, 'POST', {
      body:
        `Rientrato: la parete ha pubblicato a **${stato.ultimoMessaggio}** ` +
        `(età ${ore(stato.etaOre)} h, soglia ${SOGLIA_ORE} h). Chiudo da solo.`,
    });
    const chiusa = await gh(`/repos/${repo}/issues/${aperta.number}`, 'PATCH', { state: 'closed' });
    if (chiusa.stato >= 400) throw new Error(`chiusura issue #${aperta.number} HTTP ${chiusa.stato}`);
    return { azione: 'chiusa', dettaglio: `issue #${aperta.number} chiusa` };
  }

  if (aperta) {
    const r = await gh(`/repos/${repo}/issues/${aperta.number}`, 'PATCH', { body: corpo });
    if (r.stato >= 400) throw new Error(`aggiornamento issue #${aperta.number} HTTP ${r.stato}`);
    return { azione: 'aggiornata', dettaglio: `issue #${aperta.number} aggiornata` };
  }
  const r = await gh(`/repos/${repo}/issues`, 'POST', { title: TITOLO_ISSUE, body: corpo });
  if (r.stato >= 400) throw new Error(`creazione issue HTTP ${r.stato}: ${JSON.stringify(r.json).slice(0, 200)}`);
  return { azione: 'aperta', dettaglio: `issue #${r.json && r.json.number} aperta` };
}

// ---------------------------------------------------------------- stato/parete.json

/** sha del blob git: identifica il contenuto senza fidarsi dell'`sha` della Contents API. */
export function blobSha(contenuto) {
  const buf = Buffer.from(contenuto, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * Scrive stato/parete.json con la Contents API e lo sha corrente (file piccolo: niente clone).
 * Se manca il token (prova locale) scrive il file su disco e basta.
 */
export async function scriviStato(contenuto, { messaggio } = {}) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    mkdirSync(dirname(STATO_PATH), { recursive: true });
    writeFileSync(STATO_PATH, contenuto);
    return { modo: 'locale', dettaglio: `${STATO_PATH} scritto su disco` };
  }
  const nuovoSha = blobSha(contenuto);
  for (let tentativo = 1; tentativo <= 5; tentativo++) {
    const attuale = await gh(`/repos/${repo}/contents/${STATO_PATH}`);
    let sha = null;
    if (attuale.stato === 200 && attuale.json) {
      if (attuale.json.sha === nuovoSha) return { modo: 'api', dettaglio: 'invariato, nessun commit' };
      sha = attuale.json.sha;
    } else if (attuale.stato !== 404) {
      throw new Error(`lettura ${STATO_PATH} HTTP ${attuale.stato}`);
    }
    const corpo = {
      message: messaggio || `stato: parete · ${STATO_PATH}`,
      content: Buffer.from(contenuto, 'utf8').toString('base64'),
      branch: 'main',
    };
    if (sha) corpo.sha = sha;
    const put = await gh(`/repos/${repo}/contents/${STATO_PATH}`, 'PUT', corpo);
    if (put.stato === 200 || put.stato === 201) {
      return { modo: 'api', dettaglio: `${STATO_PATH} committato (${put.json && put.json.commit ? put.json.commit.sha.slice(0, 8) : '?'})` };
    }
    if (put.stato === 409 || put.stato === 422) {
      await dormi(1500 * tentativo); // qualcun altro ha committato: si rilegge lo sha
      continue;
    }
    throw new Error(`scrittura ${STATO_PATH} HTTP ${put.stato}: ${JSON.stringify(put.json).slice(0, 200)}`);
  }
  throw new Error(`scrittura ${STATO_PATH} non riuscita dopo 5 tentativi (sha sempre cambiato)`);
}

// ---------------------------------------------------------------- main

function argomenti(argv) {
  const out = { prova: false, simulaOra: null, api: API_BASE };
  for (const a of argv.slice(2)) {
    if (a === '--prova' || a === '--dry-run') out.prova = true;
    else if (a.startsWith('--simula-ora=')) out.simulaOra = a.slice('--simula-ora='.length);
    else if (a.startsWith('--api=')) out.api = a.slice('--api='.length);
  }
  return out;
}

export async function main(argv = process.argv) {
  const opt = argomenti(argv);
  const adesso = opt.simulaOra ? Date.parse(opt.simulaOra) : Date.now();
  if (!Number.isFinite(adesso)) throw new Error(`--simula-ora non è una data ISO valida: ${opt.simulaOra}`);

  // 1) lettura delle due pareti
  const lette = [];
  const errori = [];
  for (const lingua of LINGUE) {
    const url = `${opt.api}?lang=${lingua}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const m = leggiParete(j, lingua);
      lette.push(...m);
      if (lingua === LINGUE[0]) {
        const primo = j.messaggi && j.messaggi[0];
        console.log(`[schema] ?lang=${lingua} chiavi risposta: ${Object.keys(j).join(', ')}`);
        console.log(`[schema] chiavi messaggio: ${primo ? Object.keys(primo).join(', ') : '(nessun messaggio)'}`);
        console.log(`[schema] primo messaggio: ${JSON.stringify(primo).slice(0, 700)}`);
      }
      console.log(`[parete] ?lang=${lingua}: ${j.messaggi.length} messaggi, ${m.length} databili`);
    } catch (e) {
      errori.push(`?lang=${lingua}: ${String((e && e.message) || e)}`);
      console.log(`[parete] ?lang=${lingua}: ERRORE ${String((e && e.message) || e)}`);
    }
  }
  if (!lette.length && errori.length === LINGUE.length) {
    throw new Error(`parete illeggibile su tutte le lingue (${errori.join(' | ')}): nessuna misura possibile`);
  }

  // 2) età e giudizio
  const nuovo = piuRecente(lette);
  const stato = recordStato(nuovo, adesso);
  console.log(`[esito] ultimo messaggio ${stato.ultimoMessaggio || '—'} · lingua ${stato.lingua} · età ${stato.etaOre === null ? '—' : ore(stato.etaOre) + ' h'} · ok=${stato.ok}`);

  const corpo = corpoIssue({ stato, nuovo, lette, adesso });
  if (opt.prova) {
    console.log('[prova] issue che sarebbe aperta/aggiornata (nessuna chiamata fatta):');
    console.log('---8<---');
    console.log(corpo);
    console.log('--->8---');
  }

  // 3) allarme o rientro
  let esitoIssue = { azione: 'salta', dettaglio: 'modalità prova' };
  let erroreIssue = null;
  if (!opt.prova) {
    try {
      esitoIssue = await gestisciIssue({ stato, corpo });
    } catch (e) {
      erroreIssue = e;
      console.log(`[issue] ERRORE ${String((e && e.message) || e)}`);
    }
  }
  console.log(`[issue] ${esitoIssue.azione}: ${esitoIssue.dettaglio}`);

  // 4) stato/parete.json (sempre, anche se l'issue è fallita: la misura va registrata)
  const contenuto = JSON.stringify(stato, null, 1) + '\n';
  let esitoStato = { modo: 'salta', dettaglio: 'modalità prova' };
  let erroreStato = null;
  if (!opt.prova) {
    try {
      esitoStato = await scriviStato(contenuto, {
        messaggio: `stato: parete ${stato.ok ? 'ok' : 'FERMA'} · età ${stato.etaOre === null ? '—' : ore(stato.etaOre)} h`,
      });
    } catch (e) {
      erroreStato = e;
      console.log(`[stato] ERRORE ${String((e && e.message) || e)}`);
    }
  }
  console.log(`[stato] ${esitoStato.modo}: ${esitoStato.dettaglio}`);
  if (opt.prova) console.log('[stato] JSON che sarebbe scritto:\n' + contenuto);

  // 5) riepilogo nel run (visibile senza aprire i log)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const righe = [
      '## Watchdog parete iCAReWall',
      '',
      `- ultimo messaggio: ${stato.ultimoMessaggio || 'nessuno databile'}`,
      `- lingua: ${stato.lingua}`,
      `- età: ${stato.etaOre === null ? 'non calcolabile' : ore(stato.etaOre) + ' h'} (soglia ${SOGLIA_ORE} h)`,
      `- esito: **${stato.ok ? 'OK — parete viva' : 'ALLARME — parete ferma'}**`,
      `- issue: ${esitoIssue.azione} (${esitoIssue.dettaglio})`,
      `- stato: ${esitoStato.modo} (${esitoStato.dettaglio})`,
    ];
    if (errori.length) righe.push(`- letture fallite: ${errori.join(' · ')}`);
    if (erroreIssue) righe.push(`- **errore issue**: ${String(erroreIssue.message || erroreIssue)}`);
    if (erroreStato) righe.push(`- **errore stato**: ${String(erroreStato.message || erroreStato)}`);
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, righe.join('\n') + '\n', { flag: 'a' });
    } catch {
      /* il riepilogo non deve mai far fallire il controllo */
    }
  }

  return { stato, esitoIssue, esitoStato, erroreIssue, erroreStato };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((r) => {
      process.exitCode = r.erroreIssue || r.erroreStato ? 1 : 0;
    })
    .catch((e) => {
      console.error('[fatal] ' + String((e && e.stack) || e));
      process.exitCode = 1;
    });
}
