#!/usr/bin/env node
/**
 * RIPARAZIONE SUPERVISORE — la riparazione RESA VISIBILE (15/11/2026)
 *
 * PERCHÉ ESISTE
 * La veglia `icare-veglia` svegliava un supervisore stantio e poi taceva: se il supervisore si
 * svegliava e NON scriveva, la voce passava da «stantio» a «svegliato» e nessuno riparava.
 * Questo workflow è il passo 3 della scala di escalation: quando la veglia ha misurato
 * `svegliato-invano` (sveglia partita, artefatto ancora vecchio), dispatcha qui.
 *
 * COSA FA (e cosa NON fa)
 *   1. legge l'ULTIMA run fallita del workflow sorvegliato (`/actions/workflows/<wf>/runs`),
 *      oppure l'ultima completata se nessuna è fallita (`senza-scrittura`: verde e artefatto fermo)
 *   2. scarica il log di quella run e cerca l'ERRORE VERO (`##[error]`, `exit code`, `ENOENT`,
 *      `ReferenceError`, `HTTP 4xx/5xx`), con le righe di contesto
 *   3. scrive `stato/riparazione/<nome>.json` con
 *      `{nome, ultimaRun, esito, erroreTrovato, estrattoLog, proposta}`
 *   4. apre UNA issue `[RIPARAZIONE] <nome>` con l'estratto e la proposta — e se esiste già la
 *      AGGIORNA (anche se era chiusa), mai una issue per giro
 *   5. NON applica nessuna patch: la riparazione è del proprietario di quel workflow
 *
 * REGOLA D'ORO: un guardiano che prova a riparare nasconde il guasto. Qui si rende il guasto
 * leggibile e assegnato; chi lo corregge è un umano (o un workflow dedicato, con la sua prova).
 *
 * Dove non si può leggere, si DICHIARA «non leggibile»: mai «nessun errore» al posto di «non ho
 * potuto leggere» (regola watchdog 11/11/2026).
 *
 * Uso (il workflow passa l'ambiente, non gli argomenti):
 *   RIP_NOME=verifica-canonical RIP_WORKFLOW=verifica-canonical.yml \
 *   RIP_REPO=PuntoLuce26/care-auctions-pagine RIP_ARTEFATTO=qa/canonical.json \
 *   GH_TOKEN=… node scripts/riparazione-supervisore.mjs
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const REPO_LAVORO = process.env.GITHUB_REPOSITORY || 'PuntoLuce26/care-auctions-pagine';
const NOME = String(process.env.RIP_NOME || '').trim();
const REPO_SORVEGLIATO = String(process.env.RIP_REPO || REPO_LAVORO).trim();
const WORKFLOW = String(process.env.RIP_WORKFLOW || '').trim();
const ARTEFATTO = String(process.env.RIP_ARTEFATTO || '').trim();
const MOTIVO = String(process.env.RIP_MOTIVO || '').trim();
const ETA = process.env.RIP_ETA ? Number(process.env.RIP_ETA) : null;
const SOGLIA = process.env.RIP_SOGLIA ? Number(process.env.RIP_SOGLIA) : null;
const UA = 'riparazione-supervisore/1.0 (+https://careauctions.co)';
const MAX_LOG_BYTE = 12 * 1024 * 1024;

const log = (...a) => console.log('[riparazione]', ...a);

function intestazioni(accept = 'application/vnd.github+json') {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: accept,
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function api(percorso, opzioni = {}) {
  const r = await fetch(percorso.startsWith('http') ? percorso : API + percorso, {
    ...opzioni,
    headers: { ...intestazioni(opzioni.accept || 'application/vnd.github+json'), ...(opzioni.headers || {}) },
  });
  const testo = await r.text();
  let corpo = null;
  try {
    corpo = testo ? JSON.parse(testo) : null;
  } catch (e) {
    corpo = testo;
  }
  return { ok: r.ok, stato: r.status, corpo, testo };
}

/* ───────────────────────── 1. l'ultima run fallita (o senza scrittura) ───────────────────────── */

async function scegliRun() {
  if (!WORKFLOW) return { esito: 'non-verificabile', motivo: 'nessun workflow nel payload' };
  const r = await api(`/repos/${REPO_SORVEGLIATO}/actions/workflows/${encodeURIComponent(WORKFLOW)}/runs?per_page=5`);
  if (!r.ok) {
    return {
      esito: 'non-verificabile',
      motivo: `le run del workflow non sono leggibili (HTTP ${r.stato}${r.corpo && r.corpo.message ? ' · ' + r.corpo.message : ''})`,
      run: null,
    };
  }
  const lista = Array.isArray(r.corpo && r.corpo.workflow_runs) ? r.corpo.workflow_runs : [];
  if (!lista.length) return { esito: 'non-verificabile', motivo: 'il workflow non ha nessuna run registrata', run: null };
  const fallita = lista.find((x) => x.conclusion === 'failure' || x.conclusion === 'timed_out' || x.conclusion === 'cancelled');
  const scelta = fallita || lista.find((x) => x.status === 'completed') || lista[0];
  return {
    esito: fallita ? 'fallita' : 'senza-scrittura',
    motivo: fallita
      ? `l'ultima run conclusa male è la ${scelta.id} (${scelta.conclusion})`
      : `nessuna run fallita fra le ultime ${lista.length}: l'artefatto è fermo con le run verdi (il workflow gira e non scrive)`,
    run: scelta,
    elenco: lista.map((x) => ({ id: x.id, conclusion: x.conclusion, created_at: x.created_at })),
  };
}

/* ─────────────────────────────── 2. il log, e l'errore VERO ─────────────────────────────── */

/** Zip minimo in pura Node (nessuna dipendenza): directory centrale + inflateRaw. */
function unzip(buf) {
  const out = new Map();
  const firmaEOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === firmaEOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip senza directory centrale');
  const voci = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let totale = 0;
  for (let n = 0; n < voci; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const compresso = buf.readUInt32LE(p + 20);
    const lungNome = buf.readUInt16LE(p + 28);
    const lungExtra = buf.readUInt16LE(p + 30);
    const lungCommento = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + lungNome);
    p += 46 + lungNome + lungExtra + lungCommento;
    if (!/\.(txt|log)$/i.test(nome)) continue;
    if (totale > MAX_LOG_BYTE) break;
    if (buf.readUInt32LE(offset) !== 0x04034b50) continue;
    const ln = buf.readUInt16LE(offset + 26);
    const le = buf.readUInt16LE(offset + 28);
    const inizio = offset + 30 + ln + le;
    const grezzo = buf.subarray(inizio, inizio + compresso);
    let dato;
    try {
      dato = metodo === 0 ? grezzo : zlib.inflateRawSync(grezzo);
    } catch (e) {
      continue;
    }
    totale += dato.length;
    out.set(nome, dato.toString('utf8'));
  }
  return out;
}

async function scaricaLog(runId) {
  if (!runId) return { ok: false, motivo: 'nessuna run da cui scaricare il log' };
  try {
    // l'endpoint risponde 302 verso un URL firmato: `redirect: follow` è il default di fetch
    const r = await fetch(`${API}/repos/${REPO_SORVEGLIATO}/actions/runs/${runId}/logs`, {
      headers: intestazioni('application/vnd.github+json'),
      redirect: 'follow',
    });
    if (!r.ok) return { ok: false, motivo: `log non leggibile (HTTP ${r.status})` };
    const buf = Buffer.from(await r.arrayBuffer());
    let files;
    try {
      files = unzip(buf);
    } catch (e) {
      return { ok: false, motivo: `log scaricato ma non apribile (${e.message})` };
    }
    if (!files.size) return { ok: false, motivo: 'log scaricato ma senza file di testo' };
    // ordine leggibile: prima gli step che falliscono di solito
    const nomi = [...files.keys()].sort((a, b) => a.localeCompare(b));
    const testo = nomi.map((n) => `### ${n}\n${files.get(n)}`).join('\n');
    return { ok: true, testo, file: nomi.length, byte: testo.length };
  } catch (e) {
    return { ok: false, motivo: `errore nello scaricare il log: ${String((e && e.message) || e).slice(0, 120)}` };
  }
}

const FIRME = [
  { tipo: '##[error]', re: /##\[error\](.+)/g },
  { tipo: 'exit code', re: /\bexit(?:ed)?\s+(?:with\s+)?code\s+(\d+)/gi },
  { tipo: 'ENOENT', re: /ENOENT[^\n]{0,160}/g },
  { tipo: 'ReferenceError', re: /ReferenceError[^\n]{0,160}/g },
  { tipo: 'HTTP 4xx/5xx', re: /\bHTTP[ /]([45]\d\d)\b[^\n]{0,120}/g },
  { tipo: 'TypeError', re: /TypeError[^\n]{0,160}/g },
  { tipo: 'SyntaxError', re: /SyntaxError[^\n]{0,160}/g },
  { tipo: 'timeout', re: /##\[error\]:?The action has timed out[^\n]*/g },
  { tipo: 'timeout', re: /Timeout reached[^\n]{0,80}/g },
];

/** Cerca le firme d'errore e tiene le righe di contesto (2 sopra, 3 sotto). */
function cercaErrore(testo) {
  const righe = String(testo || '').split('\n');
  const trovati = [];
  const visti = new Set();
  for (const f of FIRME) {
    for (let i = 0; i < righe.length; i++) {
      const r = righe[i];
      f.re.lastIndex = 0;
      const m = f.re.exec(r);
      if (!m) continue;
      const chiave = `${f.tipo}|${i}`;
      if (visti.has(chiave)) continue;
      visti.add(chiave);
      const contesto = righe.slice(Math.max(0, i - 2), Math.min(righe.length, i + 4)).join('\n');
      trovati.push({
        tipo: f.tipo,
        riga: i + 1,
        testo: String(m[0]).slice(0, 300),
        contesto: contesto.slice(0, 1200),
      });
      if (trovati.length >= 12) break;
    }
  }
  // l'estratto leggibile: le prime occorrenze, con il loro contesto
  const estratto = trovati
    .slice(0, 5)
    .map((t) => `--- ${t.tipo} (riga ${t.riga}) ---\n${t.contesto}`)
    .join('\n\n')
    .slice(0, 6000);
  return { trovati, estratto };
}

/** La proposta: una frase per CLASSE di errore, mai un'ipotesi presentata come diagnosi. */
function propostaDa(trovati, esitoRun) {
  const tipi = new Set(trovati.map((t) => t.tipo));
  if (!trovati.length) {
    return esitoRun === 'senza-scrittura'
      ? 'Il workflow gira verde e non scrive l’artefatto: la causa NON è nel log (nessun errore). Serve controllare se il passo che scrive il file è condizionato, se scrive un percorso diverso da quello sorvegliato, o se il file viene sovrascritto da un altro workflow.'
      : 'Nessuna firma d’errore riconosciuta nel log: la causa non è nel log o il log è parziale. Non si dichiara una diagnosi che non è stata misurata.';
  }
  const parti = [];
  if (tipi.has('ENOENT')) parti.push('C’è un ENOENT: un file o una cartella citata dal workflow non esiste nel runner — verificare il percorso (e se il checkout è shallow o su un ramo diverso).');
  if (tipi.has('ReferenceError')) parti.push('C’è un ReferenceError: un simbolo (variabile, import, funzione) non è definito in quel punto — è un errore di codice, non di dati.');
  if (tipi.has('SyntaxError') || tipi.has('TypeError')) parti.push('C’è un errore di codice (Syntax/Type): il primo passo che lo riproduce è quello indicato nell’estratto.');
  if (tipi.has('HTTP 4xx/5xx')) parti.push('Una chiamata esterna ha risposto 4xx/5xx: verificare segreto/token scaduto, permessi (contents/issues/actions) o rate limit.');
  if (tipi.has('exit code')) parti.push('Lo script è uscito con codice diverso da 0: l’errore vero è la riga `##[error]` più vicina sopra l’uscita, oppure manca un messaggio esplicito (aggiungere `::error::`).');
  if (tipi.has('timeout')) parti.push('La run è andata in timeout: il lavoro non finisce nel tempo massimo — o si spezza, o si alza `timeout-minutes` con una misura, non a caso.');
  parti.push('La patch NON è applicata: la applica chi possiede quel workflow, con la sua prova sull’artefatto.');
  return parti.join(' ');
}

/* ────────────────────────────── 4. UNA issue, aggiornata ────────────────────────────── */

const TITOLO = `[RIPARAZIONE] ${NOME}`;

async function trovaIssue() {
  const q = encodeURIComponent(`repo:${REPO_LAVORO} in:title "${TITOLO}" type:issue`);
  const s = await api(`/search/issues?q=${q}&per_page=10`, { accept: 'application/vnd.github+json' });
  if (s.ok && s.corpo && Array.isArray(s.corpo.items)) {
    const esatta = s.corpo.items.find((x) => x.title === TITOLO);
    if (esatta) return esatta;
  }
  // ripiego: la lista delle aperte (search è eventualmente consistente)
  const l = await api(`/repos/${REPO_LAVORO}/issues?state=open&per_page=100&sort=created&direction=desc`);
  if (!l.ok || !Array.isArray(l.corpo)) return null;
  return l.corpo.find((x) => x.title === TITOLO) || null;
}

function corpoIssue({ run, esitoRun, motivoRun, errore, proposta }) {
  const righe = [];
  righe.push(`> Aperta dalla **veglia** (\`icare-veglia\`) — scala di escalation del 15/11/2026.`);
  righe.push(`> La veglia NON ripara: rende la riparazione **visibile e assegnata**. Nessuna patch è stata applicata.`);
  righe.push('');
  righe.push(`| Campo | Valore |`);
  righe.push(`|---|---|`);
  righe.push(`| voce | \`${NOME}\` |`);
  righe.push(`| repo del workflow | \`${REPO_SORVEGLIATO}\` |`);
  righe.push(`| workflow | \`${WORKFLOW || 'non dichiarato'}\` |`);
  righe.push(`| artefatto sorvegliato | \`${ARTEFATTO || 'non dichiarato'}\` |`);
  // il campo dice da dove viene l'esito (la SCELTA della run), non confonderlo con l'esito della
  // veglia: la veglia ha misurato `svegliato-invano`, il workflow legge la run che ne è la causa.
  righe.push(`| esito della lettura della run | **${esitoRun}** |`);
  righe.push(`| età artefatto / soglia | ${ETA === null ? '—' : ETA + ' min'} / ${SOGLIA === null ? '—' : SOGLIA + ' min'} |`);
  if (run) {
    righe.push(`| ultima run | [${run.id}](${run.html_url}) · ${run.conclusion || run.status} · ${run.created_at} |`);
  } else {
    righe.push(`| ultima run | non leggibile |`);
  }
  righe.push('');
  righe.push(`**Perché è stata aperta**: ${motivoRun}`);
  if (MOTIVO) righe.push(`\n**Motivo misurato dalla veglia**: ${MOTIVO}`);
  righe.push('');
  righe.push(`## Errore trovato nel log (${errore.trovati.length})`);
  if (!errore.trovati.length) {
    righe.push('_Nessuna firma d’errore riconosciuta_ (`##[error]`, `exit code`, `ENOENT`, `ReferenceError`, `HTTP 4xx/5xx`, timeout).');
  } else {
    for (const t of errore.trovati.slice(0, 8)) {
      righe.push(`- **${t.tipo}** (riga ${t.riga}): \`${t.testo.replace(/`/g, "'").slice(0, 200)}\``);
    }
  }
  righe.push('');
  righe.push('## Estratto del log');
  righe.push('```');
  righe.push(errore.estratto || '(vuoto)');
  righe.push('```');
  righe.push('');
  righe.push('## Proposta');
  righe.push(proposta);
  righe.push('');
  righe.push(`_Aggiornata dal workflow \`riparazione-supervisore.yml\` — una issue per voce, non una per giro._`);
  return righe.join('\n');
}

/* ─────────────────────────────────── main ─────────────────────────────────── */

async function main() {
  const base = {
    nome: NOME || null,
    generato: new Date().toISOString(),
    repo: REPO_SORVEGLIATO,
    workflow: WORKFLOW || null,
    artefatto: ARTEFATTO || null,
    origine: 'icare-veglia → riparazione-supervisore',
  };
  if (!NOME) {
    console.error('[riparazione] manca RIP_NOME: non so quale voce riparare');
    return 1;
  }
  log(`voce ${NOME} · repo ${REPO_SORVEGLIATO} · workflow ${WORKFLOW || '—'} · artefatto ${ARTEFATTO || '—'}`);

  const scelta = await scegliRun();
  const run = scelta.run || null;
  log(`run scelta: ${run ? run.id + ' (' + (run.conclusion || run.status) + ')' : 'nessuna'} · ${scelta.esito} — ${scelta.motivo}`);

  let errore = { trovati: [], estratto: '' };
  let logInfo = { ok: false, motivo: 'nessuna run' };
  if (run) {
    logInfo = await scaricaLog(run.id);
    if (logInfo.ok) {
      errore = cercaErrore(logInfo.testo);
      log(`log: ${logInfo.file} file, ${logInfo.byte} byte · firme d'errore trovate: ${errore.trovati.length}`);
    } else {
      log(`log NON leggibile: ${logInfo.motivo}`);
    }
  }

  const proposta = propostaDa(errore.trovati, scelta.esito);
  const referto = {
    ...base,
    ultimaRun: run
      ? {
          id: run.id,
          conclusion: run.conclusion || null,
          status: run.status || null,
          createdAt: run.created_at || null,
          headSha: run.head_sha || null,
          url: run.html_url || null,
          esitoScelta: scelta.esito,
        }
      : null,
    // `esito` è il verdetto di QUESTA riparazione, e dice anche dove non si è potuto leggere
    esito: logInfo.ok ? (errore.trovati.length ? 'abbozzo' : 'nessun-errore-riconosciuto') : 'log-non-leggibile',
    motivo: scelta.motivo,
    erroreTrovato: errore.trovati,
    estrattoLog: errore.estratto,
    proposta,
    logLetto: { ok: !!logInfo.ok, file: logInfo.file || 0, byte: logInfo.byte || 0, motivo: logInfo.motivo || null },
    elencoRun: scelta.elenco || [],
    issue: null,
  };

  // 4. UNA issue, aggiornata se esiste
  try {
    const body = corpoIssue({ run, esitoRun: scelta.esito, motivoRun: scelta.motivo, errore, proposta });
    const esistente = await trovaIssue();
    if (esistente) {
      const patch = await api(`/repos/${REPO_LAVORO}/issues/${esistente.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: TITOLO, body, state: 'open' }),
      });
      referto.issue = { numero: esistente.number, stato: patch.ok ? 'aggiornata' : 'aggiornamento-fallito', http: patch.stato, url: esistente.html_url };
      if (!patch.ok) log(`aggiornamento issue #${esistente.number} fallito: HTTP ${patch.stato}`);
      else log(`issue #${esistente.number} AGGIORNATA (non duplicata)`);
    } else {
      const creata = await api(`/repos/${REPO_LAVORO}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: TITOLO, body }),
      });
      referto.issue = creata.ok
        ? { numero: creata.corpo.number, stato: 'aperta', http: creata.stato, url: creata.corpo.html_url }
        : { numero: null, stato: 'apertura-fallita', http: creata.stato, errore: String(creata.corpo && creata.corpo.message) };
      if (creata.ok) log(`issue #${creata.corpo.number} APERTA: ${creata.corpo.html_url}`);
      else log(`apertura issue fallita: HTTP ${creata.stato} ${creata.corpo && creata.corpo.message}`);
    }
  } catch (e) {
    referto.issue = { stato: 'errore', errore: String((e && e.message) || e).slice(0, 160) };
  }

  // 3. lo stato su disco (il workflow lo committa)
  const file = join('stato', 'riparazione', `${NOME}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(referto, null, 2) + '\n');
  log(`stato scritto: ${file}`);

  // riepilogo nel run, così l'esito si legge senza aprire il JSON
  const sommario = [
    `## Riparazione \`${NOME}\``,
    `- ultima run: ${run ? `${run.id} · ${run.conclusion || run.status}` : 'non leggibile'}`,
    `- esito: **${referto.esito}** (${scelta.motivo})`,
    `- firme d'errore nel log: ${errore.trovati.length}`,
    `- issue: ${referto.issue && referto.issue.numero ? `#${referto.issue.numero} ${referto.issue.stato}` : (referto.issue && referto.issue.stato) || 'non tentata'}`,
    `- patch applicate: **nessuna** (la riparazione è del proprietario del workflow)`,
  ].join('\n');
  console.log(sommario);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, sommario + '\n');
  return 0;
}

// Eseguito direttamente (cloud o a mano) → fa il lavoro. Importato da una prova → solo funzioni,
// così unzip/cercaErrore/proposta si possono misurare senza toccare GitHub.
const ESECUZIONE_DIRETTA = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (ESECUZIONE_DIRETTA) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[riparazione] errore non gestito:', e);
      process.exit(1);
    });
}

export { unzip, cercaErrore, propostaDa, scaricaLog, scegliRun, main };
