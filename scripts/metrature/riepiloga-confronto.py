#!/usr/bin/env python3
import json, sys, random, collections
righe = [json.loads(l) for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
c = collections.Counter(r.get('stato') for r in righe)
ok = [r for r in righe if r.get('stato') == 'concorde']
random.seed(20261127)
campione = random.sample(righe, min(50, len(righe)))
def voce(r):
    return {'id': r['id'], 'titolo': r.get('titolo'), 'mq_mio': r.get('mq_mio'), 'mq_claude': r.get('mq_claude'),
            'stato': r.get('stato'), 'affidabilita': r.get('affidabilita'), 'prova': r.get('prova'),
            'mq_catastali_claude': r.get('mq_catastali_claude'), 'perizia': r.get('perizia')}
json.dump([voce(r) for r in campione], open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print(json.dumps({'totali': len(righe), 'concordi': c.get('concorde', 0), 'discordi': c.get('discorde', 0),
                  'serve_ocr': c.get('serve-ocr', 0), 'uno_solo': c.get('uno-solo', 0), 'nessuno': c.get('nessuno', 0),
                  'senza_perizia': c.get('senza-perizia', 0), 'errori': c.get('errore', 0)}, ensure_ascii=False))
