# Accessibilità — test automatici (WCAG 2.1 AA, axe-core)

Generato il 2026-11-22 19:36 UTC · 20 pagine · Playwright + axe-core, WCAG 2.1 AA (tag wcag2a, wcag2aa, wcag21a, wcag21aa)

**Totali**: critical 1 · serious 7 · moderate 0 · minor 0 · violazioni 8

| Pagina | HTTP | C | S | M | m | Violazioni principali |
|---|---|---|---|---|---|---|
| home | 200 | 0 | 1 | 0 | 0 | definition-list(serious) |
| aste | 200 | 0 | 2 | 0 | 0 | aria-input-field-name(serious), definition-list(serious) |
| lotto | 200 | 0 | 1 | 0 | 0 | color-contrast(serious) |
| idati | 200 | 0 | 0 | 0 | 0 | — |
| osservatorio | 200 | 0 | 1 | 0 | 0 | definition-list(serious) |
| aggiudicazioni | 200 | 0 | 0 | 0 | 0 | — |
| buynow | 200 | 1 | 1 | 0 | 0 | aria-input-field-name(serious), select-name(critical) |
| san-pasquale | 200 | 0 | 0 | 0 | 0 | — |
| segnala | 200 | 0 | 0 | 0 | 0 | — |
| ishop | 200 | 0 | 0 | 0 | 0 | — |
| ipartner | 200 | 0 | 0 | 0 | 0 | — |
| piani | 200 | 0 | 0 | 0 | 0 | — |
| termini | 200 | 0 | 0 | 0 | 0 | — |
| privacy | 200 | 0 | 0 | 0 | 0 | — |
| cookie | 200 | 0 | 0 | 0 | 0 | — |
| accessibilita | 200 | 0 | 0 | 0 | 0 | — |
| chi-siamo | 200 | 0 | 0 | 0 | 0 | — |
| fondatore | 200 | 0 | 0 | 0 | 0 | — |
| metodo | 200 | 0 | 1 | 0 | 0 | color-contrast(serious) |
| contatti | 200 | 0 | 0 | 0 | 0 | — |

## Le sei regole violate

| regola | impatto | criterio WCAG | pagine | cosa significa |
|---|---|---|---|---|
| `select-name` | critical | 4.1.2 Name, Role, Value | /buynow | un `<select>` senza nome accessibile: un lettore di schermo annuncia «casella combinata» e non dice di cosa |
| `aria-input-field-name` | serious | 4.1.2 Name, Role, Value | /aste, /buynow | un campo ARIA senza nome accessibile |
| `definition-list` | serious | 1.3.1 Info and Relationships | /, /aste, /osservatorio | la struttura dl/dt/dd è rotta (figli non ammessi o ordine sbagliato) |
| `color-contrast` | serious | 1.4.3 Contrast (Minimum) | /aste/1822566, /metodo | testo con contrasto sotto 4,5:1 (3:1 per il testo grande) |

## Metodo, e i due limiti dichiarati
- Playwright + axe-core, tag `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, viewport 1366×900, `domcontentloaded` + 3,5 s di attesa per il render.
- **Il primo run dava timeout sulla pagina lotto**: non era il sito (risponde in 2,8-4,4 s) ma il test, che aspettava `networkidle` mentre la pagina fa polling continuo. Corretto il test, la pagina entra.
- **Il test automatico non basta**: axe copre circa un terzo dei criteri WCAG. Restano ai test manuali (Claude) tastiera, lettore di schermo, ordine di lettura, testi alternativi sensati, moduli e messaggi di errore, zoom 200%, orientamento, movimento.
- Il report è rigenerato dal workflow `accessibilita` (cron mensile + dispatch); se il commit fallisce per race con gli altri workflow, l'artefatto `accessibilita-report` resta scaricabile dal run.
