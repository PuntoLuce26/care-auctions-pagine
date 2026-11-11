# Foto a tema della newsletter mensile

Ogni comunicato CAReIndex (il primo del mese) ha **una foto a tema**, creata da Emergent
in stile sito — non un'immagine di repertorio, non un segnaposto.

## Come funziona
1. Il generatore `scripts/comunicato-mensile.js` crea `comunicati/<AAAA-MM>.md/.html/.pdf`.
2. Cerca `img/newsletter/<AAAA-MM>.webp` (oppure `.jpg` o `.png`).
3. Se c'è, la mette in cima all'HTML e nel Markdown. Se non c'è, il comunicato esce **senza foto**.

Quindi: caricare l'immagine **prima** della generazione del mese.

## Regole dell'immagine (stile CAReAuctions)
- Palette: crema `#FBF9F4`, blu notte `#0F1E3A`, oro `#D4A84B`, grigio caldo `#A2977E`.
- Vista fotografica, luce naturale, niente testo nell'immagine, niente loghi, niente volti riconoscibili.
- Formato orizzontale 16:9, minimo 1600×900, `.webp` sotto i 300 KB.
- Tema coerente col mese e con i numeri del comunicato (es. ripresa del mercato, stagionalità delle aste).
- Nome file **obbligatorio**: `AAAA-MM.webp` (es. `2026-12.webp`).

## Chi la fa
**Emergent**, con il brief mensile (in inglese) che prepariamo noi: la parte visiva è sua,
i numeri e il testo sono nostri.
