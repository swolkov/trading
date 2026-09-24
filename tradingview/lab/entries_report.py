"""Entry-method report (Sep 24): reads out_<SYM>_entries.json written by `ict_lab.py <SYM> --entries`.

Prints per market and method: qualified setups (ENTRY READY), fills, no-return misses, fill rate and the
full stats; the share of ENTRY READY setups that never gave the second dip the current limit needs; and
what method B did on exactly those setups (the "is the second dip costing good trades" question).
"""
import json, sys
import numpy as np
sys.path.insert(0, '/Users/user/trading/tradingview/lab')
from ict_lab import summarize

LAB = '/Users/user/trading/tradingview/lab/'
A, B, C = 'EN-A limit at zone (current)', 'EN-B market next open', 'EN-C stop above retest high'

def fmt(s):
    if not s or not s.get('n'):
        return 'n=0'
    f = lambda x, p='+.3f': 'n/a' if x is None else format(x, p)
    return (f"n={s['n']:4d} win={s['win']*100:5.1f}% expR={f(s['expR'])} (t {f(s['t'], '+.2f')}) avgW={f(s['avgWin'])} "
            f"avgL={f(s['avgLoss'])} PF={f(s['pf'], '.2f')} DD={s['maxDDR']:.1f}R/${s['maxDDUSD']:,.0f} "
            f"streak={s['loseStreak']} net=${s['netUSD']:,.0f}")

for sym in sys.argv[1:] or ['ES', 'NQ', 'GC']:
    o = json.load(open(f'{LAB}out_{sym}_entries.json'))
    V = o['variants']
    print(f"\n══ {o['symbol']} ══")
    for v in (A, B, C):
        r = V[v]; k = r['counts']; ready = k['entryReady']
        print(f"{v:30s} ENTRY READY {ready:4d} · filled {k['pendFilled']:4d} ({k['pendFilled']/max(ready,1)*100:4.1f}%) · "
              f"never came back/never triggered {k['pendNoReturn']:4d} · invalidated while pending {k['pendInvalid']:3d} · "
              f"blocked {k['pendBlocked']} · no room {k['noRoom']}")
        print(f"   all      {fmt(r['all'])}")
        print(f"   2011–18  {fmt(r['h2011_18'])}")
        print(f"   2019–26  {fmt(r['h2019_26'])}")
    a = V[A]; ka = a['counts']
    print(f"KEY: of {ka['entryReady']} ENTRY READY (A), {ka['pendNoReturn']} ({ka['pendNoReturn']/max(ka['entryReady'],1)*100:.1f}%) never gave the second dip "
          f"(limit cancelled after {3} bars or price ran 0.5R away unfilled).")
    missed = set(a['noReturnIds'])
    bOnMissed = [t for t in V[B]['trades'] if t[5] in missed]
    cOnMissed = [t for t in V[C]['trades'] if t[5] in missed]
    filledA = {t[5] for t in a['trades']}
    bOnFilled = [t for t in V[B]['trades'] if t[5] in filledA]
    to = lambda ts: [(t[0], t[1], t[2], t[3], t[4]) for t in ts]
    print(f"   B on the setups A MISSED (no second dip): {fmt(summarize(to(bOnMissed)))}")
    print(f"   C on the setups A MISSED (no second dip): {fmt(summarize(to(cOnMissed)))}")
    print(f"   B on the setups A FILLED:                 {fmt(summarize(to(bOnFilled)))}")
