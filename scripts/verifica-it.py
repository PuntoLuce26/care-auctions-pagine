#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verifica-it — watcher cloud dei quattro indirizzi di careauctions.it.

Verifica che http/https su careauctions.it e www.careauctions.it arrivino davvero,
con al massimo 2 salti, su https://careauctions.co/<percorso>, e registra lo stato
in qa/verifica-it.json. Gira su GitHub Actions (nessun Mac acceso, nessun secret).

Esiti per indirizzo:
  ok                 = il target finale (max 2 salti) e' https://careauctions.co...
  tls-pending        = errore SSL/handshake, oppure timeout/connessione rifiutata su https
  redirect-parziale  = 301 verso https://<stesso host> ma https non raggiungibile
                       (e' lo stato "certificato non ancora emesso": conta come pending)
  anomalia           = 200/3xx verso host sbagliato, redirect loop, o qualunque altra cosa

Stato complessivo:
  ok        = tutti e quattro ok
  pending   = almeno un tls-pending/redirect-parziale e nessuna anomalia
  anomalia  = qualunque anomalia

Exit code: 0 per ok e pending (niente run rosse mentre il certificato non c'e'),
2 per anomalia (cosi' l'allarme e' vero).

"Commit solo al cambio di stato": lo script confronta lo stato del file gia' presente
(dal checkout) con il nuovo e pubblica l'output della Action "commit=true/false".
"""

import datetime
import json
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

INDIRIZZI = (
    "http://careauctions.it/",
    "https://careauctions.it/",
    "http://www.careauctions.it/",
    "https://www.careauctions.it/",
)
DESTINAZIONE = "careauctions.co"
USER_AGENT = "CARe-Watcher/1.0"
TIMEOUT = 12  # secondi per singola richiesta
MAX_SALTI = 2  # salti massimi ammessi verso la destinazione
PERCORSO_STATO = os.path.join("qa", "verifica-it.json")
CODICI_REDIRECT = (301, 302, 303, 307, 308)
# ${1}, $1, ${...} o {{...}}: un Location non risolto non si segue (si segnala anomalia).
PLACEHOLDER = re.compile(r"\$\{?\s*\d+\s*\}?|\$\{|\{\{")
CABECALARI = {"User-Agent": USER_AGENT, "Accept": "*/*"}


class SenzaRedirect(urllib.request.HTTPRedirectHandler):
    """Restituisce al chiamante la risposta 3xx invece di seguirla."""

    def http_error_301(self, req, fp, code, msg, headers):
        return fp

    def http_error_302(self, req, fp, code, msg, headers):
        return fp

    def http_error_303(self, req, fp, code, msg, headers):
        return fp

    def http_error_307(self, req, fp, code, msg, headers):
        return fp

    def http_error_308(self, req, fp, code, msg, headers):
        return fp


class TracciaRedirect(urllib.request.HTTPRedirectHandler):
    """Segue i redirect ma si ferma dopo max_salti e annota la catena."""

    def __init__(self, max_salti):
        super().__init__()
        self.max_salti = max_salti
        self.catena = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if len(self.catena) >= self.max_salti:
            raise urllib.error.HTTPError(
                newurl,
                code,
                "troppi redirect (max %d)" % self.max_salti,
                headers,
                fp,
            )
        self.catena.append((code, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER_STATICO = urllib.request.build_opener(SenzaRedirect())


def descrivi_errore(errore):
    """Riduce un errore di rete a (tipo, testo): tls / timeout / connessione / altro."""
    motivo = getattr(errore, "reason", errore)
    testo = str(motivo) or errore.__class__.__name__
    minuscolo = testo.lower()
    if isinstance(motivo, ssl.SSLError) or isinstance(errore, ssl.SSLError):
        return "tls", testo
    if isinstance(motivo, (socket.timeout, TimeoutError)) or "timed out" in minuscolo or "timeout" in minuscolo:
        return "timeout", testo
    if (
        isinstance(motivo, ConnectionRefusedError)
        or "refused" in minuscolo
        or "connection reset" in minuscolo
        or "connection aborted" in minuscolo
    ):
        return "connessione", testo
    if "ssl" in minuscolo or "handshake" in minuscolo or "certificate" in minuscolo or "tls" in minuscolo:
        return "tls", testo
    return "altro", testo


def richiesta_no_redirect(url):
    """Una richiesta senza seguire i redirect. Restituisce (status, location, errore)."""
    req = urllib.request.Request(url, headers=CABECALARI)
    try:
        with OPENER_STATICO.open(req, timeout=TIMEOUT) as risposta:
            return risposta.getcode(), risposta.headers.get("Location"), None
    except urllib.error.HTTPError as e:
        location = e.headers.get("Location") if e.headers else None
        return e.code, location, None
    except urllib.error.URLError as e:
        return None, None, descrivi_errore(e)
    except (ssl.SSLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        return None, None, descrivi_errore(e)


def https_raggiungibile(url):
    """True se TLS e risposta HTTP arrivano (anche un 3xx): il certificato c'e'."""
    _status, _location, errore = richiesta_no_redirect(url)
    if errore is not None:
        return False, errore
    return True, None


def segui_catena(url):
    """Segue al massimo MAX_SALTI redirect. Restituisce (finale, catena, errore)."""
    traccia = TracciaRedirect(MAX_SALTI)
    opener = urllib.request.build_opener(traccia)
    req = urllib.request.Request(url, headers=CABECALARI)
    try:
        with opener.open(req, timeout=TIMEOUT) as risposta:
            return risposta.geturl(), traccia.catena, None
    except urllib.error.HTTPError as e:
        ultimo = traccia.catena[-1][1] if traccia.catena else (e.url or url)
        if e.code in CODICI_REDIRECT:
            return ultimo, traccia.catena, ("redirect", "troppi redirect (max %d)" % MAX_SALTI)
        return (e.url or ultimo), traccia.catena, ("http", "HTTP %d" % e.code)
    except urllib.error.URLError as e:
        ultimo = traccia.catena[-1][1] if traccia.catena else url
        return ultimo, traccia.catena, descrivi_errore(e)
    except (ssl.SSLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        ultimo = traccia.catena[-1][1] if traccia.catena else url
        return ultimo, traccia.catena, descrivi_errore(e)


def destinazione(url):
    """True se l'URL e' https://careauctions.co (con qualunque percorso)."""
    if not url:
        return False
    parti = urllib.parse.urlsplit(url)
    return parti.scheme == "https" and (parti.hostname or "").lower() == DESTINAZIONE


def classifica(url):
    """Restituisce (esito, http, location, dettaglio) per un indirizzo."""
    parti_url = urllib.parse.urlsplit(url)
    host = (parti_url.hostname or "").lower()
    e_https = parti_url.scheme == "https"

    status, location, errore = richiesta_no_redirect(url)

    if errore is not None:
        tipo, testo = errore
        if e_https and tipo in ("tls", "timeout", "connessione"):
            return "tls-pending", status, location, "https non raggiungibile (%s): %s" % (tipo, testo)
        return "anomalia", status, location, "errore di rete (%s): %s" % (tipo, testo)

    if status is None:
        return "anomalia", None, location, "nessuna risposta HTTP"
    if 200 <= status < 300:
        return "anomalia", status, location, "risposta %d invece di un redirect" % status
    if status not in CODICI_REDIRECT:
        return "anomalia", status, location, "HTTP %d inatteso" % status
    if not location:
        return "anomalia", status, None, "redirect senza header Location"
    if PLACEHOLDER.search(str(location)):
        return "anomalia", status, str(location), "Location con placeholder non risolto: %s" % location

    assoluta = urllib.parse.urljoin(url, str(location).strip())
    parti_loc = urllib.parse.urlsplit(assoluta)
    host_loc = (parti_loc.hostname or "").lower()

    if destinazione(assoluta):
        return "ok", status, str(location), "redirect diretto a %s" % assoluta

    if parti_loc.scheme == "https" and host_loc == host:
        raggiungibile, errore_https = https_raggiungibile(assoluta)
        if not raggiungibile:
            return (
                "redirect-parziale",
                status,
                str(location),
                "https sullo stesso host non raggiungibile: %s" % errore_https[1],
            )

    finale, catena, errore_catena = segui_catena(url)
    salti = " -> ".join(str(salto) for salto, _url in catena) if catena else ""
    if destinazione(finale):
        return "ok", status, str(location), "catena %s verso %s" % (salti, finale)

    parti_finale = urllib.parse.urlsplit(finale)
    if (
        errore_catena is not None
        and errore_catena[0] in ("tls", "timeout", "connessione")
        and parti_finale.scheme == "https"
        and (parti_finale.hostname or "").lower() == host
    ):
        return (
            "redirect-parziale",
            status,
            str(location),
            "https sullo stesso host non raggiungibile: %s" % errore_catena[1],
        )
    if errore_catena is not None:
        return "anomalia", status, str(location), "catena interrotta: %s (%s)" % (errore_catena[1], finale)
    return (
        "anomalia",
        status,
        str(location),
        "catena finita su %s, non su %s" % (finale, DESTINAZIONE),
    )


def stato_complessivo(esiti):
    if all(esito == "ok" for esito in esiti):
        return "ok"
    if any(esito == "anomalia" for esito in esiti):
        return "anomalia"
    if any(esito in ("tls-pending", "redirect-parziale") for esito in esiti):
        return "pending"
    return "anomalia"


def nota_finale(stato, risultati):
    pending = [r["url"] for r in risultati if r["esito"] in ("tls-pending", "redirect-parziale")]
    anomalie = [r["url"] for r in risultati if r["esito"] == "anomalia"]
    if stato == "ok":
        return "Tutti e 4 gli indirizzi arrivano su https://careauctions.co (max 2 salti)."
    if stato == "pending":
        return "In attesa: %d/4 indirizzi non ancora su https://careauctions.co (%s)." % (
            len(pending),
            ", ".join(pending),
        )
    return "Anomalia su: %s." % ", ".join(anomalie)


def stato_precedente():
    """Stato del file gia' presente nel checkout (None se non c'e' o non si legge)."""
    try:
        with open(PERCORSO_STATO, "r", encoding="utf-8") as file_stato:
            dati = json.load(file_stato)
        return dati.get("stato") if isinstance(dati, dict) else None
    except (OSError, ValueError):
        return None


def scrivi_stato(dati):
    cartella = os.path.dirname(PERCORSO_STATO)
    if cartella:
        os.makedirs(cartella, exist_ok=True)
    temporaneo = PERCORSO_STATO + ".tmp"
    with open(temporaneo, "w", encoding="utf-8") as file_stato:
        json.dump(dati, file_stato, ensure_ascii=False, indent=2)
        file_stato.write("\n")
    os.replace(temporaneo, PERCORSO_STATO)


def stampa_tabella(dati):
    print("verifica-it | %s UTC | stato: %s" % (dati["generato"], dati["stato"]))
    print("%-31s %-5s %-36s %s" % ("indirizzo", "http", "location", "esito"))
    for riga in dati["indirizzi"]:
        print(
            "%-31s %-5s %-36s %s"
            % (
                riga["url"],
                riga["http"] if riga["http"] is not None else "-",
                (riga["location"] or "-")[:36],
                riga["esito"],
            )
        )


def pubblica_step_summary(dati):
    percorso = os.environ.get("GITHUB_STEP_SUMMARY")
    if not percorso:
        return
    righe = [
        "## verifica-it — stato: **%s**" % dati["stato"],
        "",
        "| Indirizzo | HTTP | Location | Esito |",
        "|---|---|---|---|",
    ]
    for riga in dati["indirizzi"]:
        righe.append(
            "| %s | %s | %s | %s |"
            % (
                riga["url"],
                riga["http"] if riga["http"] is not None else "-",
                riga["location"] or "-",
                riga["esito"],
            )
        )
    righe += ["", "Generato: %s UTC" % dati["generato"], "", "Note: %s" % dati["note"]]
    with open(percorso, "a", encoding="utf-8") as riepilogo:
        riepilogo.write("\n".join(righe) + "\n")


def pubblica_output(righe):
    percorso = os.environ.get("GITHUB_OUTPUT")
    if not percorso:
        for riga in righe:
            print("[output] %s" % riga)
        return
    with open(percorso, "a", encoding="utf-8") as output:
        for riga in righe:
            output.write(riga + "\n")


def main():
    risultati = []
    for url in INDIRIZZI:
        esito, status, location, dettaglio = classifica(url)
        risultati.append(
            {"url": url, "http": status, "location": location, "esito": esito, "_dettaglio": dettaglio}
        )
        print("%s -> %s (%s)" % (url, esito, dettaglio))

    stato = stato_complessivo([riga["esito"] for riga in risultati])
    generato = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    dati = {
        "generato": generato,
        "stato": stato,
        "indirizzi": [
            {chiave: riga[chiave] for chiave in ("url", "http", "location", "esito")} for riga in risultati
        ],
        "note": nota_finale(stato, risultati),
    }

    precedente = stato_precedente()
    cambiato = stato != precedente
    scrivi_stato(dati)
    stampa_tabella(dati)
    pubblica_step_summary(dati)
    pubblica_output(["stato=%s" % stato, "commit=%s" % ("true" if cambiato else "false")])
    print(
        "stato: %s | prima: %s | commit: %s"
        % (stato, precedente or "nessuno", "si" if cambiato else "no")
    )

    if stato == "anomalia":
        print("::error::verifica-it: anomalia nei redirect di careauctions.it")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
