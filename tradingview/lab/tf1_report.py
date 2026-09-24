"""1-minute-chart report (Sep 24): out_<SYM>_tf1.json vs the 5-minute baseline (out_<SYM>_entries.json, EN-A)."""
import json
from entries_report import fmt
for sym in ('ES', 'NQ', 'GC'):
    o = json.load(open(f'out_{sym}_tf1.json')); r = next(iter(o['variants'].values())); k = r['counts']
    b = json.load(open(f'out_{sym}_entries.json'))['variants']['EN-A limit at zone (current)']
    print(f"\n══ {o['symbol']} ══  1M chart: ENTRY READY {k['entryReady']} · filled {k['pendFilled']} · no second dip {k['pendNoReturn']} · stop+target same minute (stop assumed) {k['ambUnres']}")
    print(f"  1M all      {fmt(r['all'])}")
    print(f"  1M 2011–18  {fmt(r['h2011_18'])}")
    print(f"  1M 2019–26  {fmt(r['h2019_26'])}")
    print(f"  5M all      {fmt(b['all'])}")
