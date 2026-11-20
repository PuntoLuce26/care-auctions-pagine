#!/usr/bin/env python3
"""
estrai_mq.py — metrature dei lotti PVP dalle PERIZIE (v1, Claude, 20/11/2026)

Regola di Gianluca (20/11/2026): i metri quadri si prendono dalla PERIZIA
(commerciale/convenzionale e calpestabile). L'avviso di vendita riporta di
solito la catastale: si usa solo come ripiego e solo se dice «commerciale».

Uso:
  python3 estrai_mq.py ids.txt risultati.jsonl         # un id lotto PVP per riga
Requisiti (Ubuntu / GitHub Actions):
  apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-ita
Fonte degli allegati: https://careauctions.co/api/pvp-documenti/<id>
  (campo allegati: t=PERIZ/AVEND/ORDIN/ALTRO, n=nome, u=url, s=byte)

Comportamento verso il PVP: 1 download alla volta, pausa tra le richieste,
nessun PDF conservato (si tiene solo il risultato), riprende da dove si era
fermato (salta gli id già presenti in risultati.jsonl).
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request
from collections import Counter

API = "https://careauctions.co/api/pvp-documenti/{}"
PAUSA_S = float(os.environ.get("PAUSA_S", "1.0"))   # gentilezza verso il PVP
MAX_MB = 40
OCR_SOGLIA_CARATTERI = 1500                         # sotto: PDF scansionato -> OCR
OCR_MAX_PAGINE = 25
UA = "CAReAuctions-metrature/1.0 (+https://careauctions.co)"

NUM = r'(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,4}(?:[.,]\d{1,2})?)'
U = r'(?:m²|m2\b|mq\.?|m\.q\.|metri\s*quadr\w*)'
F = re.I

PATS = {
    "commerciale": [
        ("tot", re.compile(r'totale\s+(?:della\s+)?superficie\s+(?:commerciale|convenzionale|ragguagliata|virtuale)[^0-9]{0,40}?' + NUM + r'\s*' + U, F)),
        ("tot", re.compile(r'superficie\s+(?:commerciale|convenzionale|ragguagliata)\s+(?:complessiva|totale)[^0-9]{0,40}?' + NUM + r'\s*' + U, F)),
        ("tot", re.compile(r'consistenza\s+commerciale\s+complessiva[^0-9]{0,60}?' + NUM + r'\s*' + U, F)),
        ("std", re.compile(r'superficie\s+(?:lorda\s+)?(?:commerciale|convenzionale|ragguagliata)[^0-9]{0,40}?' + NUM + r'\s*' + U, F)),
        ("std", re.compile(r'superficie\s+(?:lorda\s+)?(?:commerciale|convenzionale)[^0-9]{0,30}?' + U + r'\s*' + NUM, F)),
        ("std", re.compile(r'(?:sup\.|superficie)\s+comm(?:erciale|\.)[^0-9]{0,20}?' + NUM + r'\s*' + U, F)),
    ],
    "lorda": [
        ("std", re.compile(r'superficie\s+(?:esterna\s+)?lorda(?:\s*\(S\.?E\.?L\.?\))?[^0-9]{0,40}?' + NUM + r'\s*' + U, F)),
        ("std", re.compile(r'superficie\s+(?:esterna\s+)?lorda[^0-9]{0,30}?' + U + r'\s*' + NUM, F)),
    ],
    "utile": [
        ("std", re.compile(r'superficie\s+(?:interna\s+)?(?:netta\s+)?(?:utile|calpestabile|netta|abitabile)(?:\s+(?:netta|interna|lorda))?[^0-9]{0,40}?' + NUM + r'\s*' + U, F)),
        ("std", re.compile(r'superficie\s+(?:netta\s+)?(?:utile|calpestabile|netta)[^0-9]{0,30}?' + U + r'\s*' + NUM, F)),
    ],
    "catastale": [
        ("std", re.compile(r'superficie\s+catastale[^0-9]{0,40}?' + NUM + r'\s*' + U, F)),
        ("std", re.compile(r'superficie\s+catastale[^0-9]{0,40}?' + U + r'\s*' + NUM, F)),
    ],
}

def numero(s):
    if re.search(r'\d\.\d{3}(,|$)', s):
        s = s.replace('.', '')
    return float(s.replace(',', '.'))

def estrai(testo):
    t = re.sub(r'\s+', ' ', testo)
    out = {}
    for tipo, lista in PATS.items():
        vals = []
        for k, rx in lista:
            for m in rx.finditer(t):
                try:
                    v = numero(m.group(1))
                except ValueError:
                    continue
                if 10 <= v <= 5000:
                    vals.append((k, v))
        if not vals:
            continue
        tot = [v for k, v in vals if k == "tot"]
        if tot:
            v = tot[0]
        else:
            c = Counter(v for _, v in vals)
            v = sorted(c.items(), key=lambda x: (-x[1], -x[0]))[0][0]
        out[tipo] = {"v": v, "n": len(vals), "tot": bool(tot)}
    return out

def scegli(perizia, avviso):
    """Valore per le statistiche, secondo la regola di Gianluca."""
    if perizia.get("commerciale"):
        return perizia["commerciale"]["v"], "commerciale", "perizia"
    if perizia.get("lorda"):
        return perizia["lorda"]["v"], "lorda", "perizia"
    if avviso.get("commerciale"):
        return avviso["commerciale"]["v"], "commerciale", "avviso"
    if perizia.get("utile"):
        return perizia["utile"]["v"], "utile", "perizia"
    if perizia.get("catastale"):
        return perizia["catastale"]["v"], "catastale", "perizia"
    if avviso.get("catastale"):
        return avviso["catastale"]["v"], "catastale", "avviso"
    return None, None, None

def get(url, binario=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read() if binario else r.read().decode()

def testo_pdf(dati, max_pagine):
    with tempfile.TemporaryDirectory() as d:
        pdf = os.path.join(d, "f.pdf")
        open(pdf, "wb").write(dati)
        t = subprocess.run(["pdftotext", "-l", str(max_pagine), "-layout", pdf, "-"],
                           capture_output=True, text=True).stdout
        ocr = False
        if len(t.strip()) < OCR_SOGLIA_CARATTERI:
            ocr = True
            subprocess.run(["pdftoppm", "-r", "200", "-l", str(OCR_MAX_PAGINE), "-png", pdf, os.path.join(d, "p")],
                           capture_output=True)
            parti = []
            for f in sorted(x for x in os.listdir(d) if x.startswith("p") and x.endswith(".png")):
                parti.append(subprocess.run(["tesseract", os.path.join(d, f), "-", "-l", "ita"],
                                            capture_output=True, text=True).stdout)
            t = "\n".join(parti)
        return t, ocr

def trova_perizia(allegati):
    p = next((a for a in allegati if a.get("t") == "PERIZ"), None)
    if p:
        return p, "PERIZ"
    rx = re.compile(r'perizia|stima|ctu|c\.t\.u|relazione\s+tecnica|elaborato\s+peritale', re.I)
    no = re.compile(r'foto|planim|catast|visur', re.I)
    p = next((a for a in allegati if a.get("t") == "ALTRO" and rx.search(a.get("n", "")) and not no.search(a.get("n", ""))), None)
    return (p, "ALTRO") if p else (None, None)

def lotto(id_):
    r = {"id": id_, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    j = json.loads(get(API.format(id_)))
    allegati = j.get("allegati") or []
    p, src = trova_perizia(allegati)
    r["perizia_src"] = src
    per, avv = {}, {}
    if p and p.get("s", 0) < MAX_MB * 1e6:
        t, ocr = testo_pdf(get(p["u"], True), 80)
        r["perizia_ocr"] = ocr
        per = estrai(t)
        time.sleep(PAUSA_S)
    a = next((x for x in allegati if x.get("t") == "AVEND"), None)
    if a and a.get("s", 0) < MAX_MB * 1e6:
        t, _ = testo_pdf(get(a["u"], True), 25)
        avv = estrai(t)
        time.sleep(PAUSA_S)
    r["perizia"], r["avviso"] = per, avv
    v, tipo, fonte = scegli(per, avv)
    r.update({"mq_valore": v, "mq_tipo": tipo, "mq_fonte": fonte})
    # plausibilità minima per il residenziale; il controllo €/m² vs OMI lo fa la pipeline
    r["mq_da_rivedere"] = bool(v is not None and not (15 <= v <= 2000))
    return r

def main():
    ids_file, out_file = sys.argv[1], sys.argv[2]
    fatti = set()
    if os.path.exists(out_file):
        for riga in open(out_file):
            try:
                fatti.add(json.loads(riga)["id"])
            except Exception:
                pass
    ids = [int(x) for x in open(ids_file).read().split() if x.strip().isdigit()]
    with open(out_file, "a") as out:
        for i, id_ in enumerate(ids):
            if id_ in fatti:
                continue
            try:
                r = lotto(id_)
            except Exception as e:
                r = {"id": id_, "errore": str(e)[:200]}
            out.write(json.dumps(r, ensure_ascii=False) + "\n")
            out.flush()
            time.sleep(PAUSA_S)
            if i % 100 == 0:
                print(f"{i}/{len(ids)}", file=sys.stderr)

if __name__ == "__main__":
    main()
