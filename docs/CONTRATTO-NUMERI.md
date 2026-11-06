# CONTRATTO DEI NUMERI — 5 pagine, 5 fonti, 1 regola

> Scritto il 6/11/2026 (Sam 5.9). Regola: **un numero senza fonte, data e stato non si pubblica.**
> Questo file è la fonte di verità per il lavoro «numeri vivi»: da qui in poi ogni card delle
> cinque pagine deve mostrare numero + fonte + data + stato. Niente pagine toccate finché il
> contratto non è rispettato.

| Pagina | Numero (misurato al 6/11 18:40Z) | Fonte esatta | Rilevazione | Stato |
|---|---|---|---|---|
| **CAReIndex** `/ca-re-index` | 324.121 lotti · prezzo medio immobiliare **165.893 €** · sconto medio base→minima **24%** · bande 72.671 / 53.895 / 65.168 / 44.087 / 37.815 | `feed/indice-completo.json` (settori, bande) + `feed/statistiche.json` (`prezzoMedioImm`, `scontoMedioImm`), scritti da `scripts/sync-feed.js` | **2026-11-06T18:40Z** (ogni ~3-5 min) | **ok** |
| **Osservatorio** `/osservatorio` | 324.121 lotti · confronto OMI: **5.427 lotti** comparabili (3,8% dei 141.580 residenziali) su **22 comuni** · sconto mediano **43,6%** (P25 12,2% · P75 63,8%) · foto/perizie **9.183 lotti** (205.427 file) | `feed/confronto-mercato.json` (OMI, semestre 1° 2026) + `feed/foto-procedure.json` (`foto-perizie`) + `feed/statistiche.json` | OMI **31/10/2026T04:14Z** · foto **in aggiornamento** (nessuna data) · lotti 6/11 18:40Z | **parziale**: OMI fermo al 31/10 e solo 22 comuni con confronto pubblicato su 4.325 censiti; foto senza data |
| **iDati** `/idati` | 9 dataset: aste 324.121 (6/11) · aggiudicazioni 16.771 (28/10) · esiti 2.183 (30/10) · foto 9.183 (in aggiornamento) · aziende 4.391 (6/11) · OMI 22 comuni (31/10) · prezzi 10 giorni (6/11) · metodo 8 indicatori · report 2.871 (6/11 18:36) | `feed/dati-indice.json`, generato da `scripts/dati-indice.js` nello stesso giro (legge statistiche, indice-completo, indice, aggiudicazioni, aziende, confronto-mercato, andamento-esiti, esiti-monitor) | 6/11 18:40Z (il file) · le date interne sono quelle della riga sopra | **misto**: ok aste/prezzi/aziende/metodo; parziale foto e OMI; **fonte in verifica** aggiudicazioni ed esiti |
| **Aggiudicazioni** `/aggiudicazioni` | **16.771** «prezzi reali di aggiudicazione» — di cui 3.145 fallcoaste (con data e tribunale), 13.574 anivg (senza data né tribunale), 52 notarili Verona (id sintetici `vr-2026-*`) | `feed/aggiudicazioni.json` (3.337.207 byte), scritto dal Mac il 29/10. Oggi nessun giro lo rigenera: il full lo riscriverebbe dal PVP esiti (401) o dagli script fallco/ivg | ultima `termina` **28/10/2026** · file fermo dal 29/10 | **fonte in verifica**: tre fonti non omogenee; gli id non sono gli `idAnnuncio` del PVP (1.233 presenti su 16.771, 0 con tribunale coerente) → non collegabili ai lotti |
| **Esiti** `/esiti` | **2.183 aggiudicate · 29.268 deserte · 684 sospese** (riepilogo) · monitor: **2.871 esiti** con prezzo finale, copertura 29/09–28/10, 92 tribunali | `feed/andamento-esiti.json` (riepilogo, scritto dal Mac il 30/10) + `feed/esiti-monitor.json` (rigenerato 6/11 18:40Z da `scripts/idmap-sitemap.js:158` sull'archivio fallco) | riepilogo **30/10/2026T14:20Z** · monitor copertura **28/10/2026** | **fonte in verifica**: il PVP pubblico restituisce `esito: null` (160/160 su 100+60 campioni) e nessun giro rigenera il riepilogo |

## La frase da pubblicare finché la fonte non c'è
**«esiti verificati: 32.135 su 324.121 lotti (9,9%) — rilevazione del 30/10/2026, fonte in verifica»**
(32.135 = 2.183 + 29.268 + 684; il totale lotti è quello del feed al momento della scrittura).
`feed/statistiche.json` la espone già in `esitiUltimaRilevazione.nota`, con `esiti: null` e
`esitiMotivo: "rilevazione ferma dal 2026-10-30"`.

## Cosa NON è dichiarabile oggi
- **Aggiudicazioni come prezzi per lotto**: manca la chiave comune con il PVP (dimostrato: 0 su 114).
  Il numero 16.771 è la somma di tre archivi; va mostrato come *voci d'archivio*, non come
  «prezzi reali collegati alle aste».
- **Serie giornaliera degli esiti**: `andamento-esiti.json` è un riepilogo, non ha `giorni`.
  Una serie vera richiede una fonte che pubblichi data + esito (accesso riservato PVP o altra fonte).
- **Copertura OMI nazionale**: 22 comuni pubblicati contro 4.325 censiti; il 3,8% dei lotti
  residenziali ha la metratura per il confronto. Va scritto accanto al numero, non dopo.

## Come si verifica che il contratto è rispettato
Per ogni card: (1) il numero della pagina si trova identico nel file indicato; (2) la data mostrata
è la data di quel file (non «oggi»); (3) se lo stato è «fonte in verifica», la frase di riserva è
visibile accanto al numero. Un numero che non supera uno dei tre controlli non va in pagina.
