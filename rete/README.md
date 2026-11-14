# RETE+ v2 — quattro servizi indipendenti, con collaudo

Quattro workflow separati, ognuno con il proprio runner e il proprio schedule. Non è più un unico workflow condiviso.

| Servizio | Workflow | Cosa fa | Test |
|---|---|---|---|
| **VIDS+** | `rete-vids.yml` | 4K verticale, 30 fps, H.264, muto, durata, **black-frame ≥0,5s** | 3 casi (buono, 720p+audio, nero) |
| **EINSTEIN+** | `rete-einstein.yml` | brief: campi, verifica eseguibile, permessi, scadenza, placeholder | 2 casi (valido, rotto) |
| **GREEN2+** | `rete-green2.yml` | claim con valore+fonte https+data; **genera `green2-report-corretto.md`** | 2 casi (validi, senza fonte) |
| **EMERGENT+** | `rete-emergent.yml` | HTTP/HTML **e DOM renderizzato** (Playwright): CTA, banner, BuyNow, 37 foto, viewer, errori JS, overflow | produzione |

Stati: artefatti `rete-*-stato` su ogni run. Schedule: 06:10, 06:15, 06:20, 06:40 UTC.

## Cosa resta

- **Ridondanza geografica/provider**: i quattro servizi sono indipendenti tra loro ma girano tutti su GitHub Actions. Una seconda infrastruttura (altro provider/regione) non è stata creata.
- VIDS+ controlla i black-frame, non la qualità percettiva.
- GREEN2+ produce un report corretto, non modifica il file originale.
- EMERGENT+ DOM copre le rotte chiave, non ogni pagina delle 91 lingue.

Questi limiti sono dichiarati: 4 servizi su 4, limiti tecnici chiusi; la rete 10/10 richiede la ridondanza, non un'altra patch.
