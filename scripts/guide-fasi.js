#!/usr/bin/env node
// guide-fasi.mjs — le guide per OGNI fase dell'asta (meccanismo Immobiliare.it / Auction.com).
//
// Oggi sitemap-guide.xml dichiara UNA guida in 9 lingue: il meccanismo dei colossi vuole una
// pagina per OGNI fase (offerta, termini, perizia, aggiudicazione, pagamento, decreto, rilascio),
// perché chi cerca «come si fa l'offerta all'asta» non deve cadere in una pagina generica.
//
// Il generatore scrive:
//   guide/<lingua>/<fase>.html      → la pagina (server-rendered, testo completo, fonte accanto a ogni passo)
//   feed/guide-fasi.json            → il manifesto che alimenta sitemap-guide.xml (una sola verità:
//                                     la sitemap non può dichiarare una pagina che non esiste)
//
// Regole di contenuto:
//   · ogni passo porta la FONTE UFFICIALE accanto (PVP / Ministero della Giustizia / codice);
//   · si usa il PREZZO BASE, mai l'offerta minima come se fosse uno sconto; l'offerta minima è
//     il pavimento legale (75% del prezzo base) e va chiamata così;
//   · nessun consiglio personalizzato e nessuna promessa: la pagina è informativa;
//   · la data di aggiornamento è dentro la pagina e nel manifesto.

const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const OGGI = new Date().toISOString().slice(0, 10);
const LINGUE = ['it', 'en'];
const PVP = 'https://pvp.giustizia.it';
const GIUSTIZIA = 'https://www.giustizia.it/giustizia/it/mg_3_7.page';

// ---- contenuti: una fase, due lingue ---------------------------------------
const FASI = [
  {
    slug: 'offerta',
    it: {
      titolo: 'Fare l\'offerta all\'asta: cauzione, offerta minima e modulo',
      descrizione: 'Come si presenta un\'offerta in un\'asta giudiziaria italiana: la cauzione, l\'offerta minima (75% del prezzo base), il modulo e i tempi. Con la fonte ufficiale accanto a ogni passo.',
      lead: 'In un\'asta giudiziaria non si compra al rialzo davanti a un banditore: si presenta un\'offerta scritta prima dell\'asta. Chi la prepara bene ha già vinto metà della partita.',
      sezioni: [
        { h: '1 · Il prezzo di partenza e l\'offerta minima', p: 'Ogni lotto ha due cifre: il <strong>prezzo base d\'asta</strong> (la valutazione da cui si parte) e l\'<strong>offerta minima</strong>, che è il 75% del prezzo base. Sotto l\'offerta minima la busta non si apre nemmeno: è il pavimento di legge, non uno sconto. Confondere le due cifre è l\'errore più comune: le statistiche di mercato si leggono sempre sul prezzo base.', fonte: { t: 'PVP — scheda del lotto con prezzo base e offerta minima', u: PVP } },
        { h: '2 · La cauzione', p: 'La cauzione si versa <strong>prima</strong> dell\'offerta, con le modalità indicate nell\'avviso di vendita: di regola è il 10% del prezzo base, ma è l\'avviso che comanda. Si versa con assegno circolare, bonifico o deposito, secondo quanto prescrive il bando; senza la prova del versamento la busta è irricevibile.', fonte: { t: 'Avviso di vendita del tribunale (pubblicato sul PVP)', u: PVP } },
        { h: '3 · Il modulo e la busta', p: 'L\'offerta si presenta su un modulo che indica: generalità, prezzo offerto, lotto, modalità di pagamento del saldo e gli allegati (cauzione, documento, eventuale procura). Se l\'asta è telematica si compila sul portale indicato dall\'avviso; altrimenti si deposita in cancelleria o davanti al notaio delegato, entro il termine.', fonte: { t: 'Ministero della Giustizia — come si partecipa a un\'asta', u: GIUSTIZIA } },
        { h: '4 · Le offerte che non si possono fare', p: 'Non può offrire chi è fallito, il debitore esecutato e chi ha curato la procedura (il consulente, il custode, il delegato). Si può offrire tramite un avvocato o un procuratore, con procura speciale.', fonte: { t: 'Codice di procedura civile, artt. 571-579 (offerte e vendita)', u: 'https://www.normattiva.it' } },
        { h: '5 · Dopo la presentazione', p: 'L\'offerta è irrevocabile. Se al termine nessuno ha offerto, il giudice dispone un nuovo tentativo con prezzo ridotto (di regola fino al 25% in meno). Se più offerte arrivano, si apre la gara fra gli offerenti secondo le modalità fissate dal giudice.', fonte: { t: 'PVP — esiti e nuovo tentativo della procedura', u: PVP } },
      ],
    },
    en: {
      titolo: 'How to bid at an Italian court auction: deposit, minimum bid and form',
      descrizione: 'How a bid is filed in an Italian judicial auction: the deposit, the minimum bid (75% of the starting price), the form and the deadlines — with the official source next to every step.',
      lead: 'In a judicial auction you do not buy by outbidding an auctioneer in a room: you file a written bid before the auction. Prepared properly, half the work is already done.',
      sezioni: [
        { h: '1 · Starting price and minimum bid', p: 'Every lot carries two figures: the <strong>starting price</strong> and the <strong>minimum bid</strong>, which is 75% of it. Below the minimum bid the envelope is not even opened: it is the legal floor, not a discount. Mixing the two up is the most common mistake — market statistics are always read on the starting price.', fonte: { t: 'PVP — lot page with starting price and minimum bid', u: PVP } },
        { h: '2 · The deposit', p: 'The deposit is paid <strong>before</strong> the bid, exactly as the sale notice prescribes: usually 10% of the starting price, but the notice governs. Bank draft, transfer or deposit: proof of payment must be inside the envelope, or the bid is inadmissible.', fonte: { t: 'Sale notice published by the court (on the PVP portal)', u: PVP } },
        { h: '3 · The form and the envelope', p: 'The bid is filed on a form stating identity, the price offered, the lot, the balance payment method and the attachments (deposit, ID, power of attorney if any). Online auctions are filed on the portal named in the notice; otherwise at the court registry or before the delegated notary, before the deadline.', fonte: { t: 'Italian Ministry of Justice — how to take part in an auction', u: GIUSTIZIA } },
        { h: '4 · Who cannot bid', p: 'The debtor, bankrupt parties and anyone who worked on the procedure (valuer, custodian, delegate) cannot bid. You may bid through a lawyer with a special power of attorney.', fonte: { t: 'Italian Code of Civil Procedure, arts. 571-579', u: 'https://www.normattiva.it' } },
        { h: '5 · After filing', p: 'A bid cannot be withdrawn. If nobody bids, the judge orders a new attempt at a reduced price (usually up to 25% less). If several bids arrive, the auction opens among the bidders as the judge directs.', fonte: { t: 'PVP — outcome and next attempt of the procedure', u: PVP } },
      ],
    },
  },
  {
    slug: 'termini',
    it: {
      titolo: 'I termini dell\'asta: date, scadenze e cosa succede se cambiano',
      descrizione: 'Le date che contano in un\'asta giudiziaria italiana: pubblicazione dell\'avviso, termine per offrire, data dell\'asta, rinvio, saldo. Come si leggono senza sbagliare.',
      lead: 'Un\'asta si vince anche rispettando le date. I termini non sono un dettaglio burocratico: un\'ora di ritardo su un deposito vale la perdita del lotto.',
      sezioni: [
        { h: '1 · La pubblicazione dell\'avviso', p: 'L\'avviso di vendita viene pubblicato sul PVP e, nei casi previsti, sui quotidiani. Contiene data e ora dell\'asta, modalità (sincrona, telematica o senza incanto), prezzo base, offerta minima e termine per le offerte. Da qui parte il conteggio di tutti i termini.', fonte: { t: 'PVP — avviso di vendita della procedura', u: PVP } },
        { h: '2 · Il termine per offrire', p: 'Le offerte si depositano entro il termine indicato nell\'avviso, di norma almeno un giorno prima dell\'asta (il giudice può fissarlo diversamente). Il deposito telematico chiude all\'ora indicata dal portale: non c\'è tolleranza.', fonte: { t: 'Ministero della Giustizia — vendite e aste', u: GIUSTIZIA } },
        { h: '3 · La data dell\'asta', p: 'All\'ora fissata il giudice (o il delegato) apre le buste, verifica la regolarità e apre la gara. Le aste telematiche durano una finestra di tempo definita dal bando: le offerte successive si rilanciano sul portale.', fonte: { t: 'Regole della vendita telematica (art. 574-bis c.p.c.)', u: 'https://www.normattiva.it' } },
        { h: '4 · Rinvio, sospensione, istanze', p: 'Un\'asta può essere rinviata o sospesa (istanza del debitore, errore nella pubblicazione, ricorso). Chi ha offerto lo scopre dal portale o dalla cancelleria: per questo l\'avviso e la scheda del lotto vanno riletti fino al giorno prima.', fonte: { t: 'PVP — stato della procedura', u: PVP } },
        { h: '5 · I termini dopo l\'aggiudicazione', p: 'Aggiudicato il lotto, il saldo del prezzo va versato entro il termine fissato dal giudice (spesso 60-120 giorni). Se il termine non è rispettato si decade e la cauzione si perde come stabilito dal provvedimento.', fonte: { t: 'Provvedimento di aggiudicazione (atti della procedura)', u: PVP } },
      ],
    },
    en: {
      titolo: 'Auction deadlines: dates, terms and what happens when they change',
      descrizione: 'The dates that matter in an Italian judicial auction: publication of the notice, bid deadline, auction date, postponement, balance. How to read them without mistakes.',
      lead: 'Auctions are also won by respecting dates. Deadlines are not paperwork: one hour late on a filing can cost you the lot.',
      sezioni: [
        { h: '1 · Publication of the notice', p: 'The sale notice is published on the PVP portal and, where required, in newspapers. It states date and time of the auction, the method (synchronous, online or without bidding), the starting price, the minimum bid and the bid deadline. Every term counts from here.', fonte: { t: 'PVP — sale notice of the procedure', u: PVP } },
        { h: '2 · The bid deadline', p: 'Bids are filed by the deadline in the notice, normally at least one day before the auction (the judge may set it differently). Online filing closes at the stated hour: there is no grace period.', fonte: { t: 'Italian Ministry of Justice — sales and auctions', u: GIUSTIZIA } },
        { h: '3 · The auction date', p: 'At the stated time the judge (or delegate) opens the envelopes, checks formalities and opens the bidding. Online auctions run for a window defined by the notice, with bids raised on the portal.', fonte: { t: 'Online sale rules (art. 574-bis, Code of Civil Procedure)', u: 'https://www.normattiva.it' } },
        { h: '4 · Postponement, suspension, applications', p: 'An auction can be postponed or suspended (debtor application, publication error, appeal). Bidders learn about it from the portal or the registry — which is why notice and lot page must be re-read until the day before.', fonte: { t: 'PVP — status of the procedure', u: PVP } },
        { h: '5 · Deadlines after the award', p: 'Once awarded, the balance must be paid within the term set by the judge (often 60-120 days). Missing it means forfeiture and loss of the deposit as the order provides.', fonte: { t: 'Award order (documents of the procedure)', u: PVP } },
      ],
    },
  },
  {
    slug: 'perizia',
    it: {
      titolo: 'Leggere la perizia: cosa contiene e cosa controllare prima di offrire',
      descrizione: 'La perizia del consulente tecnico d\'ufficio: identificazione, consistenza, stato, difformità, occupazione, valore. Come si legge per calcolare l\'offerta massima.',
      lead: 'La perizia è il documento che decide se l\'affare è vero. Chi non la legge compra una casa che non ha visto, con i difetti che non ha chiesto.',
      sezioni: [
        { h: '1 · Chi la scrive e cosa vale', p: 'La perizia è la relazione del consulente tecnico d\'ufficio (CTU) nominato dal giudice: descrive l\'immobile, lo stato, la provenienza e il valore di stima. È allegata agli atti della procedura e si consulta con l\'avviso di vendita.', fonte: { t: 'PVP — allegati della procedura (perizia in PDF)', u: PVP } },
        { h: '2 · Cosa contiene', p: 'Identificazione catastale, consistenza (mq, vani), stato di manutenzione, impianti, difformità edilizie e catastali, stato di occupazione (libero o occupato, da chi e con quale titolo), provenienza, vincoli, spese condominiali e valore di stima.', fonte: { t: 'Atti della procedura pubblicati sul PVP', u: PVP } },
        { h: '3 · Le difformità', p: 'Abusi e difformità catastali sono a carico dell\'acquirente: la perizia li elenca e, se sanabili, indica il costo della sanatoria. Una difformità non sanabile rende l\'immobile difficile da rivendere e da mutuare.', fonte: { t: 'Perizia — capitolo sulle difformità', u: PVP } },
        { h: '4 · L\'occupazione', p: 'Un immobile occupato richiede tempo e costi per essere liberato. La perizia dice se è libero o occupato, e in che modo si può ottenere la consegna: è una delle voci che pesa di più sul prezzo che conviene offrire.', fonte: { t: 'Perizia — stato di occupazione; avviso di vendita', u: PVP } },
        { h: '5 · Dal valore di stima all\'offerta massima', p: 'Il valore di stima non è il prezzo giusto: dal valore si sottraggono lavori, sanatorie, spese condominiali arretrate, imposte di acquisto, onorari e il tempo di attesa. Il risultato è l\'offerta massima: oltre quella cifra l\'affare non è più un affare, anche se l\'asta si "vince".', fonte: { t: 'Prezzo Chiavi in Mano — il costo reale di un\'asta (CAReAuctions)', u: 'https://careauctions.co/stima-costi' } },
      ],
    },
    en: {
      titolo: 'Reading the valuation report: what it contains and what to check before bidding',
      descrizione: 'The court-appointed expert report: identification, size, condition, irregularities, occupation, value. How to read it to calculate your maximum bid.',
      lead: 'The valuation report decides whether the deal is real. Whoever skips it buys a house they have not seen, with defects they did not ask for.',
      sezioni: [
        { h: '1 · Who writes it and what it is worth', p: 'It is the report of the court-appointed expert (CTU): it describes the property, its condition, its history and the appraised value. It is filed with the procedure documents and read together with the sale notice.', fonte: { t: 'PVP — attachments of the procedure (report as PDF)', u: PVP } },
        { h: '2 · What it contains', p: 'Land-registry identification, size (sqm, rooms), condition, systems, building and registry irregularities, occupation (free or occupied, by whom and under what title), chain of title, encumbrances, condominium arrears and appraised value.', fonte: { t: 'Procedure documents published on the PVP', u: PVP } },
        { h: '3 · Irregularities', p: 'Building abuses and registry mismatches are on the buyer: the report lists them and, where fixable, gives the cost of regularisation. An unfixable irregularity makes the property hard to resell and to mortgage.', fonte: { t: 'Valuation report — irregularity section', u: PVP } },
        { h: '4 · Occupation', p: 'An occupied property costs time and money to free. The report states whether it is free or occupied and how delivery can be obtained: it is one of the heaviest items in the price you should bid.', fonte: { t: 'Valuation report — occupation; sale notice', u: PVP } },
        { h: '5 · From appraised value to maximum bid', p: 'The appraised value is not the right price: subtract works, regularisations, condominium arrears, purchase taxes, fees and waiting time. What remains is your maximum bid: above it the deal stops being a deal, even if you "win" the auction.', fonte: { t: 'Turnkey Price — the real cost of an auction (CAReAuctions)', u: 'https://careauctions.co/stima-costi' } },
      ],
    },
  },
  {
    slug: 'aggiudicazione',
    it: {
      titolo: 'L\'aggiudicazione: come si vince l\'asta e cosa succede dopo',
      descrizione: 'Come funziona l\'aggiudicazione di un\'asta giudiziaria: apertura delle offerte, gara, aggiudicazione provvisoria, asta deserta, rilancio. Con la fonte ufficiale.',
      lead: 'Vincere l\'asta non è la fine: è il momento in cui gli obblighi diventano tuoi. Sapere come funziona l\'aggiudicazione evita di perdere la cauzione per un errore di forma.',
      sezioni: [
        { h: '1 · L\'apertura delle offerte', p: 'All\'ora fissata il giudice apre le buste (o chiude la finestra telematica), verifica che ciascuna offerta sia regolare, che la cauzione sia versata e che il prezzo non sia sotto l\'offerta minima. Le offerte irregolari si escludono.', fonte: { t: 'PVP — verbale di gara della procedura', u: PVP } },
        { h: '2 · La gara', p: 'Se le offerte sono più di una si apre la gara: si rilanciano secondo le regole fissate nel bando, con un rialzo minimo indicato. Nelle aste senza incanto di regola vince l\'offerta più alta; nelle aste con incanto si procede a rilanci.', fonte: { t: 'Codice di procedura civile — vendita senza incanto e con incanto', u: 'https://www.normattiva.it' } },
        { h: '3 · L\'aggiudicazione', p: 'Il giudice dichiara l\'aggiudicazione (di regola provvisoria) a favore del miglior offerente e fissa il termine per il saldo del prezzo. Da quel momento l\'aggiudicatario è obbligato: non può ritirarsi senza perdere la cauzione.', fonte: { t: 'Provvedimento di aggiudicazione (atti della procedura)', u: PVP } },
        { h: '4 · Se l\'asta va deserta', p: 'Se nessuno offre, il giudice dispone un nuovo tentativo, di regola a prezzo ridotto fino al 25%. Un\'asta deserta non è un\'asta chiusa: il lotto torna, spesso a condizioni migliori, e chi lo seguiva lo sa prima degli altri.', fonte: { t: 'PVP — esiti delle aste (deserte e nuovo tentativo)', u: PVP } },
        { h: '5 · I controlli prima di firmare', p: 'Prima del saldo si controllano le spese della procedura, le imposte, le spese condominiali arretrate e lo stato dell\'immobile. Il quadro economico completo si costruisce qui, non dopo il decreto.', fonte: { t: 'Avviso di vendita e perizia — spese e oneri', u: PVP } },
      ],
    },
    en: {
      titolo: 'The award: how an auction is won and what happens next',
      descrizione: 'How the award of an Italian judicial auction works: opening of bids, bidding, provisional award, unsold auctions, next attempt. With official sources.',
      lead: 'Winning is not the end: it is when obligations become yours. Knowing how the award works prevents losing the deposit over a formality.',
      sezioni: [
        { h: '1 · Opening of the bids', p: 'At the stated time the judge opens the envelopes (or closes the online window), checks that each bid is formal, that the deposit is paid and that the price is not below the minimum bid. Irregular bids are excluded.', fonte: { t: 'PVP — auction record of the procedure', u: PVP } },
        { h: '2 · The bidding', p: 'With more than one bid, bidding opens under the rules of the notice, with a stated minimum increment. In auctions without bidding the highest offer normally wins; with bidding, the price is raised in rounds.', fonte: { t: 'Italian Code of Civil Procedure — sale with and without bidding', u: 'https://www.normattiva.it' } },
        { h: '3 · The award', p: 'The judge awards the lot (usually provisionally) to the best bidder and sets the term for the balance. From then on the buyer is bound: withdrawing means losing the deposit.', fonte: { t: 'Award order (documents of the procedure)', u: PVP } },
        { h: '4 · Unsold auctions', p: 'If nobody bids, the judge orders a new attempt, usually at a price reduced by up to 25%. An unsold auction is not a closed one: the lot returns, often on better terms — and those who were following it know first.', fonte: { t: 'PVP — auction outcomes (unsold and next attempt)', u: PVP } },
        { h: '5 · Checks before paying', p: 'Before the balance, check procedure costs, taxes, condominium arrears and the condition of the property. The full economic picture is built here, not after the transfer decree.', fonte: { t: 'Sale notice and valuation report — costs and charges', u: PVP } },
      ],
    },
  },
  {
    slug: 'pagamento',
    it: {
      titolo: 'Pagare l\'asta: saldo, imposte e spese (e cosa succede se non paghi)',
      descrizione: 'Il pagamento dopo l\'aggiudicazione: saldo del prezzo, imposte di registro (2% o 9%), spese di procedura e condominiali, termini e decadenza.',
      lead: 'Il prezzo dell\'asta non è solo l\'offerta. Tra saldo, imposte e spese, il costo finale può cambiare di parecchie migliaia di euro: va calcolato prima di offrire, non dopo.',
      sezioni: [
        { h: '1 · Il saldo del prezzo', p: 'Il saldo si versa entro il termine fissato dal giudice nel provvedimento di aggiudicazione (spesso 60-120 giorni). Le modalità (bonifico, assegno, deposito) sono quelle indicate dal provvedimento e dal delegato.', fonte: { t: 'Provvedimento di aggiudicazione — termine e modalità del saldo', u: PVP } },
        { h: '2 · Le imposte di acquisto', p: 'Sull\'acquisto in asta si pagano le imposte di registro e ipotecarie come in una compravendita: di regola il 2% del prezzo per la prima casa (con i requisiti di legge) e il 9% per le altre, oltre alle imposte fisse e all\'IVA quando dovuta. Le aliquote vanno verificate sul caso concreto con un professionista.', fonte: { t: 'Agenzia delle Entrate — imposte sugli acquisti immobiliari', u: 'https://www.agenziaentrate.gov.it' } },
        { h: '3 · Le spese della procedura', p: 'Alle imposte si aggiungono le spese di procedura (custodia, pubblicità, compensi del delegato e del CTU) e le spese condominiali arretrate, che nella vendita giudiziaria seguono regole proprie. Vanno lette negli atti prima del saldo.', fonte: { t: 'Avviso di vendita e perizia — oneri e spese', u: PVP } },
        { h: '4 · Se il saldo non arriva', p: 'Il mancato pagamento nei termini comporta la decadenza dall\'aggiudicazione e la perdita della cauzione, oltre al nuovo tentativo di vendita. È il rischio più costoso e il più evitabile: si calcola prima di offrire.', fonte: { t: 'Provvedimento del giudice — decadenza e nuovo tentativo', u: PVP } },
        { h: '5 · Il conto completo, prima dell\'offerta', p: 'Prezzo + imposte + spese di procedura + arretrati condominiali + lavori + onorari: è il costo chiavi in mano. Solo quel numero si confronta con il valore di mercato OMI, non il prezzo base.', fonte: { t: 'Prezzo Chiavi in Mano — il costo reale (CAReAuctions)', u: 'https://careauctions.co/stima-costi' } },
      ],
    },
    en: {
      titolo: 'Paying for the auction: balance, taxes and costs (and what happens if you don\'t)',
      descrizione: 'Payment after the award: balance of the price, registration taxes (2% or 9%), procedure and condominium costs, deadlines and forfeiture.',
      lead: 'The auction price is not only your bid. Balance, taxes and costs can add several thousand euros: calculate them before bidding, not after.',
      sezioni: [
        { h: '1 · The balance', p: 'The balance is paid within the term set in the award order (often 60-120 days), by the means the order and the delegate prescribe.', fonte: { t: 'Award order — term and method of payment', u: PVP } },
        { h: '2 · Purchase taxes', p: 'Auction purchases pay registration and mortgage taxes as any sale: normally 2% of the price for a first home (where the legal requirements are met) and 9% otherwise, plus fixed duties and VAT where due. Rates must be checked on the actual case with a professional.', fonte: { t: 'Italian Revenue Agency — taxes on property purchases', u: 'https://www.agenziaentrate.gov.it' } },
        { h: '3 · Procedure costs', p: 'On top of taxes: procedure costs (custody, advertising, delegate and expert fees) and condominium arrears, which follow specific rules in judicial sales. Read them in the documents before paying.', fonte: { t: 'Sale notice and valuation report — charges and costs', u: PVP } },
        { h: '4 · If the balance does not arrive', p: 'Missing the term means forfeiture of the award and loss of the deposit, plus a new sale attempt. It is the most expensive and most avoidable risk: calculate it before bidding.', fonte: { t: 'Court order — forfeiture and new attempt', u: PVP } },
        { h: '5 · The full sum, before bidding', p: 'Price + taxes + procedure costs + condominium arrears + works + fees: that is the turnkey cost. Only that figure is compared with the OMI market value, never the starting price alone.', fonte: { t: 'Turnkey Price — the real cost (CAReAuctions)', u: 'https://careauctions.co/stima-costi' } },
      ],
    },
  },
  {
    slug: 'decreto-trasferimento',
    it: {
      titolo: 'Il decreto di trasferimento: la proprietà passa davvero',
      descrizione: 'Il decreto di trasferimento nell\'asta giudiziaria: quando arriva, cosa contiene, la trascrizione, le spese e la consegna dell\'immobile.',
      lead: 'Il decreto di trasferimento è l\'atto che ti rende proprietario: fino a quel momento hai un diritto, non una casa. Sapere come funziona evita sorprese su tempi e consegna.',
      sezioni: [
        { h: '1 · Quando arriva', p: 'Pagato il saldo, il giudice emette il decreto di trasferimento: è il provvedimento che trasferisce la proprietà all\'aggiudicatario e ordina la cancellazione dei vincoli. I tempi dipendono dal tribunale e dal carico della procedura.', fonte: { t: 'PVP — stato della procedura dopo il saldo', u: PVP } },
        { h: '2 · Cosa contiene', p: 'Identificazione dell\'immobile, aggiudicatario, prezzo, provenienza, stato di occupazione e ordini di cancellazione delle formalità pregiudizievoli (ipoteche, pignoramenti). Va letto riga per riga: è il titolo che porterai al notaio e alla banca.', fonte: { t: 'Decreto di trasferimento (atti della procedura)', u: PVP } },
        { h: '3 · La trascrizione', p: 'Il decreto si trascrive nei registri immobiliari: da lì la proprietà è opponibile ai terzi. La trascrizione è curata dal delegato o dall\'acquirente secondo il provvedimento; senza trascrizione la posizione resta fragile.', fonte: { t: 'Conservatoria dei registri immobiliari — trascrizione', u: 'https://www.agenziaentrate.gov.it' } },
        { h: '4 · La consegna dell\'immobile', p: 'Il decreto dispone anche la consegna: se l\'immobile è libero si consegnano le chiavi; se è occupato si procede secondo le regole del provvedimento (immissione in possesso, con l\'ufficiale giudiziario quando serve).', fonte: { t: 'Decreto — disposizioni sulla consegna', u: PVP } },
        { h: '5 · Le spese del passaggio', p: 'Imposte di registro e ipotecarie, onorari del delegato, spese di trascrizione e di cancellazione: sono voci che si pagano qui. Chi ha fatto il conto completo prima dell\'offerta le ha già messe nel prezzo.', fonte: { t: 'Agenzia delle Entrate — imposte e formalità', u: 'https://www.agenziaentrate.gov.it' } },
      ],
    },
    en: {
      titolo: 'The transfer decree: when ownership actually changes hands',
      descrizione: 'The transfer decree in an Italian judicial auction: when it arrives, what it contains, registration, costs and delivery of the property.',
      lead: 'The transfer decree is what makes you the owner: until then you hold a right, not a house. Knowing how it works avoids surprises on timing and delivery.',
      sezioni: [
        { h: '1 · When it arrives', p: 'Once the balance is paid, the judge issues the transfer decree: it transfers ownership to the buyer and orders the release of encumbrances. Timing depends on the court and its workload.', fonte: { t: 'PVP — status of the procedure after payment', u: PVP } },
        { h: '2 · What it contains', p: 'Identification of the property, the buyer, the price, the chain of title, the occupation status and the orders cancelling prior charges (mortgages, seizures). Read it line by line: it is the title you will take to the notary and the bank.', fonte: { t: 'Transfer decree (documents of the procedure)', u: PVP } },
        { h: '3 · Registration', p: 'The decree is registered in the land registers: from then ownership is enforceable against third parties. Registration is handled by the delegate or the buyer as the order provides; without it the position stays fragile.', fonte: { t: 'Land registry — registration of the decree', u: 'https://www.agenziaentrate.gov.it' } },
        { h: '4 · Delivery of the property', p: 'The decree also orders delivery: a vacant property is handed over with the keys; an occupied one follows the order\'s rules (taking possession, with the judicial officer where needed).', fonte: { t: 'Decree — delivery provisions', u: PVP } },
        { h: '5 · The costs of the transfer', p: 'Registration and mortgage taxes, delegate fees, registration and cancellation costs are paid here. Whoever built the full picture before bidding already put them in the price.', fonte: { t: 'Italian Revenue Agency — taxes and formalities', u: 'https://www.agenziaentrate.gov.it' } },
      ],
    },
  },
  {
    slug: 'occupazione-rilascio',
    it: {
      titolo: 'Immobile occupato: cosa significa, quanto costa e come si libera',
      descrizione: 'Occupazione e rilascio nell\'asta giudiziaria: libero o occupato, chi paga, immissione in possesso, tempi reali e impatto sul prezzo da offrire.',
      lead: 'Un immobile occupato può costare mesi e migliaia di euro. Non è un dettaglio della perizia: è la voce che cambia il prezzo che conviene offrire.',
      sezioni: [
        { h: '1 · Libero o occupato: dove si legge', p: 'Lo stato di occupazione è scritto nell\'avviso di vendita e nella perizia: libero, occupato dal debitore, occupato da terzi con un contratto (locazione, comodato). Il titolo dell\'occupante cambia tutto.', fonte: { t: 'Perizia e avviso di vendita — stato di occupazione', u: PVP } },
        { h: '2 · Cosa prevede il decreto', p: 'Il decreto di trasferimento dispone la consegna. Se l\'immobile è occupato senza titolo, si procede all\'immissione in possesso con l\'ufficiale giudiziario; se c\'è un contratto opponibile, i tempi si allungano fino alla sua scadenza.', fonte: { t: 'Decreto di trasferimento — disposizioni sulla consegna', u: PVP } },
        { h: '3 · Locazione opponibile', p: 'Una locazione registrata prima del pignoramento può essere opponibile all\'acquirente: si eredita il contratto e il canone, fino alla scadenza. È una situazione che va verificata nella perizia prima di offrire, non dopo.', fonte: { t: 'Perizia — contratti e provenienza', u: PVP } },
        { h: '4 · I costi veri del rilascio', p: 'Spese legali, ufficiale giudiziario, tempi di attesa, eventuale custodia e ripristino: sono costi certi con tempi incerti. Nel conto chiavi in mano vanno messi come voce a sé, con una stima prudente.', fonte: { t: 'Prezzo Chiavi in Mano — costi e tempi (CAReAuctions)', u: 'https://careauctions.co/stima-costi' } },
        { h: '5 · Come si offre su un occupato', p: 'Su un occupato si offre meno: il prezzo si abbassa del costo e del tempo del rilascio, non del valore dell\'immobile. Chi non fa questo conto paga l\'immobile al prezzo di uno libero e scopre il costo dopo.', fonte: { t: 'Metodo CAReAuctions — sconto reale vs valori OMI, con copertura', u: 'https://careauctions.co/sconto-reale-certificato' } },
      ],
    },
    en: {
      titolo: 'Occupied property: what it means, what it costs and how it is freed',
      descrizione: 'Occupation and delivery in Italian judicial auctions: vacant or occupied, who pays, taking possession, real timing and the impact on your bid.',
      lead: 'An occupied property can cost months and thousands of euros. It is not a detail of the report: it is the item that changes the price worth bidding.',
      sezioni: [
        { h: '1 · Vacant or occupied: where to read it', p: 'Occupation is stated in the sale notice and in the valuation report: vacant, occupied by the debtor, occupied by third parties under a contract (lease, loan for use). The occupier\'s title changes everything.', fonte: { t: 'Valuation report and sale notice — occupation status', u: PVP } },
        { h: '2 · What the decree provides', p: 'The transfer decree orders delivery. If the property is occupied without title, possession is taken with the judicial officer; if there is an enforceable lease, timing stretches to its expiry.', fonte: { t: 'Transfer decree — delivery provisions', u: PVP } },
        { h: '3 · Enforceable lease', p: 'A lease registered before the seizure may be enforceable against the buyer: you inherit the contract and the rent until expiry. This must be checked in the report before bidding, not after.', fonte: { t: 'Valuation report — contracts and chain of title', u: PVP } },
        { h: '4 · The real cost of freeing it', p: 'Legal fees, judicial officer, waiting time, possible custody and repairs: certain costs with uncertain timing. They belong in the turnkey calculation as a separate, prudently estimated item.', fonte: { t: 'Turnkey Price — costs and timing (CAReAuctions)', u: 'https://careauctions.co/stima-costi' } },
        { h: '5 · How to bid on an occupied property', p: 'You bid less: the price drops by the cost and time of freeing it, not by the value of the property. Whoever skips this calculation pays a vacant-property price and discovers the cost afterwards.', fonte: { t: 'CAReAuctions method — real discount vs OMI values, with coverage', u: 'https://careauctions.co/sconto-reale-certificato' } },
      ],
    },
  },
];

// ---- HTML -------------------------------------------------------------------
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function pagina(fase, lang) {
  const c = fase[lang];
  const altro = lang === 'it' ? 'en' : 'it';
  const hreflang = LINGUE.map(l => '<link rel="alternate" hreflang="' + l + '" href="https://careauctions.co/guide/' + l + '/' + fase.slug + '">').join('')
    + '<link rel="alternate" hreflang="x-default" href="https://careauctions.co/guide/it/' + fase.slug + '">';
  const sezioni = (c.sezioni || []).map(s =>
    '<h2>' + esc(s.h) + '</h2>\n<p>' + s.p + '</p>\n' + (s.fonte ? '<p class="fonte">' + (lang === 'it' ? 'Fonte' : 'Source') + ': <a href="' + s.fonte.u + '" rel="nofollow noopener" target="_blank">' + esc(s.fonte.t) + '</a></p>' : '')
  ).join('\n');
  const indice = FASI.filter(f => f.slug !== fase.slug).map(f =>
    '<li><a href="https://careauctions.co/guide/' + lang + '/' + f.slug + '">' + esc(f[lang].titolo.split(':')[0]) + '</a></li>'
  ).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.titolo)} | CAReAuctions</title>
<meta name="description" content="${esc(c.descrizione)}">
<link rel="canonical" href="https://careauctions.co/guide/${lang}/${fase.slug}">
${hreflang}
<meta property="og:title" content="${esc(c.titolo)}">
<meta property="og:description" content="${esc(c.descrizione)}">
<meta property="og:url" content="https://careauctions.co/guide/${lang}/${fase.slug}">
<meta property="og:image" content="https://careauctions.co/img/og-care.png">
<meta name="robots" content="index,follow">
<style>
body{margin:0;background:#FBF9F4;color:#0F1E3A;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;line-height:1.7}
.wrap{max-width:760px;margin:0 auto;padding:56px 24px}
.bar{height:2px;width:56px;background:#D4A84B;margin:0 0 26px}
h1{font-weight:300;font-size:36px;line-height:1.15;letter-spacing:-.01em;margin:0 0 18px}
h2{font-weight:400;font-size:22px;margin:34px 0 8px}
p{font-size:17px;color:#243149;margin:0 0 14px}
.lead{font-size:19px;color:#0F1E3A}
ul{font-size:17px;color:#243149;padding-left:20px;margin:0 0 16px}
li{margin:0 0 8px}
.fonte{font-size:12.5px;color:#6B7690;margin:-4px 0 22px}
.fonte a{color:#6B7690}
.box{border:1px solid #E3D9C0;border-radius:14px;padding:22px;margin:26px 0;background:#fff}
.mini{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#A2977E;font-weight:600;margin:0 0 8px}
.cta{display:inline-block;padding:12px 24px;border:1px solid #D4A84B;border-radius:999px;text-decoration:none;font-weight:600;margin:18px 10px 0 0;color:#0F1E3A;font-size:15px}
.foot{margin-top:44px;border-top:1px solid #E3D9C0;padding-top:16px;font-size:12px;color:#8A7F68;line-height:1.6}
a{color:#0F1E3A}
</style></head><body><div class="wrap">
<div class="bar"></div>
<p class="mini">CAReAuctions · ${lang === 'it' ? 'guida per fase' : 'guide by stage'} · ${lang === 'it' ? 'aggiornata al' : 'updated'} ${OGGI.split('-').reverse().join('/')}</p>
<h1>${esc(c.titolo)}</h1>
<p class="lead">${esc(c.lead)}</p>
${sezioni}
<div class="box">
<p class="mini">${lang === 'it' ? 'Le fonti ufficiali' : 'The official sources'}</p>
<p style="font-size:15px">${lang === 'it'
    ? 'Tutto quello che è scritto qui si controlla sulle fonti pubbliche: il <a href="https://pvp.giustizia.it" rel="nofollow noopener" target="_blank">Portale delle Vendite Pubbliche</a> del Ministero della Giustizia pubblica avvisi, perizie ed esiti di ogni procedura; <a href="' + GIUSTIZIA + '" rel="nofollow noopener" target="_blank">giustizia.it</a> spiega le vendite e le aste; il testo delle norme è su <a href="https://www.normattiva.it" rel="nofollow noopener" target="_blank">Normattiva</a>.'
    : 'Everything here can be checked on public sources: the Italian Ministry of Justice <a href="https://pvp.giustizia.it" rel="nofollow noopener" target="_blank">Public Sales Portal</a> publishes notices, valuation reports and outcomes of every procedure; <a href="' + GIUSTIZIA + '" rel="nofollow noopener" target="_blank">giustizia.it</a> explains sales and auctions; the law is on <a href="https://www.normattiva.it" rel="nofollow noopener" target="_blank">Normattiva</a>.'}</p>
<p style="font-size:15px">${lang === 'it'
    ? 'I numeri del mercato, con fonte e rilevazione: <a href="https://careauctions.co/sconto-reale-certificato">Sconto Reale Certificato</a> · <a href="https://careauctions.co/dati">iDati</a> · <a href="https://careauctions.co/esiti">esiti</a>.'
    : 'Market numbers, with source and survey date: <a href="https://careauctions.co/sconto-reale-certificato">Certified Real Discount</a> · <a href="https://careauctions.co/dati">the data</a> · <a href="https://careauctions.co/esiti">outcomes</a>.'}</p>
<a class="cta" href="https://careauctions.co/aste">${lang === 'it' ? 'Cerca le aste' : 'Search the auctions'}</a><a class="cta" href="https://careauctions.co/guide/${altro}/${fase.slug}" rel="alternate" hreflang="${altro}">${altro === 'it' ? 'Italiano' : 'English'}</a>
</div>
<div class="box">
<p class="mini">${lang === 'it' ? 'Le altre fasi dell\'asta' : 'The other stages'}</p>
<ul>${indice}</ul>
</div>
<div class="foot">CAReAuctions · careauctions.co · PUNTO LUCE S.R.L.S. · P.IVA e C.F. 04240850927 · REA CA-374424<br>
${lang === 'it' ? 'La guida è informativa e non sostituisce la consulenza di un professionista sul caso concreto: le regole della singola procedura sono quelle dell\'avviso di vendita.' : 'This guide is informative and does not replace professional advice on the actual case: the rules of each procedure are those of its sale notice.'}<br>
${lang === 'it' ? 'Fonte dei dati citati: PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia) e OMI — Agenzia delle Entrate · rilevazione' : 'Data sources: PVP — Ministry of Justice and OMI — Italian Revenue Agency · survey'} ${OGGI}</div>
</div></body></html>`;
}

// ---- giro -------------------------------------------------------------------
let scritti = 0;
const manifesto = [];
for (const fase of FASI) {
  for (const lang of LINGUE) {
    const rel = 'guide/' + lang + '/' + fase.slug + '.html';
    const html = pagina(fase, lang);
    fs.mkdirSync(path.join(RADICE, 'guide', lang), { recursive: true });
    fs.writeFileSync(path.join(RADICE, rel), html);
    scritti++;
    manifesto.push({
      lingua: lang,
      fase: fase.slug,
      url: 'https://careauctions.co/guide/' + lang + '/' + fase.slug,
      percorso: rel,
      titolo: fase[lang].titolo,
      descrizione: fase[lang].descrizione,
      aggiornato: OGGI,
      fonte: { nome: 'PVP — Portale delle Vendite Pubbliche (Ministero della Giustizia)', url: PVP }
    });
  }
}
// il manifesto esiste per una ragione sola: la sitemap dichiara SOLO pagine che esistono
const out = {
  generato: new Date().toISOString(),
  generatore: 'scripts/guide-fasi.js',
  regola: 'sitemap-guide.xml legge questo file: non si dichiara una pagina che non esiste.',
  fasi: FASI.map(f => ({ slug: f.slug, titoloIt: f.it.titolo, titoloEn: f.en.titolo })),
  pagine: manifesto,
  totale: manifesto.length
};
fs.mkdirSync(path.join(RADICE, 'feed'), { recursive: true });
fs.writeFileSync(path.join(RADICE, 'feed', 'guide-fasi.json'), JSON.stringify(out, null, 1));
console.log('[guide-fasi] ' + scritti + ' pagine scritte · manifesto con ' + manifesto.length + ' URL (' + LINGUE.join('+') + ', ' + FASI.length + ' fasi)');
