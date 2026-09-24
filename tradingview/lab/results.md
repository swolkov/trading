# ICT Setups — 15-year lab results (final, Sep 24 2026: Fable-review fixes + tick-rounded stops)

Databento front-month 1m, panama back-adjusted, 2011 → mid-2026. 1 micro. Net of per-instrument fees, 1-tick stop slippage, limit fills need a 1-tick trade-through, same-minute stop+target = stop, gap-through stops fill at the open.


## Ablation (TP1 exit)


### MES (rule-order checks: 109,100, violations: 0)

| Variant | Trades | Win % | Exp R (t) | PF | Net $ | 2011–18 | 2019–26 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A iFVG only | 17129 | 51 | -0.162 (-22.0) | 0.69 | -57,537 | -0.224 | -0.126 |
| B + sweep | 4884 | 50 | -0.179 (-13.5) | 0.66 | -23,382 | -0.238 | -0.145 |
| C + displacement | 2176 | 53 | -0.136 (-7.2) | 0.72 | -8,610 | -0.189 | -0.102 |
| D + MSS | 1064 | 51 | -0.154 (-5.9) | 0.68 | -6,064 | -0.177 | -0.140 |
| E + HTF bias | 611 | 51 | -0.159 (-4.5) | 0.68 | -4,436 | -0.170 | -0.153 |
| F + session (1m OFF) | 150 | 56 | -0.102 (-1.6) | 0.76 | -1,474 | -0.066 | -0.124 |
| G + 1m confirmation (1m ON) | 0 | | | | | | |

### MNQ (rule-order checks: 116,897, violations: 0)

| Variant | Trades | Win % | Exp R (t) | PF | Net $ | 2011–18 | 2019–26 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A iFVG only | 18984 | 51 | -0.110 (-15.9) | 0.78 | -46,282 | -0.211 | -0.045 |
| B + sweep | 5421 | 52 | -0.101 (-7.8) | 0.79 | -9,262 | -0.217 | -0.021 |
| C + displacement | 2336 | 52 | -0.135 (-6.9) | 0.72 | -7,664 | -0.258 | -0.035 |
| D + MSS | 1141 | 55 | -0.073 (-2.8) | 0.84 | -2,184 | -0.199 | +0.020 |
| E + HTF bias | 672 | 53 | -0.098 (-2.8) | 0.79 | -1,601 | -0.240 | +0.001 |
| F + session (1m OFF) | 164 | 48 | -0.203 (-3.3) | 0.57 | -3,279 | -0.202 | -0.204 |
| G + 1m confirmation (1m ON) | 5 | 40 | -0.506 (-1.5) | 0.20 | -344 | -0.265 | -0.666 |

### MGC (rule-order checks: 147,018, violations: 0)

| Variant | Trades | Win % | Exp R (t) | PF | Net $ | 2011–18 | 2019–26 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A iFVG only | 23143 | 50 | -0.130 (-21.8) | 0.73 | -78,457 | -0.153 | -0.106 |
| B + sweep | 6929 | 51 | -0.123 (-11.5) | 0.74 | -25,130 | -0.137 | -0.107 |
| C + displacement | 2983 | 53 | -0.093 (-5.9) | 0.79 | -8,171 | -0.089 | -0.097 |
| D + MSS | 1382 | 54 | -0.072 (-3.1) | 0.83 | -2,152 | -0.087 | -0.058 |
| E + HTF bias | 826 | 51 | -0.116 (-3.8) | 0.75 | -2,840 | -0.161 | -0.069 |
| F + session (1m OFF) | 63 | 49 | -0.083 (-1.0) | 0.75 | 379 | -0.136 | -0.032 |
| G + 1m confirmation (1m ON) | 2 | 50 | -0.479 (-0.9) | 0.06 | -161 | +0.060 | -1.018 |

## Pre-declared exit test (full rule, 1M OFF)


### MES (no TP2 → TP1 on 5 trades; no TP3 → TP2 on 13)

| Exit | Trades | Win % | Net $ | Exp R | Δ vs TP1 | Median R | Avg win | Avg loss | PF | Max DD R / $ | Lose streak | 2011–18 | 2019–26 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| X-A TP1 (baseline) | 150 | 56 | -1,474 | -0.102 (t -1.6) | +0.000 | +0.44 | +0.58 | -0.97 | 0.76 | 16.9 / $1,996 | 5 | -0.066 | -0.124 |
| X-B all at TP2 | 150 | 43 | -3,045 | -0.178 (t -2.3) | -0.076 | -0.62 | +0.85 | -0.94 | 0.67 | 25.7 / $3,197 | 11 | -0.122 | -0.212 |
| X-C thirds | 150 | 43 | -2,349 | -0.137 (t -1.9) | -0.036 | -0.44 | +0.78 | -0.84 | 0.71 | 19.9 / $2,486 | 10 | -0.084 | -0.170 |

### MNQ (no TP2 → TP1 on 10 trades; no TP3 → TP2 on 16)

| Exit | Trades | Win % | Net $ | Exp R | Δ vs TP1 | Median R | Avg win | Avg loss | PF | Max DD R / $ | Lose streak | 2011–18 | 2019–26 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| X-A TP1 (baseline) | 164 | 48 | -3,279 | -0.203 (t -3.3) | +0.000 | -0.14 | +0.57 | -0.90 | 0.57 | 34.1 / $3,760 | 7 | -0.202 | -0.204 |
| X-B all at TP2 | 163 | 39 | -3,561 | -0.193 (t -2.6) | +0.009 | -0.74 | +0.88 | -0.88 | 0.64 | 34.0 / $4,509 | 8 | -0.184 | -0.201 |
| X-C thirds | 163 | 40 | -3,181 | -0.186 (t -2.7) | +0.016 | -0.41 | +0.78 | -0.84 | 0.63 | 32.7 / $4,070 | 7 | -0.175 | -0.196 |

### MGC (no TP2 → TP1 on 0 trades; no TP3 → TP2 on 1)

| Exit | Trades | Win % | Net $ | Exp R | Δ vs TP1 | Median R | Avg win | Avg loss | PF | Max DD R / $ | Lose streak | 2011–18 | 2019–26 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| X-A TP1 (baseline) | 63 | 49 | 379 | -0.083 (t -1.0) | +0.000 | -0.00 | +0.50 | -0.65 | 0.75 | 7.4 / $493 | 5 | -0.136 | -0.032 |
| X-B all at TP2 | 63 | 46 | 860 | -0.034 (t -0.3) | +0.049 | -0.11 | +0.66 | -0.63 | 0.90 | 6.6 / $465 | 5 | -0.072 | +0.003 |
| X-C thirds | 63 | 48 | 815 | -0.024 (t -0.2) | +0.060 | -0.08 | +0.65 | -0.63 | 0.93 | 6.6 / $465 | 5 | -0.039 | -0.009 |

## Pre-declared ENTRY test (Sep 24) — same setups/stop/TP1/session/costs, only the entry order differs
Run: `python3 ict_lab.py <SYM> --entries` then `python3 entries_report.py`. EN-A reproduces the baseline exactly.
```

══ MES ══
EN-A limit at zone (current)   ENTRY READY  178 · filled  150 (84.3%) · never came back/never triggered   28 · invalidated while pending   0 · blocked 0 · no room 0
   all      n= 150 win= 56.0% expR=-0.102 (t -1.56) avgW=+0.578 avgL=-0.966 PF=0.76 DD=16.9R/$1,996 streak=5 net=$-1,474
   2011–18  n=  57 win= 59.6% expR=-0.066 (t -0.62) avgW=+0.562 avgL=-0.993 PF=0.84 DD=3.2R/$209 streak=3 net=$-134
   2019–26  n=  93 win= 53.8% expR=-0.124 (t -1.48) avgW=+0.588 avgL=-0.952 PF=0.72 DD=16.9R/$1,996 streak=5 net=$-1,340
EN-B market next open          ENTRY READY  178 · filled  178 (100.0%) · never came back/never triggered    0 · invalidated while pending   0 · blocked 0 · no room 0
   all      n= 178 win= 59.0% expR=-0.126 (t -2.30) avgW=+0.440 avgL=-0.941 PF=0.67 DD=21.7R/$2,155 streak=4 net=$-2,082
   2011–18  n=  70 win= 60.0% expR=-0.099 (t -1.14) avgW=+0.433 avgL=-0.895 PF=0.72 DD=5.8R/$249 streak=3 net=$-274
   2019–26  n= 108 win= 58.3% expR=-0.144 (t -2.02) avgW=+0.445 avgL=-0.969 PF=0.64 DD=17.8R/$2,150 streak=4 net=$-1,808
EN-C stop above retest high    ENTRY READY  178 · filled   91 (51.1%) · never came back/never triggered   23 · invalidated while pending  62 · blocked 0 · no room 2
   all      n=  91 win= 71.4% expR=-0.040 (t -0.73) avgW=+0.243 avgL=-0.749 PF=0.81 DD=6.9R/$487 streak=3 net=$18
   2011–18  n=  36 win= 61.1% expR=-0.102 (t -1.16) avgW=+0.224 avgL=-0.615 PF=0.57 DD=4.9R/$189 streak=3 net=$-115
   2019–26  n=  55 win= 78.2% expR=+0.000 (t +0.00) avgW=+0.253 avgL=-0.904 PF=1.00 DD=4.5R/$487 streak=2 net=$134
KEY: of 178 ENTRY READY (A), 28 (15.7%) never gave the second dip (limit cancelled after 3 bars or price ran 0.5R away unfilled).
   B on the setups A MISSED (no second dip): n=  28 win= 85.7% expR=+0.139 (t +1.95) avgW=+0.258 avgL=-0.577 PF=2.69 DD=1.1R/$98 streak=1 net=$332
   C on the setups A MISSED (no second dip): n=  24 win= 79.2% expR=+0.032 (t +0.42) avgW=+0.172 avgL=-0.498 PF=1.31 DD=1.5R/$107 streak=2 net=$148
   B on the setups A FILLED:                 n= 150 win= 54.0% expR=-0.176 (t -2.79) avgW=+0.494 avgL=-0.962 PF=0.60 DD=25.6R/$2,482 streak=5 net=$-2,414

══ MNQ ══
EN-A limit at zone (current)   ENTRY READY  206 · filled  164 (79.6%) · never came back/never triggered   42 · invalidated while pending   0 · blocked 0 · no room 0
   all      n= 164 win= 47.6% expR=-0.203 (t -3.32) avgW=+0.569 avgL=-0.903 PF=0.57 DD=34.1R/$3,760 streak=7 net=$-3,279
   2011–18  n=  74 win= 47.3% expR=-0.202 (t -2.17) avgW=+0.584 avgL=-0.906 PF=0.58 DD=16.0R/$525 streak=6 net=$-304
   2019–26  n=  90 win= 47.8% expR=-0.204 (t -2.51) avgW=+0.557 avgL=-0.900 PF=0.57 DD=20.3R/$3,465 streak=7 net=$-2,975
EN-B market next open          ENTRY READY  206 · filled  206 (100.0%) · never came back/never triggered    0 · invalidated while pending   0 · blocked 0 · no room 0
   all      n= 206 win= 53.9% expR=-0.174 (t -3.45) avgW=+0.440 avgL=-0.892 PF=0.58 DD=36.3R/$3,442 streak=5 net=$-3,056
   2011–18  n=  95 win= 50.5% expR=-0.206 (t -2.71) avgW=+0.457 avgL=-0.884 PF=0.53 DD=21.7R/$762 streak=4 net=$-415
   2019–26  n= 111 win= 56.8% expR=-0.147 (t -2.17) avgW=+0.427 avgL=-0.900 PF=0.62 DD=17.8R/$3,039 streak=5 net=$-2,641
EN-C stop above retest high    ENTRY READY  206 · filled  127 (61.7%) · never came back/never triggered   15 · invalidated while pending  61 · blocked 0 · no room 3
   all      n= 127 win= 60.6% expR=-0.131 (t -2.55) avgW=+0.271 avgL=-0.750 PF=0.56 DD=21.1R/$1,375 streak=6 net=$-281
   2011–18  n=  59 win= 49.2% expR=-0.258 (t -3.26) avgW=+0.259 avgL=-0.757 PF=0.33 DD=16.4R/$667 streak=6 net=$-489
   2019–26  n=  68 win= 70.6% expR=-0.021 (t -0.33) avgW=+0.278 avgL=-0.740 PF=0.90 DD=6.1R/$876 streak=4 net=$208
KEY: of 206 ENTRY READY (A), 42 (20.4%) never gave the second dip (limit cancelled after 3 bars or price ran 0.5R away unfilled).
   B on the setups A MISSED (no second dip): n=  42 win= 83.3% expR=+0.192 (t +2.57) avgW=+0.370 avgL=-0.701 PF=2.64 DD=3.3R/$103 streak=5 net=$1,691
   C on the setups A MISSED (no second dip): n=  42 win= 78.6% expR=+0.095 (t +1.42) avgW=+0.273 avgL=-0.557 PF=1.80 DD=3.3R/$145 streak=6 net=$1,310
   B on the setups A FILLED:                 n= 164 win= 46.3% expR=-0.268 (t -4.59) avgW=+0.473 avgL=-0.908 PF=0.45 DD=44.3R/$5,118 streak=7 net=$-4,747

══ MGC ══
EN-A limit at zone (current)   ENTRY READY   73 · filled   63 (86.3%) · never came back/never triggered   10 · invalidated while pending   0 · blocked 0 · no room 0
   all      n=  63 win= 49.2% expR=-0.083 (t -0.98) avgW=+0.504 avgL=-0.652 PF=0.75 DD=7.4R/$493 streak=5 net=$379
   2011–18  n=  31 win= 45.2% expR=-0.136 (t -1.09) avgW=+0.503 avgL=-0.663 PF=0.62 DD=4.3R/$270 streak=4 net=$-71
   2019–26  n=  32 win= 53.1% expR=-0.032 (t -0.27) avgW=+0.504 avgL=-0.640 PF=0.89 DD=4.7R/$483 streak=5 net=$450
EN-B market next open          ENTRY READY   73 · filled   72 (98.6%) · never came back/never triggered    0 · invalidated while pending   0 · blocked 1 · no room 0
   all      n=  72 win= 51.4% expR=-0.076 (t -0.90) avgW=+0.494 avgL=-0.678 PF=0.77 DD=7.2R/$653 streak=6 net=$388
   2011–18  n=  33 win= 45.5% expR=-0.155 (t -1.25) avgW=+0.499 avgL=-0.701 PF=0.59 DD=4.8R/$307 streak=6 net=$-140
   2019–26  n=  39 win= 56.4% expR=-0.008 (t -0.07) avgW=+0.491 avgL=-0.654 PF=0.97 DD=6.3R/$653 streak=6 net=$528
EN-C stop above retest high    ENTRY READY   73 · filled   38 (52.1%) · never came back/never triggered   17 · invalidated while pending  17 · blocked 0 · no room 1
   all      n=  38 win= 68.4% expR=+0.088 (t +0.90) avgW=+0.394 avgL=-0.573 PF=1.49 DD=3.3R/$381 streak=2 net=$536
   2011–18  n=  13 win= 69.2% expR=+0.158 (t +1.11) avgW=+0.418 avgL=-0.426 PF=2.21 DD=0.4R/$20 streak=2 net=$255
   2019–26  n=  25 win= 68.0% expR=+0.052 (t +0.39) avgW=+0.380 avgL=-0.647 PF=1.25 DD=3.3R/$381 streak=2 net=$280
KEY: of 73 ENTRY READY (A), 10 (13.7%) never gave the second dip (limit cancelled after 3 bars or price ran 0.5R away unfilled).
   B on the setups A MISSED (no second dip): n=   9 win= 88.9% expR=+0.339 (t +1.22) avgW=+0.513 avgL=-1.049 PF=3.91 DD=1.0R/$65 streak=1 net=$350
   C on the setups A MISSED (no second dip): n=   8 win= 75.0% expR=+0.291 (t +0.98) avgW=+0.562 avgL=-0.521 PF=3.24 DD=1.0R/$77 streak=1 net=$282
   B on the setups A FILLED:                 n=  63 win= 46.0% expR=-0.135 (t -1.57) avgW=+0.489 avgL=-0.667 PF=0.63 DD=9.9R/$730 streak=6 net=$37
```
