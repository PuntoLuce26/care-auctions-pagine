# Accessibilità — test automatici (WCAG 2.1 AA, axe-core)

Generato il 2026-11-22 19:33 UTC · 20 pagine · Playwright + axe-core, WCAG 2.1 AA (tag wcag2a, wcag2aa, wcag21a, wcag21aa)

**Totali**: critical 1 · serious 5 · moderate 0 · minor 0 · violazioni 6

| Pagina | HTTP | C | S | M | m | Violazioni principali |
|---|---|---|---|---|---|---|
| home | 200 | 0 | 0 | 0 | 0 | — |
| aste | 200 | 0 | 2 | 0 | 0 | aria-input-field-name(serious), definition-list(serious) |
| lotto | — | 0 | 0 | 0 | 0 | TimeoutError: page.goto: Timeout 45000ms exceeded.
Call log:
  - navigating to "https://careauctions.co/aste/1822566", waiting until "networkidle"
 |
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

Le pagine con criticità o seri vanno portate a Emergent in un prompt unico, con il criterio WCAG e l'elemento.
