// scripts/guardiano-proprieta.js — 13/11/2026
// ---------------------------------------------------------------------------
// LA PROPRIETA' DEI FILE, RESA VISIBILE.
// Regola (01-decisioni/PROPRIETA-FILE.md del Secondo Cervello): un file ha UN solo
// scrittore; chi non lo possiede non lo apre in scrittura, deposita una richiesta.
//
// Perche' esiste: stanotte tre agenti hanno scritto lo stesso
// care-workers/veglia/worker.js in tre modi diversi e ci si e' salvati solo per
// iniziativa di uno di loro. Git non se ne accorge: due scritture locali sullo
// stesso file, l'ultima vince in silenzio. Questo script non impedisce la
// scrittura (quello lo fa la coda di richieste): la RENDE VISIBILE.
//
// Cosa fa, per ogni commit del push:
//   1  legge l'agente dall'intestazione `[agente:...]` del messaggio di commit;
//   2  per ogni file toccato ricava il proprietario da ownership.json (glob);
//   3  se l'agente non e' l'owner -> violazione (in qa/proprieta-stato.json);
//   4  se il commit non ha l'intestazione -> "commit senza agente";
//   5  legge la tabella PROCESSI di care-workers/veglia/worker.js e cerca nomi
//      duplicati (due verita' sullo stesso processo = la tabella mente).
//
// RODAGGIO: SEGNALA, NON BLOCCA. Diventa bloccante con GUARDIANO_BLOCCANTE=1
// quando le violazioni saranno zero per 7 giorni consecutivi (vedi README).
//
// Uso:
//   node scripts/guardiano-proprieta.js                     # commit HEAD
//   node scripts/guardiano-proprieta.js --base <sha> --testa <sha>
//   node scripts/guardiano-proprieta.js --stato /tmp/prova.json --simula "feed/a.json:agente-x"
// Opzioni: --ownership <path> --stato <path> --base <sha> --testa <sha>
//          --simula "<path>:<agente>" (prova negativa, ripetibile) --quieto
// Ambiente: GITHUB_EVENT_BEFORE (base del push), GITHUB_SHA (testa),
//          PROPRIETA_TOKEN (lettura del repo privato care-workers),
//          VEGLIA_WORKER_PATH (file locale, per la prova sul Mac),
//          GUARDIANO_BLOCCANTE=1 (dopo il rodaggio: exit 1 se violazioni > 0).

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_VERGILIA = 'PuntoLuce26/care-workers';
const PERCORSO_VERGILIA = 'veglia/worker.js';
const PREFISSO_STATO = 'proprieta: stato'; // i commit del guardiano non si guardano allo specchio
const MAX_VIOLAZIONI = 200;
const MAX_SENZA_AGENTE = 50;

// ── argomenti ───────────────────────────────────────────────────────────────
function argomenti(argv) {
  const a = { base: null, testa: null, stato: 'qa/proprieta-stato.json', ownership: 'ownership.json', simula: [], quieto: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--base') a.base = argv[++i];
    else if (v === '--testa') a.testa = argv[++i];
    else if (v === '--stato') a.stato = argv[++i];
    else if (v === '--ownership') a.ownership = argv[++i];
    else if (v === '--simula') a.simula.push(argv[++i]);
    else if (v === '--quieto') a.quieto = true;
    else if (v === '--aiuto' || v === '-h') {
      console.log('node scripts/guardiano-proprieta.js [--base sha] [--testa sha] [--stato path] [--ownership path] [--simula "path:agente"] [--quieto]');
      process.exit(0);
    }
  }
  return a;
}

// ── glob -> regex ───────────────────────────────────────────────────────────
// *  = qualunque cosa tranne "/"      ** = qualunque profondita' (anche zero livelli)
function globARegex(glob) {
  let r = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; r += '(?:[^/]+/)*'; }   // "**/" = zero o piu' livelli
        else r += '.*';
      } else r += '[^/]*';
    } else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + r + '$');
}

function caricaMappa(percorso) {
  const grezzo = JSON.parse(fs.readFileSync(percorso, 'utf8'));
  const righe = (grezzo.righe || []).map((r, i) => ({ ...r, indice: i, re: globARegex(String(r.glob || '')) }));
  return { grezzo, righe };
}

// Vince la PRIMA riga che combacia: la mappa si scrive dalla piu' specifica alla piu' generica.
function classifica(file, mappa) {
  for (const r of mappa.righe) if (r.re.test(file)) return r;
  return { glob: null, tipo: 'non-mappato', owner: null, nota: 'path fuori mappa' };
}

// ── git ─────────────────────────────────────────────────────────────────────
function git(args, opzioni = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opzioni });
}

function gitSicuro(args) {
  try { return git(args); } catch (e) { return null; }
}

function parseNomeStato(riga) {
  // "M\tfeed/a.json"  ·  "R100\tvecchio\tnuovo"  ·  "A\tpath"
  const p = riga.split('\t');
  if (p.length < 2) return null;
  const stato = p[0].charAt(0);
  if (stato === 'R' || stato === 'C') return { stato: stato === 'R' ? 'R' : 'C', file: p[2] || p[1], da: p[1] };
  return { stato, file: p[1] };
}

function leggiCommit(base, testa) {
  const esiste = (sha) => !!(sha && /^[0-9a-f]{7,40}$/i.test(sha) && gitSicuro(['cat-file', '-e', sha + '^{commit}']) !== null);
  let intervallo;
  if (base && testa && esiste(base) && esiste(testa) && base !== testa) intervallo = [base + '..' + testa];
  else intervallo = ['-1', testa || 'HEAD'];

  const grezzo = git(['log', '--format=%H%x00%B%x00', ...intervallo]);
  const pezzi = grezzo.split('\u0000').map((s) => s.trim()).filter(Boolean);
  const commit = [];
  for (let i = 0; i < pezzi.length; i += 2) {
    const sha = pezzi[i];
    const corpo = pezzi[i + 1] || '';
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
    const oggetto = corpo.split('\n')[0] || '';
    const diff = gitSicuro(['show', '--name-status', '--format=', sha]) || '';
    const file = diff.split('\n').map((r) => r.trim()).filter(Boolean).map(parseNomeStato).filter(Boolean);
    commit.push({ sha, corpo, oggetto, file });
  }
  return commit;
}

// ── agente dal messaggio di commit ──────────────────────────────────────────
const RE_AGENTE = /\[\s*agente\s*:\s*([^\]\n]+?)\s*\]/i;

function agenteDa(corpo) {
  const m = RE_AGENTE.exec(corpo || '');
  if (!m) return null;
  const nome = m[1].trim().toLowerCase().replace(/\s+/g, '-');
  return nome || null;
}

// ── la tabella PROCESSI di veglia/worker.js ────────────────────────────────
function nomiProcessi(testo) {
  const m = /const\s+PROCESSI\s*=\s*\[([\s\S]*?)\n\];/.exec(testo || '');
  if (!m) return null;
  const nomi = [];
  const re = /nome\s*:\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))/g;
  let x;
  while ((x = re.exec(m[1])) !== null) nomi.push(x[1] || x[2] || x[3]);
  return nomi;
}

async function leggiVeglia() {
  const locale = process.env.VEGLIA_WORKER_PATH;
  if (locale && fs.existsSync(locale)) {
    return { testo: fs.readFileSync(locale, 'utf8'), fonte: 'file locale ' + locale };
  }
  if (locale && !fs.existsSync(locale)) return { errore: 'file locale assente: ' + locale + ' (clone del repo privato non riuscito)' };
  const token = process.env.PROPRIETA_TOKEN || process.env.VEGLIA_WORKER_TOKEN || '';
  const prove = [];
  if (token) {
    prove.push({
      fonte: 'api ' + REPO_VERGILIA,
      url: 'https://api.github.com/repos/' + REPO_VERGILIA + '/contents/' + PERCORSO_VERGILIA,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw', 'User-Agent': 'guardiano-proprieta' },
    });
  }
  prove.push({
    fonte: 'raw ' + REPO_VERGILIA,
    url: 'https://raw.githubusercontent.com/' + REPO_VERGILIA + '/main/' + PERCORSO_VERGILIA,
    headers: { 'User-Agent': 'guardiano-proprieta' },
  });
  for (const p of prove) {
    try {
      const r = await fetch(p.url, { headers: p.headers, signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const testo = await r.text();
        if (/const\s+PROCESSI/.test(testo)) return { testo, fonte: p.fonte };
        return { errore: p.fonte + ': risposta senza tabella PROCESSI (' + r.status + ')' };
      }
    } catch (e) {
      // si prova la successiva
    }
  }
  return {
    errore: 'non leggibile: ' + REPO_VERGILIA + ' e un repo privato e manca la chiave di sola lettura (secret PROPRIETA_DEPLOY_KEY / VEGLIA_WORKER_PATH)',
  };
}

async function controlloProcessi() {
  const veglia = await leggiVeglia();
  if (!veglia.testo) {
    return {
      verificabile: false,
      motivo: veglia.errore || 'sorgente non leggibile',
      nota: 'non verificabile NON e\' un guasto: un allarme falso cronico e\' peggio di un controllo mancante.',
      totaleProcessi: null,
      duplicati: [],
    };
  }
  const nomi = nomiProcessi(veglia.testo);
  if (!nomi) {
    return { verificabile: false, motivo: 'tabella PROCESSI non trovata nel file', totaleProcessi: null, duplicati: [] };
  }
  const conta = new Map();
  for (const n of nomi) conta.set(n, (conta.get(n) || 0) + 1);
  const duplicati = [...conta.entries()].filter(([, v]) => v > 1).map(([nome, volte]) => ({ nome, volte }));
  return { verificabile: true, fonte: veglia.fonte, totaleProcessi: nomi.length, duplicati };
}

// ── il controllo ────────────────────────────────────────────────────────────
function esamina(commit, mappa, statoAttuale) {
  const violazioni = [];
  const senzaAgente = [];

  for (const c of commit) {
    if (String(c.oggetto).toLowerCase().startsWith(PREFISSO_STATO)) continue; // il guardiano non guarda se stesso
    const agente = agenteDa(c.corpo);
    const utili = c.file.filter((f) => f.file && f.file !== statoAttuale);

    if (!agente) {
      senzaAgente.push({
        commit: c.sha.slice(0, 10),
        oggetto: String(c.oggetto).slice(0, 120),
        fileToccati: utili.length,
        esempi: utili.slice(0, 5).map((f) => f.file),
        comeSiRisolve: 'aggiungere [agente:<nome>] alla prima riga del messaggio di commit',
      });
      continue;
    }

    for (const f of utili) {
      const r = classifica(f.file, mappa);
      if (r.tipo === 'owner') {
        if (r.owner !== agente) {
          violazioni.push({
            commit: c.sha.slice(0, 10), agente, file: f.file, tipo: 'owner',
            owner: r.owner, nota: r.nota || '',
            cosaFare: 'non scrivere: deposita la richiesta in coda/' + dominio(r.glob || f.file) + '/<timestamp>-' + agente + '.json',
          });
        }
      } else if (r.tipo === 'generato') {
        const generatori = Array.isArray(r.generatori) ? r.generatori : [];
        if (!generatori.includes(agente)) {
          violazioni.push({
            commit: c.sha.slice(0, 10), agente, file: f.file, tipo: 'generato',
            owner: generatori.length ? generatori.join(' | ') : 'il workflow che lo produce', nota: r.nota || '',
            cosaFare: 'artefatto generato: si cambia il generatore (' + (generatori[0] || 'workflow') + '), non il file',
          });
        }
      } else if (r.tipo === 'append-only') {
        if (f.stato === 'M' || f.stato === 'D' || f.stato === 'R') {
          violazioni.push({
            commit: c.sha.slice(0, 10), agente, file: f.file, tipo: 'append-only',
            owner: 'append-only', nota: r.nota || '',
            cosaFare: 'non si riscrive: crea un file NUOVO datato, oppure una voce che dice SUPERA:',
          });
        }
      }
      // libero e non-mappato: nessun controllo, e NON e' una violazione.
    }
  }
  return { violazioni, senzaAgente };
}

function dominio(glob) {
  const primo = String(glob).split('/')[0].replace(/[*?]/g, '');
  return primo || 'varie';
}

// ── prova negativa: un commit FINT0 passa dallo STESSO codice di produzione ──
// Sintassi: --simula "<path>:<agente>[:A|M|D]"  (stato default M = modifica di un file esistente)
// Serve a mostrare come si vedrebbe una violazione senza scrivere niente nel repo.
function simulazioni(lista, mappa) {
  const violazioni = [];
  const ignorati = [];
  for (const voce of lista) {
    const p = String(voce).split(':');
    const file = p[0];
    const agente = (p[1] || 'ignoto').toLowerCase();
    const statoFile = (p[2] || 'M').toUpperCase().charAt(0);
    const esito = esamina(
      [{ sha: 'simulato', corpo: '[agente:' + agente + ']', oggetto: 'simulazione', file: [{ stato: statoFile, file }] }],
      mappa,
      ''
    );
    for (const v of esito.violazioni) violazioni.push({ ...v, commit: 'simulato', simulata: true });
    if (esito.violazioni.length === 0) {
      const r = classifica(file, mappa);
      ignorati.push({ file, agente, stato: statoFile, tipo: r.tipo, perche: 'questo path e ' + r.tipo + ': nessun controllo, e non e una violazione' });
    }
  }
  return { violazioni, ignorati };
}

// ── main ────────────────────────────────────────────────────────────────────
(async function main() {
  const opt = argomenti(process.argv.slice(2));
  const radice = gitSicuro(['rev-parse', '--show-toplevel']);
  const base = opt.base || process.env.GITHUB_EVENT_BEFORE || null;
  const testa = opt.testa || process.env.GITHUB_SHA || 'HEAD';
  const percorsoMappa = path.isAbsolute(opt.ownership) ? opt.ownership : path.join(radice ? radice.trim() : '.', opt.ownership);
  const percorsoStato = path.isAbsolute(opt.stato) ? opt.stato : path.join(process.cwd(), opt.stato);

  const mappa = caricaMappa(percorsoMappa);
  const commit = opt.simula.length ? [] : leggiCommit(base, testa);
  const { violazioni, senzaAgente } = esamina(commit, mappa, path.basename(opt.stato));
  const sim = opt.simula.length ? simulazioni(opt.simula, mappa) : { violazioni: [], ignorati: [] };
  const processi = await controlloProcessi();

  const tutte = violazioni.concat(sim.violazioni);
  const stato = {
    generato: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    schema: 'proprieta-stato-v1',
    regola: 'un file ha un solo scrittore; chi non lo possiede deposita una richiesta (01-decisioni/PROPRIETA-FILE.md)',
    guardiano: 'guardiano-proprieta (.github/workflows/guardiano-proprieta.yml)',
    repo: process.env.GITHUB_REPOSITORY || 'PuntoLuce26/care-auctions-pagine',
    commit: { esaminati: commit.length, da: base ? String(base).slice(0, 10) : null, a: String(testa).slice(0, 10) },
    fileEsaminati: commit.reduce((s, c) => s + c.file.length, 0),
    sintesi: {
      violazioni: tutte.length,
      violazioniDaCommit: violazioni.length,
      commitSenzaAgente: senzaAgente.length,
      duplicatiProcessi: processi.duplicati.length,
      esito: tutte.length === 0 && senzaAgente.length === 0 && processi.duplicati.length === 0 ? 'pulito' : 'attenzione',
    },
    violazioni: tutte.slice(0, MAX_VIOLAZIONI),
    violazioniTroncate: Math.max(0, tutte.length - MAX_VIOLAZIONI),
    commitSenzaAgente: senzaAgente.slice(0, MAX_SENZA_AGENTE),
    commitSenzaAgenteTroncati: Math.max(0, senzaAgente.length - MAX_SENZA_AGENTE),
    simulazioniIgnorate: sim.ignorati,
    processi: {
      file: 'care-workers/veglia/worker.js (repo privato ' + REPO_VERGILIA + ')',
      verificabile: processi.verificabile,
      fonte: processi.fonte || null,
      motivo: processi.motivo || null,
      nota: processi.nota || null,
      totaleProcessi: processi.totaleProcessi,
      duplicati: processi.duplicati,
    },
    rodaggio: {
      bloccante: process.env.GUARDIANO_BLOCCANTE === '1',
      dal: '2026-11-13',
      passaABloccante: 'quando le violazioni saranno zero per 7 giorni consecutivi',
    },
  };

  fs.mkdirSync(path.dirname(percorsoStato), { recursive: true });
  fs.writeFileSync(percorsoStato, JSON.stringify(stato, null, 2) + '\n');

  if (!opt.quieto) {
    const s = stato.sintesi;
    console.log('guardiano-proprieta — ' + stato.generato);
    console.log('  commit esaminati .... ' + stato.commit.esaminati + '  · file ' + stato.fileEsaminati);
    console.log('  violazioni .......... ' + s.violazioni + (s.violazioniDaCommit !== s.violazioni ? ' (' + s.violazioniDaCommit + ' da commit)' : ''));
    console.log('  commit senza agente .. ' + s.commitSenzaAgente);
    console.log('  PROCESSI duplicati ... ' + (stato.processi.verificabile ? s.duplicatiProcessi + ' su ' + stato.processi.totaleProcessi + ' processi' : 'non verificabile (' + stato.processi.motivo + ')'));
    for (const v of tutte.slice(0, 20)) console.log('   · ' + v.commit + ' ' + v.agente + ' → ' + v.file + ' (owner ' + v.owner + ', ' + v.tipo + ')');
    for (const c of senzaAgente.slice(0, 10)) console.log('   · senza agente: ' + c.commit + ' "' + c.oggetto + '"');
    console.log('  stato scritto in .... ' + opt.stato);
    console.log('  rodaggio ............ ' + (stato.rodaggio.bloccante ? 'BLOCCANTE' : 'segnala soltanto (non blocca il push)'));
  }

  if (stato.rodaggio.bloccante && (tutte.length > 0 || processi.duplicati.length > 0)) process.exit(1);
})().catch((e) => {
  console.error('guardiano-proprieta: errore', e && e.message ? e.message : e);
  process.exit(2);
});
