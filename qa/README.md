# QA CAReAuctions

QA cloud che apre il sito come un utente, clicca solo controlli sicuri, compila i form senza inviarli,
controlla immagini, link, errori JavaScript e risposte HTTP, legge i run GitHub Actions e gli endpoint
pubblici (stato, feed, chat iCARe, iCAReWall, voce) e produce un report con le proposte di correzione.

## Dove gira
GitHub Actions, nel repo pubblico `PuntoLuce26/care-auctions-pagine` (workflow `qa.yml`).
È un server in cloud già disponibile: nessun nuovo costo fisso, nessuna macchina da tenere accesa.

## Quando gira
- **Ogni 30 minuti** (schedule).
- **A ogni push** che tocca `qa/**`, `scripts/verifica-playwright.mjs`, `.github/workflows/qa.yml` o `prerender/**` (quindi dopo ogni pubblicazione Emergent che rigenera gli snapshot).
- **A mano**: `gh workflow run qa.yml` oppure dalla tab Actions.
- **Repository dispatch** `emergent-published` o `qa-run` (pronto per un trigger dal worker/guardiano).
- **Dopo un nostro deploy edge**: usare `qa/trigger.sh` (o il comando `curl` in fondo).

## Cosa controlla
- 18 rotte chiave × desktop 1440 e mobile 390.
- HTTP, testo della pagina, titolo, canonical, errori JavaScript (`pageerror`), errori console, risorse 4xx/5xx.
- Immagini: `naturalWidth` dopo lo scroll (lazy load compreso).
- Form: compila i campi sicuri, seleziona le opzioni, **non invia mai**; segnala i campi obbligatori vuoti.
- Click sicuri: cookie banner, menu, tab, accordion, "Mostra/Leggi/Dettagli". **Mai** Paga, Acquista, Compra, Invia, Pubblica, Elimina, Esci, Dona, Abbonati, Firma, Richiedi.
- Link interni: campione di 45 link, status finale; 404/5xx = problema.
- SEO/AI: `llms.txt` (pagine nuove + "Come citare"), `robots.txt` (agenti AI), sitemap index, `sitemap-novita` (hreflang affiliazione), `sitemap-pagine` (buynow), home umana (striscia "Scopri anche"), home bot (4 link), build sito = origine.
- Feed: `statistiche.json` fresco (<2 h) e `aggiudicazioni.json` non vuoto.
- Cross-browser: smoke su Chromium, Firefox e WebKit (4 rotte).
- Log: ultimi 30 run GitHub Actions (fallimenti nelle 24 h) + endpoint pubblici. **I log interni di Emergent non sono accessibili via API**: il QA misura ciò che il sito e gli endpoint pubblici restituiscono, e lo dichiara nel report.

## Report
- `qa/out/report.json`: dati completi.
- `qa/out/summary.md`: tabella leggibile (anche nel run summary di GitHub).
- `qa/out/fix-proposals.md`: proposte di correzione + prompt Emergent in inglese.
- `qa/out/patch.diff`: patch sicura, solo se esiste una sostituzione esatta in `qa/fix-rules.json`.
- Artefatto `qa-report` del run (30 giorni).
- Issue GitHub `[QA] ...`: una sola issue aperta, aggiornata a ogni giro con critici/alti.

## Patch e applicazione (regola di sicurezza)
- **Patch automatica**: solo sostituzioni esatte dichiarate in `qa/fix-rules.json`. La CI crea un branch `qa/auto-<run>` e apre una PR; non tocca `main` da sola. Per attivare la PR automatica serve la variabile repo `QA_AUTOMERGE=true`.
- **Bug dell'app Emergent**: il QA genera un prompt in inglese con pagina, viewport, messaggio e correzione suggerita. Non applichiamo codice sul deploy di Emergent: non abbiamo accesso al loro deploy e una patch non verificata in produzione è un guasto.
- **Bug dell'edge/worker**: il report indica il file e la correzione; il deploy si fa con backup e verifica, come sempre.

## Quality gate
Il run diventa rosso solo per i critici: HTTP 5xx, pagina vuota, errore JavaScript, build non allineata, feed fermo. Gli alti/medi restano nel report e nell'issue senza bloccare la pipeline.

## Esecuzione locale
```bash
cd careauctions
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
QA_FAST=1 node qa/run.mjs
```
Senza `QA_FAST` fa tutte le rotte e i due viewport. Su Mac serve Playwright (`node_modules/playwright`) e Chrome di sistema.

## Aggiungere una rotta o una regola
- Rotte: `qa/config.mjs` (`ROUTES`, `SMOKE_ROUTES`).
- Regole di patch sicura: `qa/fix-rules.json`, formato `"https://careauctions.co/vecchio": "https://careauctions.co/nuovo"`.
- Click sicuri/vietati: `qa/config.mjs` (`SAFE_CLICK`, `DANGER_CLICK`). In caso di dubbio, un click non si fa.

## Trigger dal cloud
```bash
curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/PuntoLuce26/care-auctions-pagine/actions/workflows/qa.yml/dispatches \
  -d '{"ref":"main"}'
```
`qa/trigger.sh` fa questo con il token in `careauctions/.tools/github-token.txt`.
