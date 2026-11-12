# guardiano-proprieta — il rodaggio, e come si esce

Questo README sta accanto a `guardiano-proprieta.yml` perché è la sua memoria: quello che
il workflow fa, quello che **non** fa, e la condizione con cui diventerà bloccante.

Regola che applica (Secondo Cervello, `01-decisioni/PROPRIETA-FILE.md`):

> Un file ha un solo scrittore. Chi non lo possiede non lo apre in scrittura: deposita una
> richiesta di patch in `coda/<dominio>/<timestamp>-<agente>.json`, e il proprietario la
> applica o la rifiuta con motivo.

## Cosa fa

A ogni push su `main` (e a mano con `workflow_dispatch`):

1. legge `ownership.json` (nella radice di questo repo, copia della mappa ufficiale);
2. per **ogni commit** del push ricava l'agente dall'intestazione `[agente:...]` del
   messaggio di commit;
3. per **ogni file toccato** ricava il proprietario dalla mappa (vince la prima riga, le
   più specifiche stanno in alto);
4. se il committer non è l'owner → **warning** + riga in `qa/proprieta-stato.json`;
5. se un commit non ha l'intestazione → **warning** «commit senza agente»;
6. legge la tabella `PROCESSI` di `care-workers/veglia/worker.js` (repo privato, chiave di
   sola lettura) e se trova **nomi duplicati** apre/aggiorna l'issue **[PROPRIETA]**;
7. scrive `qa/proprieta-stato.json`, caricato anche come artefatto `proprieta-stato` di
   ogni run (prova della run, anche quando il commit è saltato).

**Perché `qa/proprieta-stato.json` si legge dalla raw e non dal sito.** È un file di stato
interno: la regola del progetto (watchdog, 11/11) vuole gli stati letti dalla
`raw.githubusercontent.com/.../main/qa/proprieta-stato.json`, non pubblicati sul sito.

## Come si ricava l'agente

`[agente:<nome>]` **ovunque nel messaggio di commit** (prima riga o corpo), senza
distinzione di maiuscole; gli spazi diventano trattini. Esempi validi:

```
[agente:feed-sync] aggiorna statistiche
[agente:veglia-append] PROCESSI: aggiunta visita-rum
[AGENTE:lead] mappa di proprieta, prima versione
```

Senza intestazione il commit non è «colpevole»: è **anonimo**, e finisce nel contatore
`commitSenzaAgente`. È il difetto più comune delle automazioni, ed è il primo numero da
portare a zero.

## Il rodaggio (oggi: segnala, non blocca)

**Il guardiano NON blocca il push.** Apre warning, scrive lo stato, e apre issue solo per i
duplicati `PROCESSI`. Questa è la fase di rodaggio prevista dalla decisione («fallisce **o**
apre issue [PROPRIETA]»): prima si rende la violazione visibile, poi si rende impossibile.

**Si passa a bloccante quando le violazioni saranno zero per 7 giorni consecutivi.**
Concretamente: sette giorni in cui `qa/proprieta-stato.json` riporta
`sintesi.violazioni = 0` (i `commitSenzaAgente` si azzerano prima, perché dipendono solo
dall'abitudine di scrivere l'intestazione). Il giorno dopo basta una riga:

```yaml
      - name: Controlla la proprieta dei file toccati
        env:
          VEGLIA_WORKER_PATH: /tmp/care-workers/veglia/worker.js
          GITHUB_EVENT_BEFORE: ${{ github.event.before }}
          GITHUB_SHA: ${{ github.sha }}
          GUARDIANO_BLOCCANTE: "1"     # <── questa riga: da qui il push rosso
```

Con `GUARDIANO_BLOCCANTE=1` lo script esce con codice 1 se ci sono violazioni o duplicati, e
la run diventa rossa (il push **non** viene rifiutato da GitHub: il rosso è la firma visibile).

**La condizione è misurabile, non una promessa.** Lo stato porta due campi che la rendono
tale: `rodaggio.giorniPulitiConsecutivi` (contatore) e `storia[]` (una voce per giorno, con
violazioni, commit senza agente, duplicati e `pulito: true|false`, ultimi 14 giorni). Quando
`giorniPulitiConsecutivi` arriva a 7 si aggiunge la riga `GUARDIANO_BLOCCANTE: "1"` e il
rodaggio è finito. Un giorno rosso azzera il contatore: si riparte da capo, non si media.

## Cosa fare quando arriva un warning

Non si corregge il file: si deposita la richiesta.

```
coda/<dominio>/<AAA-MM-GGTHHMMSSZ>-<agente>.json
{ "file": "...", "richiedente": "...", "operazione": "sostituisci|inserisci|elimina",
  "ancora": "testo esatto già presente nel file", "contenuto": "...", "motivo": "...",
  "prova": "...", "scadenza": "AAAA-MM-GG" }
```

Il file della richiesta è **nuovo e unico** (timestamp + agente) e l'ancora è **testuale**,
mai un numero di riga: è così che la collisione diventa impossibile.

## Cosa questo guardiano NON fa (limiti dichiarati)

- **Non impedisce** la scrittura: la previene la coda di richieste, non un workflow.
- **Non valida la sintassi**: quello è `guardiano-workflow.yml` (Ruby/Psych).
- **Non controlla i path fuori mappa**: sono `non-mappato` e non producono violazioni. La
  mappa cresce per decisione del Lead, non per caso.
- **Non legge il repo privato senza chiave**: se `PROPRIETA_DEPLOY_KEY` manca, i duplicati
  `PROCESSI` sono dichiarati **non verificabili** (mai «falliti»: un allarme falso cronico è
  peggio di un controllo mancante).
- **Non controlla gli agenti uno per uno**: controlla i commit. Un agente che scrive in
  locale senza committare non passa di qui (per quello serve il check-and-set sulla sha).

## Le chiavi

- `PROPRIETA_DEPLOY_KEY` — chiave SSH **di sola lettura** (deploy key `read_only` sul repo
  privato `PuntoLuce26/care-workers`, titolo «guardiano-proprieta (sola lettura)»). Serve a
  leggere `veglia/worker.js`. Revoca: cancellare la deploy key dal repo e il secret.
- Nessun altro segreto. Il token del repo serve solo a `contents: write` per pubblicare lo
  stato e a `issues: write` per l'issue `[PROPRIETA]`.

## Il primo giro (misurato, non previsto)

- `qa/proprieta-stato.json` nasce con `schema: proprieta-stato-v1`.
- Commit `6e0f00b8fc`, run **43328922152**: 1 job, 12 step, verde. `fileEsaminati: 4`,
  **3 violazioni** (`.github/workflows/guardiano-proprieta.yml`, `.github/workflows/
  guardiano-proprieta.README.md` → `workflow-owner`; `ownership.json` → `lead`),
  **0 commit senza agente**, **0 duplicati** `PROCESSI` su **14 processi** letti dal repo
  privato (`care-workers letto: 1129 righe in veglia/worker.js`).
- Il primo commit che ha creato mappa e guardiano è **del Lead, per procura** (agente
  `proprieta-file`): il guardiano lo segnala come violazione, ed è la prova che le vede.
  È l'unica violazione «di esordio» ammessa: dalla seconda run in poi ogni violazione è
  vera e va chiusa (depositando una richiesta, non scrivendo il file). Il contatore
  `giorniPulitiConsecutivi` parte quindi da 0 e i 7 giorni si contano dal primo giorno pulito.
