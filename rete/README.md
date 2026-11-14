# RETE+ v1 — i quattro servizi, con collaudo

Non è la rete 10/10: è la **v1 funzionante** dei quattro + mancanti, ognuno con un contratto e un collaudo che prova anche i casi cattivi.

| Servizio | Cosa fa | Comando | Esito |
|---|---|---|---|
| **VIDS+** | QA video: 4K verticale, 30 fps, H.264, muto, durata | `node rete/vids-plus.mjs <file\|URL>` | 0 PASS / 2 FAIL |
| **EINSTEIN+** | gate del brief: campi, verifica eseguibile, permessi, scadenza, placeholder | `node rete/einstein-plus.mjs <brief.json>` | 0 PASS / 2 FAIL |
| **GREEN2+** | verificatore anti-invenzione: ogni numero ha valore, fonte https raggiungibile e data | `node rete/green2-plus.mjs <claims.json>` | 0 PASS / 2 FAIL |
| **EMERGENT+** | gate post-publish sull'artefatto: build, BuyNow, CTA iShop, /cerca 200, 37 foto San Pasquale 200 | `node rete/emergent-plus.mjs` | 0 PASS / 2 FAIL |

`node rete/collaudo.mjs` esegue **7 casi** (buoni e cattivi) e la produzione, e scrive `rete/stato.json`. Workflow: `.github/workflows/rete-plus.yml` (daily 06:40 UTC + manuale).

## Cosa non è ancora

- I quattro servizi condividono lo stesso runner: non sono ancora infrastrutture indipendenti.
- VIDS+ v1 controlla metadati e audio, non black-frame/qualità percettiva.
- GREEN2+ v1 controlla le fonti dichiarate, non riscrive il report.
- EMERGENT+ v1 controlla HTTP/HTML, non il DOM renderizzato con Playwright.

Questi limiti sono dichiarati: la rete resta **PARZIALE** finché non hanno storico e ridondanza.
