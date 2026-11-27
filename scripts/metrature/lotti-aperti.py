#!/usr/bin/env python3
"""Elenca i lotti immobiliari con asta futura (trasporto, nessuna estrazione)."""
import json, sys, re, urllib.request, datetime
UA = "Mozilla/5.0 (compatible; CARe-mq/1.0; +https://careauctions.co)"

def get(u):
    r = urllib.request.Request(u, headers={'User-Agent': UA, 'Referer': 'https://careauctions.co/aste', 'Sec-Fetch-Site': 'same-origin'})
    return json.load(urllib.request.urlopen(r, timeout=60))

def main():
    quanti = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    oggi = datetime.date.today().isoformat()
    visti, lotti, off, giri = set(), [], 0, 0
    while len(lotti) < quanti and giri < 200:
        giri += 1
        try:
            d = get('https://careauctions.co/api/aste?limit=100&offset=%d' % off)
        except Exception:
            break
        aste = d.get('aste') or []
        if not aste:
            break
        for a in aste:
            if a['id'] in visti:
                continue
            visti.add(a['id'])
            if str(a.get('dataAsta') or '') < oggi:
                continue
            if re.search(r'Veicol|Autovettur|Macchin|Moto|Ciclomot|Imbarcaz|Aereo', str(a.get('titolo') or ''), re.I):
                continue
            lotti.append({'id': a['id'], 'titolo': a.get('titolo')})
            if len(lotti) >= quanti:
                break
        off += len(aste)
    json.dump(lotti, open(sys.argv[2], 'w'), ensure_ascii=False, indent=0)
    print('lotti', len(lotti), '| giri', giri)

if __name__ == '__main__':
    main()
