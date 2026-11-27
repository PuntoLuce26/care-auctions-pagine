#!/usr/bin/env python3
"""Elenca i lotti immobiliari con asta futura e la loro perizia (trasporto, non estrazione)."""
import json, sys, re, urllib.request, datetime
UA = "Mozilla/5.0 (compatible; CARe-mq/1.0; +https://careauctions.co)"

def get(u):
    r = urllib.request.Request(u, headers={'User-Agent': UA, 'Referer': 'https://careauctions.co/aste', 'Sec-Fetch-Site': 'same-origin'})
    return json.load(urllib.request.urlopen(r, timeout=60))

def main():
    quanti = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    oggi = datetime.date.today().isoformat()
    visti, lotti, off = set(), [], 0
    while len(lotti) < quanti and off < 3000:
        try:
            d = get(f'https://careauctions.co/api/aste?limit=100&offset={off}')
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
            per = None
            for doc in (a.get('documenti') or []):
                nm = str(doc.get('nome', '')).lower()
                if 'periz' in nm or 'elaborato peritale' in nm:
                    per = doc.get('link'); break
            lotti.append({'id': a['id'], 'titolo': a.get('titolo'), 'perizia': per})
        off += len(aste)
    json.dump(lotti[:quanti], open(sys.argv[2], 'w'), ensure_ascii=False, indent=0)
    print('lotti', len(lotti[:quanti]), '| con perizia', sum(1 for x in lotti[:quanti] if x['perizia']))

if __name__ == '__main__':
    main()
