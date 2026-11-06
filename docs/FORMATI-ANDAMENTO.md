# FORMATI DEI FILE `andamento-*` E DEI CONTATORI — stato reale al 6/11/2026

> Documentazione dei file di `feed/` che raccontano il tempo (serie e rilevazioni).
> Regola generale: **un numero senza data e senza fonte non si pubblica.**
> Se il numero è vecchio, si dichiara vecchio; se non c'è, si scrive che non c'è.

## `feed/statistiche.json`
Contatori vivi del giro (scritti da `sync-feed.js` a ogni run).
```json
{
  "generato": "AAAA-MM-GG", "aggiornato": "ISO",
  "totale": 324121,
  "prezzoMedioImm": 165893, "scontoMedioImm": 24,
  "bandePrezzo": { "...": 0 },
  "esiti": null,
  "esitiMotivo": "rilevazione ferma dal 2026-10-30",
  "esitiUltimaRilevazione": {
    "data": "2026-10-30", "aggiudicate": 2183, "deserte": 29268, "sospese": 684,
    "verificati": 32135, "lotti": 324121, "percentuale": 9.9,
    "stato": "fonte in verifica",
    "nota": "esiti verificati: 32.135 su 324.121 lotti (9,9%) — rilevazione del 30/10/2026, fonte in verifica"
  },
  "perData": { "passate": 0, "future": 0, "oggi": 0, "prossimi30": 0, "prossimi90": 0, "totale": 0 }
}
```
- **`esiti`** è `null` quando l'ultima rilevazione è più vecchia di **7 giorni** (`scripts/feed-regole.js`,
  `scegliEsiti`). Non si ricopia un numero vecchio: si scrive `null` + `esitiMotivo`.
- **`esitiUltimaRilevazione`** conserva i numeri dell'ultima rilevazione **con la loro data** e la
  riserva «fonte in verifica». È il dato da mostrare quando `esiti` è `null`: meglio un numero
  datato e dichiarato che un numero che finge di essere vivo.
- **`perData.oggi`** = lotti con `dataAsta` = oggi: deve coincidere con il giorno di oggi in
  `andamento-partecipazione.json`.

## `feed/andamento-esiti.json`
Riepilogo **puntuale** (una rilevazione datata), **non** una serie giornaliera.
```json
{ "generato": "ISO", "esiti": { "aggiudicate": 0, "deserte": 0, "sospese": 0, "nonPubblicato": 0 }, "nota": "..." }
```
- Scritta solo dal giro completo, e solo se ha misurato qualcosa (`sync-feed.js` → `scegliEsiti`).
- La leggono: `sync-feed.js` (per il canone), `dati-indice.js:43`, `report-mensile.js:32` — tutte su
  `.esiti`. **Nessuno** legge una serie `giorni`: non esiste.
- Il 6/11/2026 il file è del **30/10/2026 14:20** (scritto dal Mac, non dal workflow) e da allora
  nessun giro lo ha rigenerato: per questo `statistiche.json` lo dichiara fermo.
- Per una serie storica vera serve una fonte che abbia le date: si costruisce a parte. Non si
  inventa un grafico su un riepilogo.

## `feed/andamento-partecipazione.json`
Serie giornaliera **ricalcolata da zero** a ogni run (`scripts/andamento-partecipazione.js`).
```json
{ "generato": "ISO", "metodo": "ricalcolo da zero dai lotti del feed, un giorno per dataAsta; nessuna stima",
  "giorni": [ { "data": "AAAA-MM-GG", "aggiudicate": 0, "deserte": 0, "sospese": 0, "totale": 0 } ] }
```
- Ultimi **730 giorni**; ogni giorno è contato dai lotti con quella `dataAsta` nei file di regione.
- Un giorno senza lotti **non c'è**: nessuna stima, nessuna eredità dal file precedente.
- Controllo di sanità: la somma di `totale` deve stare nell'ordine delle centinaia di migliaia
  (i lotti degli ultimi due anni), non dei milioni. Il 6/11/2026 la vecchia versione era arrivata a
  ~177 milioni perché incrementava senza azzerare; dopo il fix: 148.127 lotti su 730 giorni.

## `feed/andamento-prezzi.json`
Serie giornaliera del prezzo medio immobiliare.
```json
{ "generato": "ISO", "giorni": [ { "data": "AAAA-MM-GG", "totale": 0, "prezzoMedio": 0, "scontoMedio": 0 } ] }
```
- Un punto al giorno (si sostituisce quello di oggi, si tengono gli ultimi 730).

## Cosa NON si cancella mai
La ricostruzione completa (`MODE=full`) rigenera i file di regione dal PVP, ma non tocca:
`indice.json`, `indice-completo.json`, `ore-aste.json`, `esiti-ritirati.json`,
`andamento-esiti.json`, `andamento-prezzi.json`, `andamento-partecipazione.json`.
Elenco unico in `scripts/feed-regole.js` → `PROTETTI_FEED`. Motivo: sono storia o rilevazioni
datate, non si ricostruiscono dai lotti; cancellarli significa perdere la memoria del progetto.
