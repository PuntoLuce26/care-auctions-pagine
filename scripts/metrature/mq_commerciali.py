#!/usr/bin/env python3
"""Estrae dalla PERIZIA la superficie COMMERCIALE (mai la catastale).
Uso: mq_commerciali.py perizia.pdf [...]  -> una riga JSON per file.
Regole (Gianluca, 27/11/2026): le statistiche e iCARe usano il mq commerciale
della perizia; la superficie catastale va in un campo separato e non entra nei confronti.
Scritto da Claude; richiede pdftotext (poppler)."""
import sys, re, json, subprocess

NUM = r'(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)'
UNIT = r'(?:mq\.?|m\.?q\.?|m²|m2|metri\s+quadr[ia])'
def num(s):
    s = s.strip()
    if ',' in s: s = s.replace('.', '').replace(',', '.')
    elif re.fullmatch(r'\d{1,3}(\.\d{3})+', s): s = s.replace('.', '')
    try: return float(s)
    except ValueError: return None

COMM = re.compile(r'superfic\w*\s+(?:\w+\s+){0,3}?commercial\w*(?:\s+\w+){0,6}?\s*(?:di|pari\s+a|:|=|è)?\s*(?:circa\s+)?(?:' + UNIT + r'\s*' + NUM + r'|' + NUM + r'\s*' + UNIT + r')', re.I)
COMM2 = re.compile(r'(?:sup\.?|superfic\w*)\s+(?:lorda\s+)?commercial\w*[^\n]{0,60}?' + NUM + r'\s*' + UNIT, re.I)
CAT = re.compile(r'sup(?:erficie|\.)?\s+catastale(?:\s+totale)?\s*:?\s*(?:' + UNIT + r'\s*' + NUM + r'|' + NUM + r'\s*' + UNIT + r')', re.I)

def estrai(testo):
    t = re.sub(r'[ \t]+', ' ', testo.replace('“', '"').replace('”', '"'))
    flat = re.sub(r'\s*\n\s*', ' ', t)
    cand = []
    for rx in (COMM, COMM2):
        for m in rx.finditer(flat):
            v = next((num(g) for g in m.groups() if g), None)
            if v and 8 <= v <= 20000:
                cand.append((v, flat[max(0, m.start()-40):m.end()+20]))
    cat = [next((num(g) for g in m.groups() if g), None) for m in CAT.finditer(flat)]
    cat = [c for c in cat if c]
    out = {'mq_commerciali': None, 'fonte': 'perizia', 'affidabilita': 'nessuna',
           'mq_catastali': cat[0] if cat else None, 'candidati': sorted({c[0] for c in cand}), 'prova': None}
    if cand:
        vals = [c[0] for c in cand]
        best = max(set(vals), key=vals.count)
        out['mq_commerciali'] = best
        out['prova'] = next(c[1] for c in cand if c[0] == best)[:200]
        distinti = len(set(vals))
        out['affidabilita'] = 'alta' if distinti == 1 else ('media' if vals.count(best) >= 2 else 'da-rivedere')
        if out['mq_catastali'] and abs(best - out['mq_catastali']) < 0.01 and distinti > 1:
            out['affidabilita'] = 'da-rivedere'
    return out

def main():
    for p in sys.argv[1:]:
        try:
            txt = subprocess.run(['pdftotext', '-layout', p, '-'], capture_output=True, text=True, timeout=120).stdout
        except Exception as e:
            print(json.dumps({'file': p, 'errore': str(e)})); continue
        r = estrai(txt); r['file'] = p; r['testo_caratteri'] = len(txt)
        if len(txt) < 500: r['affidabilita'] = 'serve-ocr'
        print(json.dumps(r, ensure_ascii=False))
if __name__ == '__main__': main()
