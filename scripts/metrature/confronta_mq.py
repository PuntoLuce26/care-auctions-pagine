#!/usr/bin/env python3
"""Confronto dei due estrattori di mq commerciali sulla STESSA perizia.
Trasporto (Sam): scarica il PDF, estrae il testo con pdftotext, fa girare
  - estrai_mq.py (nostro, produzione)
  - mq_commerciali.py (di Claude, trasportato cosi' com'e': NON modificato)
e scrive una riga JSON per lotto. Nessun valore viene pubblicato."""
import os, sys, json, re, time, tempfile, importlib.util, subprocess, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
def carica(nome, path):
    spec = importlib.util.spec_from_file_location(nome, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
mio = carica('estrai_mq', os.path.join(BASE, 'estrai_mq.py'))
suo = carica('mq_commerciali', os.path.join(BASE, 'mq_commerciali.py'))
UA = "Mozilla/5.0 (compatible; CARe-mq/1.0; +https://careauctions.co)"

def scarica(url, dest, max_mb=30):
    if 'pvp.giustizia.it/allegati' in url and 'resource-pvp' not in url:
        url = url.replace('pvp.giustizia.it/allegati', 'resource-pvp.giustizia.it/allegati')
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/pdf,*/*'})
    with urllib.request.urlopen(req, timeout=90) as r, open(dest, 'wb') as f:
        tot = 0
        while True:
            b = r.read(65536)
            if not b: break
            tot += len(b)
            if tot > max_mb * 1024 * 1024: raise RuntimeError('pdf troppo grande')
            f.write(b)
    return tot

def testo_pdf(p):
    try:
        return subprocess.run(['pdftotext', '-layout', p, '-'], capture_output=True, text=True, timeout=180).stdout or ''
    except Exception as e:
        return ''

def confronta(txt):
    a = mio.estrai(txt); mine = (a.get('commerciale') or {}).get('v')
    b = suo.estrai(txt); cl = b.get('mq_commerciali'); aff = b.get('affidabilita')
    if len(txt) < 500 or aff == 'serve-ocr': stato = 'serve-ocr'
    elif mine is None and cl is None: stato = 'nessuno'
    elif mine is None or cl is None: stato = 'uno-solo'
    elif abs(float(mine) - float(cl)) < 0.01: stato = 'concorde'
    else: stato = 'discorde'
    return {'mq_mio': mine, 'mq_claude': cl, 'affidabilita': aff, 'stato': stato,
            'mq_catastali_claude': b.get('mq_catastali'), 'prova': b.get('prova'), 'candidati': b.get('candidati')}

def main():
    lista = json.load(open(sys.argv[1])); outpath = sys.argv[2]
    out = open(outpath, 'a', encoding='utf-8')
    for i, lot in enumerate(lista):
        lid = str(lot['id']); purl = lot.get('perizia')
        rec = {'id': lid, 'titolo': lot.get('titolo'), 'perizia': purl}
        if not purl:
            rec['stato'] = 'senza-perizia'
        else:
            tmp = os.path.join(tempfile.gettempdir(), 'mq_%s.pdf' % lid); t0 = time.time()
            try:
                n = scarica(purl, tmp); txt = testo_pdf(tmp)
                rec.update(confronta(txt)); rec['pdf_byte'] = n; rec['testo_caratteri'] = len(txt)
                rec['ms'] = int((time.time() - t0) * 1000)
            except Exception as e:
                rec['stato'] = 'errore'; rec['errore'] = str(e)
            finally:
                try: os.remove(tmp)
                except Exception: pass
        out.write(json.dumps(rec, ensure_ascii=False) + '\n'); out.flush()
        print(i + 1, len(lista), lid, rec.get('stato'), rec.get('mq_mio'), rec.get('mq_claude'), flush=True)

if __name__ == '__main__':
    main()
