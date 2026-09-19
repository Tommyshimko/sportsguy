# Plain-language + succinctness report for a QA round. Usage: python3 qa/style.py qa/roundN.json
import json, re, sys
JARGON = ['bomb','dinger','skid','walk-off','walkoff','ballhawk','carousel','rating','seed','best-of','cutoff','points','under par','-under','clinch','wild card','wildcard','playoff line','shank','slash line','OPS','ERA','xG','plus-minus','pick-and-roll','D-line','front seven','revenge game','spoiler','mushy','cushy','rotation','bullpen','RBI']
RELATIVE = ['last night','tonight','tomorrow','yesterday','this morning']
d = json.load(open(sys.argv[1])); rows = []
for r in d:
    t = (r.get('take') or '').strip('"')
    if not t: rows.append((r, None)); continue
    words = len(t.split()); sents = len(re.findall(r'[.!?]+(\s|$)', t))
    nums = len(re.findall(r'\d[\d,.\-]*', t))
    flags = []
    if words > 30: flags.append(f'LONG({words}w)')
    if sents > 2: flags.append(f'{sents} sentences')
    if nums > 2: flags.append(f'{nums} numbers')
    if re.search(r'[—–;()]', t): flags.append('dash/semicolon')
    j = [w for w in JARGON if re.search(r'(?<![a-z])' + re.escape(w.lower()), t.lower())]
    if j: flags.append('jargon:' + ','.join(j))
    rel = [w for w in RELATIVE if w in t.lower()]
    if rel: flags.append('relative-day:' + ','.join(rel))
    if not r.get('evidence'): flags.append('NO EVIDENCE')
    rows.append((r, (words, flags)))
ok = [x for x in rows if x[1]]
for r, m in rows:
    print(f"\n[{r['sport']} / {r['location']}]  {'FAILED' if not m else str(m[0])+'w  ' + (' | '.join(m[1]) or 'clean')}")
    if m: print('  ' + r['take'])
    for line in (r.get('evidence') or '').split('\n')[:3]: print('     ev: ' + line.strip()[:210])
print(f"\n{len(ok)}/{len(rows)} produced | avg {sum(m[0] for _,m in ok)/max(1,len(ok)):.0f} words | clean style: {sum(1 for _,m in ok if not m[1])}/{len(ok)} | avg {sum(r['seconds'] for r,_ in rows)/len(rows):.1f}s | avg ${sum(r['cost'] for r,_ in rows)/len(rows):.3f}")
