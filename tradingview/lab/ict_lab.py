"""ICT Setups — 15-year lab. A line-by-line Python port of tradingview/ict-core.pine.

Every rule mirrors the Pine core (same thresholds, same order of operations inside a bar), so what
this measures is what the indicator/strategy trades. Variants A–G add one ingredient at a time
(ablation). Shorts use mirrored prices (p -> -p) exactly like the Pine core.

Run:  python3 tradingview/lab/ict_lab.py ES   (or NQ, GC)   → writes tradingview/lab/out_<SYM>.json
Data: data/idx15y/{ES,NQ}_1m.csv, data/gc15y/GC_1m.csv (Databento front-month 1m, 2011→2026),
      back-adjusted here at each contract change so rolls don't create fake gaps/sweeps.
"""
import math, sys, json, time as _time
import numpy as np, pandas as pd

# ───────────────────────────── inputs (Pine defaults) ─────────────────────────────
FVG_MIN_ATR = 0.20; MAX_AGE = 150; MAX_KEEP = 12; SWING_LEN = 5; HTF_LEN = 3; PROM_ATR = 1.0
EQ_TOL = 0.10; RECLAIM = 3; DISP_ATR = 1.3; DISP_BODY = 0.60; ILEN = 2; MSS_WIN = 12; IFVG_WIN = 12
READY_WIN = 24; STOP_BUF_ATR = 0.10; MIN_TGT_R = 0.5; COOLDOWN = 3; PEND_BARS = 3; CHASE_R = 0.5
PREC_BARS = 6; STOP_SLIP = 1; KEEP_BARS = 60

DATA = '/Users/user/trading/data/'
SPEC = {  # micro contract specs + measured fees per side (journal, Sep 2026)
    'ES': dict(name='MES', file=DATA + 'idx15y/ES_1m.csv', tick=0.25, pv=5.0, fee=1.08, fvg_ticks=2, rth=(570, 960), on=(1080, 570)),
    'NQ': dict(name='MNQ', file=DATA + 'idx15y/NQ_1m.csv', tick=0.25, pv=2.0, fee=1.03, fvg_ticks=4, rth=(570, 960), on=(1080, 570)),
    'GC': dict(name='MGC', file=DATA + 'gc15y/GC_1m.csv', tick=0.10, pv=10.0, fee=1.03, fvg_ticks=2, rth=(500, 810), on=(1080, 500)),
}

def in_sess(mod, s):
    a, b = s
    return (a <= mod < b) if a < b else (mod >= a or mod < b)

# ───────────────────────────── engine ─────────────────────────────
class Zone:
    __slots__ = ('bull', 'inv', 'top', 'bot', 'age', 'dead')
    def __init__(s, bull, top, bot):
        s.bull = bull; s.inv = False; s.top = top; s.bot = bot; s.age = 0; s.dead = False

class Engine:
    def __init__(s, tf, pLen, tick, fvg_ticks):
        s.tf = tf; s.pLen = pLen; s.tick = tick; s.fvgt = fvg_ticks
        s.o = []; s.h = []; s.l = []; s.c = []                     # index 0 = newest
        s.n = 0; s.atr = None; s.atrPrev = None; s.zones = []; s.lastIFVG = None
        s.lastPH = None; s.lastPL = None; s.promPH = 0.0; s.promPL = 0.0
        s.phBroken = True; s.plBroken = True; s.ipH = []; s.ipL = []; s.trend = 0
        s.lastDispDir = 0; s.lastDispN = -999; s.lastSweepDir = 0; s.lastSweepN = -999
        s.lastZoneDir = 0; s.lastZoneN = -999
        s.reset_ev()

    def reset_ev(s):
        s.evBullFVG = s.evBearFVG = s.evBullIFVG = s.evBearIFVG = False
        s.evPH = s.evPL = False; s.evDispUp = s.evDispDn = False

    def feed(s, o, h, l, c):
        s.reset_ev()
        s.o.insert(0, o); s.h.insert(0, h); s.l.insert(0, l); s.c.insert(0, c)
        if len(s.o) > KEEP_BARS:
            s.o.pop(); s.h.pop(); s.l.pop(); s.c.pop()
        s.n += 1
        s.atrPrev = s.atr
        body = abs(c - o)
        if s.atrPrev is not None and body >= DISP_ATR * s.atrPrev and body >= DISP_BODY * (h - l):
            s.evDispUp = c > o; s.evDispDn = c < o
            s.lastDispDir = 1 if c > o else -1; s.lastDispN = s.n
        tr = max(h - l, abs(h - s.c[1]), abs(l - s.c[1])) if len(s.c) > 1 else h - l
        if s.atr is None: s.atr = tr
        elif s.n <= 14: s.atr = (s.atr * (s.n - 1) + tr) / s.n
        else: s.atr = (s.atr * 13 + tr) / 14
        s.update_zones(); s.update_structure(); s.update_pivots(); s.update_internal()

    def update_zones(s):
        c0 = s.c[0]; h0 = s.h[0]; l0 = s.l[0]
        for i in range(len(s.zones) - 1, -1, -1):
            z = s.zones[i]
            z.age += 1
            kill = z.age > MAX_AGE
            if not kill:
                if not z.inv:
                    if z.bull and c0 < z.bot:
                        z.bull = False; z.inv = True; z.age = 0
                        s.evBearIFVG = True; s.lastIFVG = z; s.lastZoneDir = -1; s.lastZoneN = s.n
                    elif (not z.bull) and c0 > z.top:
                        z.bull = True; z.inv = True; z.age = 0
                        s.evBullIFVG = True; s.lastIFVG = z; s.lastZoneDir = 1; s.lastZoneN = s.n
                else:
                    kill = (z.bull and c0 < z.bot) or ((not z.bull) and c0 > z.top)
                if (not kill) and z.age > 0:
                    if z.bull and l0 <= z.top and c0 > z.top:
                        s.lastZoneDir = 1; s.lastZoneN = s.n
                    elif (not z.bull) and h0 >= z.bot and c0 < z.bot:
                        s.lastZoneDir = -1; s.lastZoneN = s.n
            if kill:
                z.dead = True; del s.zones[i]
        if len(s.h) >= 3:
            minGap = max(FVG_MIN_ATR * (s.atr or 0.0), s.fvgt * s.tick)
            if s.h[2] < s.l[0] and s.l[0] - s.h[2] >= minGap:
                s.zones.append(Zone(True, s.l[0], s.h[2])); s.evBullFVG = True
            elif s.l[2] > s.h[0] and s.l[2] - s.h[0] >= minGap:
                s.zones.append(Zone(False, s.l[2], s.h[0])); s.evBearFVG = True
        while len(s.zones) > MAX_KEEP:
            s.zones.pop(0)          # dropped from tracking — NOT a failure (Pine: zd.dropped)

    def pivot_at(s, k):
        if len(s.h) < 2 * k + 1:
            return False, False, None, None
        ph = s.h[k]; pl = s.l[k]; isH = True; isL = True; lo = pl; hi = ph
        for j in range(2 * k + 1):
            if j != k:
                isH = isH and (s.h[j] < ph if j < k else s.h[j] <= ph)
                isL = isL and (s.l[j] > pl if j < k else s.l[j] >= pl)
            lo = min(lo, s.l[j]); hi = max(hi, s.h[j])
        return isH, isL, lo, hi

    def update_structure(s):
        c0 = s.c[0]
        if s.lastPH is not None and not s.phBroken and s.h[0] > s.lastPH and c0 < s.lastPH:
            s.lastSweepDir = -1; s.lastSweepN = s.n
        if s.lastPL is not None and not s.plBroken and s.l[0] < s.lastPL and c0 > s.lastPL:
            s.lastSweepDir = 1; s.lastSweepN = s.n
        if s.lastPH is not None and not s.phBroken and c0 > s.lastPH:
            s.phBroken = True; s.trend = 1
        if s.lastPL is not None and not s.plBroken and c0 < s.lastPL:
            s.plBroken = True; s.trend = -1

    def update_pivots(s):
        k = s.pLen
        isH, isL, lo, hi = s.pivot_at(k)
        if isH:
            s.lastPH = s.h[k]; s.evPH = True; s.promPH = s.h[k] - lo; s.phBroken = False
        if isL:
            s.lastPL = s.l[k]; s.evPL = True; s.promPL = hi - s.l[k]; s.plBroken = False

    def update_internal(s):
        isH, isL, _, _ = s.pivot_at(ILEN)
        if isH:
            s.ipH.append(s.h[ILEN])
            if len(s.ipH) > 12: s.ipH.pop(0)
        if isL:
            s.ipL.append(s.l[ILEN])
            if len(s.ipL) > 12: s.ipL.pop(0)

    def bias(s):
        sc = s.trend * 2
        sc += s.lastSweepDir if s.n - s.lastSweepN <= 10 else 0
        sc += s.lastZoneDir if s.n - s.lastZoneN <= 10 else 0
        sc += s.lastDispDir if s.n - s.lastDispN <= 5 else 0
        if s.lastPH is not None and s.lastPL is not None and s.c:
            sc += 1 if s.c[0] > (s.lastPH + s.lastPL) / 2 else -1
        return sc

class Liq:
    __slots__ = ('px', 'hi', 'kind', 'w', 'nMade', 'done', 'nDone', 'nPierce', 'ext')
    def __init__(s, px, hi, kind, w, nMade):
        s.px = px; s.hi = hi; s.kind = kind; s.w = w; s.nMade = nMade
        s.done = False; s.nDone = 0; s.nPierce = -1; s.ext = None

# ───────────────────────────── setups ─────────────────────────────
VARIANTS = {
    # name: (needSweep, needDisp, needMss, htfContext, sessionWindow, precision1m)
    'A iFVG only':                 (False, False, False, False, False, False),
    'B + sweep':                   (True,  False, False, False, False, False),
    'C + displacement':            (True,  True,  False, False, False, False),
    'D + MSS':                     (True,  True,  True,  False, False, False),
    'E + HTF bias':                (True,  True,  True,  True,  False, False),
    'F + session (1m OFF)':        (True,  True,  True,  True,  True,  False),
    'G + 1m confirmation (1m ON)': (True,  True,  True,  True,  True,  True),
}
# Pre-declared exit experiment (Sep 23): identical F entries/stops/sessions/costs; ONLY the exit differs.
# Missing targets use the fallback already in the Pine core: TP2 missing → TP1; TP3 missing → TP2.
EXIT_VARIANTS = {
    'X-A TP1 (baseline)': ((True, True, True, True, True, False), 'TP1'),
    'X-B all at TP2':     ((True, True, True, True, True, False), 'TP2'),
    'X-C thirds':         ((True, True, True, True, True, False), 'THIRDS'),
}
if '--exits' in sys.argv:
    VARIANTS = {k: v[0] for k, v in EXIT_VARIANTS.items()}
    EXIT_OF = {k: v[1] for k, v in EXIT_VARIANTS.items()}
else:
    EXIT_OF = {k: 'TP1' for k in VARIANTS}

class Stats:
    def __init__(s):
        s.ready = s.missed = s.expired = s.invalid = s.noPrec = s.ambRes = s.ambUnres = s.precDone = s.entryReady = s.noTp2 = s.noTp3 = s.qaChecks = s.qaViol = 0
        s.trades = []

class Setup:
    def __init__(s, d, flags):
        s.d = d
        s.needSweep, s.needDisp, s.needMss, s.ctx, s.sess, s.prec = flags
        s.exitPlan = 'TP1'
        s.stage = 0; s.nEnd = -999; s.z = None; s.disp = False; s.pDone = False
        s.liqPx = None; s.ext = None; s.nSweep = 0; s.mssLvl = None; s.nMss = 0
        s.zTop = s.zBot = None; s.legExt = None; s.nReady = 0
        s.entry = s.stop = s.tp1 = s.tp2 = s.tp3 = s.entry0 = None
        s.nRetest = 0; s.tFrom1m = 0; s.nEntry = 0
        s.pStep = 0; s.pMss = None; s.pDisp = False; s.pMssOK = False; s.pTop = None; s.pZoneN = 0
        s.legTp = []; s.legOpen = []; s.rGross = 0.0; s.ptsGross = 0.0; s.fillT = 0; s.fillPx = None; s.riskPlan = None

    def reset(s, bi):
        if s.stage > 0:
            s.nEnd = bi
        s.stage = 0; s.z = None; s.disp = False; s.pDone = False

def actionable(S):
    return 3 <= S.stage <= 5

def hi_(d, h, l): return h if d == 1 else -l
def lo_(d, h, l): return l if d == 1 else -h

def tap(e, d, ext_, c_):
    for z in e.zones:
        if z.bull == (d == 1):
            t_ = z.top if d == 1 else -z.bot; b_ = z.bot if d == 1 else -z.top
            if ext_ <= t_ and c_ >= b_: return e.tf
    return ''

def run_setup(S, bi, h, l, c, swS, swB, eX, eA, eB, eC, b1, b4, inWin):
    d = S.d; h_ = hi_(d, h, l); l_ = lo_(d, h, l); c_ = d * c
    sw = swS if d == 1 else swB
    dispNow = eX.evDispUp if d == 1 else eX.evDispDn
    newInv = eX.evBullIFVG if d == 1 else eX.evBearIFVG
    def capture():
        if newInv and eX.lastIFVG is not None and not eX.lastIFVG.dead:
            zc = eX.lastIFVG
            zt = zc.top if d == 1 else -zc.bot; zb = zc.bot if d == 1 else -zc.top
            if zb > S.ext:
                S.z = zc; S.zTop = zt; S.zBot = zb
    if S.stage in (1, 2):
        extBefore = S.ext
        S.ext = min(S.ext, l_); S.legExt = max(S.legExt, h_)
        S.disp = S.disp or dispNow
        if not S.needMss:
            capture()          # ablation B/C have no MSS step: any post-sweep iFVG
        if S.needSweep and c_ < S.liqPx and S.stage == 1:
            S.reset(bi)
        elif c_ < extBefore:
            S.reset(bi)
        elif S.stage == 1 and S.needMss:
            if c_ > S.mssLvl:
                if S.disp: S.stage = 2; S.nMss = bi
                else: S.reset(bi)
            elif bi - S.nSweep > MSS_WIN:
                S.reset(bi)
        elif S.stage == 1:
            # B/C: no MSS step — the iFVG completes the chain (C also needs displacement)
            if S.z is not None and (S.disp or not S.needDisp):
                S.stage = 2; S.nMss = bi
            elif bi - S.nSweep > MSS_WIN + IFVG_WIN:
                S.reset(bi)
        elif S.stage == 2 and S.z is None and bi - S.nMss > IFVG_WIN:
            S.reset(bi)
        if S.needMss and S.stage == 2 and S.z is None:
            capture()          # iFVG at or after the MSS
    if S.needSweep:
        if sw is not None and S.stage in (0, 1) and bi - S.nEnd > COOLDOWN:
            ex_ = d * sw.ext
            al1 = d * b1 >= 3; op1 = d * b1 <= -3; al4 = d * b4 >= 3
            t = tap(eC, d, ex_, c_) or tap(eB, d, ex_, c_) or tap(eA, d, ex_, c_)
            ctxOK = (not S.ctx) or ((not op1) and (al1 or al4 or t != '' or sw.w >= 3))
            if inWin and ctxOK:
                m_ = None
                ip = eX.ipH if d == 1 else eX.ipL
                for i in range(len(ip) - 1, -1, -1):
                    v = d * ip[i]
                    if v > c_: m_ = v; break
                if m_ is None and len(eX.h) > 2:
                    for jj in range(1, min(10, len(eX.h) - 1) + 1):
                        v = eX.h[jj] if d == 1 else -eX.l[jj]
                        if m_ is None or v > m_: m_ = v
                S.stage = 1; S.liqPx = d * sw.px; S.ext = ex_; S.nSweep = bi
                S.mssLvl = m_; S.disp = dispNow; S.z = None; S.legExt = h_
                if S.needMss and c_ > S.mssLvl and S.disp:
                    S.stage = 2; S.nMss = bi
                    capture()
    else:
        # A: any fresh chart-TF iFVG in the trade's direction; stop beyond the low of the last 12 bars
        if newInv and S.stage == 0 and bi - S.nEnd > COOLDOWN and eX.lastIFVG is not None and not eX.lastIFVG.dead and inWin:
            zc = eX.lastIFVG
            zt = zc.top if d == 1 else -zc.bot; zb = zc.bot if d == 1 else -zc.top
            m = min(12, len(eX.l))
            ext = min((eX.l[j] if d == 1 else -eX.h[j]) for j in range(m))
            if zb > ext:
                S.stage = 2; S.liqPx = ext; S.ext = ext; S.nSweep = bi; S.nMss = bi
                S.z = zc; S.zTop = zt; S.zBot = zb; S.disp = True
                S.legExt = max((eX.h[j] if d == 1 else -eX.l[j]) for j in range(m))
    return S.stage == 2 and S.z is not None and not S.z.dead

def arm(S, ST, bi, atrX, TICK, liqs, sessH, sessL, htfs, inWin=True):
    d = S.d
    if not inWin:
        S.reset(bi); return
    S.entry = S.zTop
    S.stop = math.floor((S.ext - max(STOP_BUF_ATR * atrX, 2 * TICK)) / TICK + 1e-9) * TICK   # outward to a valid tick
    if S.entry - S.stop < 2 * TICK:
        S.reset(bi); return
    R = S.entry - S.stop
    px = [S.legExt]
    for q in liqs:
        if not q.done and q.hi == (d == 1): px.append(d * q.px)
    if sessH is not None: px.append(sessH if d == 1 else -sessL)
    for e in htfs:
        if e.n > 0:
            for z in e.zones:
                if z.bull != (d == 1): px.append(z.bot if d == 1 else -z.top)
    px.sort()
    tp = []
    for v in px:
        if v >= S.entry + MIN_TGT_R * R and (not tp or v - tp[-1] >= 0.25 * R) and len(tp) < 3:
            tp.append(v)
    if not tp:
        S.reset(bi); return
    S.tp1 = tp[0]; S.tp2 = tp[1] if len(tp) > 1 else None; S.tp3 = tp[2] if len(tp) > 2 else None
    S.stage = 3; S.nReady = bi; S.entry0 = S.entry; S.pDone = False
    ST.ready += 1

def pre_entry(S, ST, bi, c, hFlip):
    c_ = S.d * c
    if c_ < S.ext or S.z.dead or c_ < S.zBot or hFlip:
        ST.invalid += 1; S.reset(bi); return True
    return False

def on_close_prepare(S, ST, bi, h, l, c, hFlip, inWin, sub_h, sub_l, sub_t):
    if S.stage == 3 and bi > S.nReady:
        d = S.d; h_ = hi_(d, h, l); l_ = lo_(d, h, l)
        if not pre_entry(S, ST, bi, c, hFlip):
            if l_ <= S.zTop:
                ST.qaChecks += 1
                ST.qaViol += 0 if (bi > S.nReady and d * c >= S.zBot) else 1
                S.stage = 4; S.nRetest = bi; S.tFrom1m = int(sub_t[0])
                S.pStep = 0; S.pDisp = False; S.pMssOK = False; S.pTop = None; S.pDone = False
                for k in range(len(sub_h)):
                    if (sub_l[k] if d == 1 else -sub_h[k]) <= S.zTop:
                        S.tFrom1m = int(sub_t[k]); break
            elif h_ >= S.tp1:
                ST.missed += 1; S.reset(bi)
            elif bi - S.nReady > READY_WIN:
                ST.expired += 1; S.reset(bi)
            elif not inWin:
                ST.expired += 1; S.reset(bi)

def prec_step(S, e1, h, l, c, t):
    if S.stage == 4 and not S.pDone and t >= S.tFrom1m:
        d = S.d; sl = l if d == 1 else -h; sc = d * c
        lv = None
        if len(e1.l) >= 2:
            for j in range(1, min(10, len(e1.l) - 1) + 1):
                v = e1.l[j] if d == 1 else -e1.h[j]
                lv = v if lv is None else min(lv, v)
        if lv is not None and sl < lv and sc > lv and not S.pMssOK:
            S.pStep = 1; S.pDisp = False; S.pTop = None
            m_ = None
            ip = e1.ipH if d == 1 else e1.ipL
            for i in range(len(ip) - 1, -1, -1):
                v = d * ip[i]
                if v > sc: m_ = v; break
            if m_ is None and len(e1.h) > 2:
                for j in range(1, min(5, len(e1.h) - 1) + 1):
                    v = e1.h[j] if d == 1 else -e1.l[j]
                    m_ = v if m_ is None else max(m_, v)
            S.pMss = m_
        if S.pStep >= 1:
            S.pDisp = S.pDisp or (e1.evDispUp if d == 1 else e1.evDispDn)
            if S.pDisp:
                S.pStep = max(S.pStep, 2)
                if not S.pMssOK and S.pMss is not None and sc > S.pMss:
                    S.pMssOK = True; S.pStep = 3
                if (e1.evBullIFVG if d == 1 else e1.evBearIFVG) and e1.lastIFVG is not None:
                    S.pTop = e1.lastIFVG.top if d == 1 else -e1.lastIFVG.bot; S.pZoneN = e1.n
                elif (e1.evBullFVG if d == 1 else e1.evBearFVG) and e1.zones:
                    zz = e1.zones[-1]; S.pTop = zz.top if d == 1 else -zz.bot; S.pZoneN = e1.n
            if S.pMssOK and S.pTop is not None and e1.n > S.pZoneN and sl <= S.pTop:
                S.pDone = True; S.pStep = 5

def on_close_zone(S, ST, bi, c, hFlip, otherActive, inWin, nextInWin=True):
    if S.stage == 4:
        c_ = S.d * c; R = S.entry0 - S.stop
        if not pre_entry(S, ST, bi, c, hFlip):
            if c_ >= S.entry0 + CHASE_R * R:
                ST.missed += 1; S.reset(bi)
            elif S.prec and not S.pDone and bi - S.nRetest >= PREC_BARS:
                ST.noPrec += 1; S.reset(bi)
            elif not inWin:
                ST.expired += 1; S.reset(bi)
            elif not nextInWin:
                ST.expired += 1; S.reset(bi)
            elif ((not S.prec) or S.pDone) and not otherActive:
                e_ = S.entry0
                if S.prec and S.pTop is not None and S.stop < S.pTop <= S.zTop:
                    e_ = S.pTop
                ST.qaChecks += 1
                ST.qaViol += 0 if (S.nRetest > S.nReady and bi >= S.nRetest and (not S.prec or S.pDone)) else 1
                S.entry = e_; S.stage = 5; S.nEntry = bi
                ST.entryReady += 1
                if S.prec: ST.precDone += 1

def on_close_pending(S, ST, bi, c, hFlip, inWin, nextInWin=True):
    if S.stage == 5 and bi > S.nEntry:
        c_ = S.d * c; R = S.entry - S.stop
        if not pre_entry(S, ST, bi, c, hFlip):
            if c_ >= S.entry + CHASE_R * R:
                ST.missed += 1; S.reset(bi)
            elif bi - S.nEntry >= PEND_BARS:
                ST.missed += 1; S.reset(bi)
            elif not inWin or not nextInWin:
                ST.invalid += 1; S.reset(bi)

def exit_leg(S, i, px):
    nL = len(S.legTp)
    S.legOpen[i] = False
    S.ptsGross += (px - S.fillPx) / nL
    S.rGross += (px - S.fillPx) / S.riskPlan / nL          # R = PLANNED risk (limit → stop)

def exit_all(S, px):
    for i in range(len(S.legOpen)):
        if S.legOpen[i]: exit_leg(S, i, px)

def manage(S, ST, bi, o, h, l, c, sub_o, sub_h, sub_l, TICK, PV, FEE, conflictPrev, tradePrev, inFlat, tb, inWin=True):
    d = S.d
    fillable = S.stage == 5 and bi > S.nEntry and not conflictPrev and not tradePrev and inWin
    if not (fillable or S.stage == 6): return
    h_ = hi_(d, h, l); l_ = lo_(d, h, l)
    nSub = len(sub_h)
    bothIn = S.stage == 6 and any(S.legOpen[i] and l_ <= S.stop and h_ >= tpv + TICK for i, tpv in enumerate(S.legTp))
    unres0 = ST.ambUnres
    why = ''
    for k in range(nSub):
        sh = sub_h[k] if d == 1 else -sub_l[k]
        sl = sub_l[k] if d == 1 else -sub_h[k]
        so = d * sub_o[k]
        if S.stage != 6:
            if sl <= S.entry - TICK:                       # limit fills on a 1-tick trade-through
                ST.qaChecks += 1
                ST.qaViol += 0 if bi > S.nEntry else 1
                S.riskPlan = S.entry - S.stop
                S.fillPx = so if (k == 0 and so < S.entry) else S.entry   # through at the open → fill at the open
                S.stage = 6; S.fillT = tb
                t1 = S.tp1; t2 = S.tp2 if S.tp2 is not None else t1; t3 = S.tp3 if S.tp3 is not None else t2
                ST.noTp2 += S.tp2 is None; ST.noTp3 += S.tp3 is None
                S.legTp = [t1] if S.exitPlan == 'TP1' else [t2] if S.exitPlan == 'TP2' else [t1, t2, t3]
                S.legOpen = [True] * len(S.legTp); S.rGross = 0.0; S.ptsGross = 0.0
                if sl <= S.stop:
                    exit_all(S, min(S.stop - STOP_SLIP * TICK, so)); why = 'stop'
                elif any(sh >= tpv + TICK for tpv in S.legTp):
                    ST.ambUnres += 1                        # target in the fill minute: not credited
        else:
            hitS = sl <= S.stop
            hitT = any(S.legOpen[i] and sh >= tpv + TICK for i, tpv in enumerate(S.legTp))
            if hitS:
                if hitT: ST.ambUnres += 1                   # both inside one minute → stop first
                exit_all(S, min(S.stop - STOP_SLIP * TICK, so)); why = 'stop'
            elif hitT:
                for i, tpv in enumerate(S.legTp):
                    if S.legOpen[i] and sh >= tpv + TICK: exit_leg(S, i, tpv)
                why = 'target'
        if S.stage == 6 and not any(S.legOpen): break
    if bothIn and ST.ambUnres == unres0: ST.ambRes += 1
    if S.stage == 6 and any(S.legOpen) and not inFlat:
        exit_all(S, d * c); why = 'flat'
    if S.stage == 6 and not any(S.legOpen):
        ST.trades.append((int(S.fillT), d, S.rGross - 2 * FEE / PV / S.riskPlan, S.ptsGross * PV - 2 * FEE, why))
        S.reset(bi)

# ───────────────────────────── data ─────────────────────────────
def load(sp):
    df = pd.read_csv(sp['file'], usecols=['ts_event', 'instrument_id', 'open', 'high', 'low', 'close'])
    ts = pd.to_datetime(df.ts_event.str[:19]).dt.tz_localize('UTC').dt.tz_convert('America/New_York').dt.tz_localize(None)
    tmin = ts.values.astype('datetime64[m]').astype('int64')
    o = df.open.values.astype(float); h = df.high.values.astype(float); l = df.low.values.astype(float); c = df.close.values.astype(float)
    iid = df.instrument_id.values
    order = np.argsort(tmin, kind='stable')
    tmin, o, h, l, c, iid = tmin[order], o[order], h[order], l[order], c[order], iid[order]
    roll = np.nonzero(iid[1:] != iid[:-1])[0] + 1
    adj = np.zeros(len(o))
    for r in roll:                       # panama back-adjust: shift everything before the roll by the jump
        adj[:r] += o[r] - c[r - 1]
    return tmin, o + adj, h + adj, l + adj, c + adj

def agg(key, o, h, l, c):
    brk = np.nonzero(key[1:] != key[:-1])[0] + 1
    st = np.concatenate([[0], brk]); en = np.concatenate([brk, [len(o)]])
    return st, en, o[st], np.maximum.reduceat(h, st), np.minimum.reduceat(l, st), c[en - 1]

# ───────────────────────────── main run ─────────────────────────────
def run(sym, lastDays=None):
    sp = SPEC[sym]; TICK = sp['tick']; PV = sp['pv']; FEE = sp['fee']
    tmin, o1, h1, l1, c1 = load(sp)
    if lastDays:
        keep = tmin >= tmin[-1] - lastDays * 1440
        tmin, o1, h1, l1, c1 = tmin[keep], o1[keep], h1[keep], l1[keep], c1[keep]
    k5 = tmin // 5
    st5, en5, O, H, L, C = agg(k5, o1, h1, l1, c1)
    T5 = k5[st5] * 5
    sm = (tmin - 18 * 60) % 1440
    td = (tmin + 6 * 60) // 1440                           # trading day, named by its END date (18:00 ET start)
    dow = (td + 3) % 7                                     # 0 = Monday; Sunday-evening session → Monday
    keys = {'15': tmin // 15, '60': tmin // 60, '240': td * 10 + np.minimum(sm // 240, 5),
            'D': td, 'W': td - dow}
    htf = {}; ci = {}
    for name, key in keys.items():
        st, en, ho, hh, hl, hc = agg(key, o1, h1, l1, c1)
        htf[name] = (ho, hh, hl, hc)
        # TV's [1] + lookahead_on: on a chart bar, the HTF bar BEFORE the one containing its open
        ci[name] = np.searchsorted(key[st], key[st5], side='right') - 2

    eA = Engine('4H', HTF_LEN, TICK, sp['fvg_ticks']); eB = Engine('1H', HTF_LEN, TICK, sp['fvg_ticks'])
    eC = Engine('15M', HTF_LEN, TICK, sp['fvg_ticks']); eX = Engine('5M', SWING_LEN, TICK, sp['fvg_ticks'])
    e1 = Engine('1M', 2, TICK, sp['fvg_ticks'])
    last = {k: -1 for k in keys}
    liqs = []
    onH = onL = None; wasON = False; sessH = sessL = None; wasRTH = False
    eqHp = []; eqHn = []; eqLp = []; eqLn = []
    sides = {v: (Setup(1, f), Setup(-1, f)) for v, f in VARIANTS.items()}
    for v, (a_, b_) in sides.items():
        a_.exitPlan = b_.exitPlan = EXIT_OF[v]
    stats = {v: Stats() for v in VARIANTS}
    cprev = {v: False for v in VARIANTS}; tprev = {v: False for v in VARIANTS}
    precV = [v for v, f in VARIANTS.items() if f[5]]

    def add_liq(px, hi, kind, w, bi, tol):
        dup = False
        for q in liqs:
            if not q.done and q.hi == hi and abs(q.px - px) <= tol:
                dup = True
                if w > q.w: q.w = w; q.kind = kind
        if not dup:
            liqs.append(Liq(px, hi, kind, w, bi))
            if w == 1:
                cnt = 0
                for i in range(len(liqs) - 1, -1, -1):
                    q = liqs[i]
                    if q.w == 1 and q.hi == hi and not q.done:
                        cnt += 1
                        if cnt > 4:
                            del liqs[i]; break

    def drop_kind(kind):
        for i in range(len(liqs) - 1, -1, -1):
            if liqs[i].kind == kind and not liqs[i].done: del liqs[i]

    nbar = len(O); t0 = _time.time()
    for bi in range(nbar):
        o, h, l, c = O[bi], H[bi], L[bi], C[bi]
        tb = int(T5[bi]); m5 = tb % 1440
        fed = {}
        for name, e in (('240', eA), ('60', eB), ('15', eC)):
            j = ci[name][bi]; fed[name] = False
            if j >= 0 and j != last[name]:
                last[name] = j; fed[name] = True
                ho, hh, hl, hc = htf[name]
                e.feed(ho[j], hh[j], hl[j], hc[j])
        eX.feed(o, h, l, c)
        atrX = eX.atr; tolDup = 0.05 * atrX
        # levels revealed at this bar's OPEN exist before the sweep scan (nMade = previous bar)
        for name, hk, lk in (('D', 'PDH', 'PDL'), ('W', 'PWH', 'PWL')):
            j = ci[name][bi]
            if j >= 0 and j != last[name]:
                last[name] = j; _, hh, hl, _ = htf[name]
                drop_kind(hk); drop_kind(lk); add_liq(hh[j], True, hk, 4, bi - 1, tolDup); add_liq(hl[j], False, lk, 4, bi - 1, tolDup)
        inON = in_sess(m5, sp['on']); inRTH = in_sess(m5, sp['rth'])
        if not inON and wasON and onH is not None:
            drop_kind('ONH'); drop_kind('ONL'); add_liq(onH, True, 'ONH', 3, bi - 1, tolDup); add_liq(onL, False, 'ONL', 3, bi - 1, tolDup)
        swB = swS = None
        for q in liqs:
            if not q.done and q.nMade < bi:
                through = h > q.px if q.hi else l < q.px
                back = c < q.px if q.hi else c > q.px
                if q.nPierce < 0 and through:
                    q.nPierce = bi; q.ext = h if q.hi else l
                if q.nPierce >= 0:
                    q.ext = max(q.ext, h) if q.hi else min(q.ext, l)
                    if back:
                        q.done = True; q.nDone = bi
                        if q.hi:
                            if swB is None or q.w > swB.w: swB = q
                        elif swS is None or q.w > swS.w: swS = q
                    elif bi - q.nPierce >= RECLAIM - 1:
                        q.done = True; q.nDone = bi
        if inON:
            if not wasON: onH = h; onL = l; sessH = sessL = None
            else: onH = max(onH, h); onL = min(onL, l)
        wasON = inON
        if inRTH:
            if not wasRTH: sessH = h; sessL = l
            else: sessH = max(sessH, h); sessL = min(sessL, l)
        wasRTH = inRTH
        if eX.evPH:
            if eX.promPH >= PROM_ATR * atrX: add_liq(eX.lastPH, True, 'SH', 1, bi, tolDup)
            for i in range(len(eqHp)):
                if abs(eqHp[i] - eX.lastPH) <= EQ_TOL * atrX and bi - eqHn[i] >= 3:
                    add_liq(max(eqHp[i], eX.lastPH), True, 'EQH', 2, bi, tolDup); break
            eqHp.append(eX.lastPH); eqHn.append(bi)
        if eX.evPL:
            if eX.promPL >= PROM_ATR * atrX: add_liq(eX.lastPL, False, 'SL', 1, bi, tolDup)
            for i in range(len(eqLp)):
                if abs(eqLp[i] - eX.lastPL) <= EQ_TOL * atrX and bi - eqLn[i] >= 3:
                    add_liq(min(eqLp[i], eX.lastPL), False, 'EQL', 2, bi, tolDup); break
            eqLp.append(eX.lastPL); eqLn.append(bi)
        for i in range(len(eqHp) - 1, -1, -1):
            if h > eqHp[i]: del eqHp[i]; del eqHn[i]
        for i in range(len(eqLp) - 1, -1, -1):
            if l < eqLp[i]: del eqLp[i]; del eqLn[i]
        while len(eqHp) > 8: eqHp.pop(0); eqHn.pop(0)
        while len(eqLp) > 8: eqLp.pop(0); eqLn.pop(0)
        for name, e, w in (('15', eC, 2), ('60', eB, 3), ('240', eA, 3)):
            if fed[name] and e.evPH: add_liq(e.lastPH, True, e.tf + ' SH', w, bi, tolDup)
            if fed[name] and e.evPL: add_liq(e.lastPL, False, e.tf + ' SL', w, bi, tolDup)
        for i in range(len(liqs) - 1, -1, -1):
            if liqs[i].done and bi - liqs[i].nDone > 36: del liqs[i]
        while len(liqs) > 60: liqs.pop(0)

        # ── setups: every variant reads the same market state ──
        s1, s2 = st5[bi], en5[bi]
        sub_o = o1[s1:s2]; sub_h = h1[s1:s2]; sub_l = l1[s1:s2]; sub_c = c1[s1:s2]; sub_t = tmin[s1:s2]
        b1 = eB.bias(); b4 = eA.bias()
        ctx = {}
        for v, (SLo, SSo) in sides.items():
            ST = stats[v]; sess = SLo.sess
            inWin = (not sess) or (570 <= m5 < 840)                       # 09:30–14:00 (bar OPEN time)
            nextInWin = (not sess) or (570 <= m5 + 5 < 840)               # the NEXT bar (Pine: time_close)
            inFlat = (570 <= m5 < 950) if sess else not (1010 <= m5 < 1080)   # last held bar 15:50 → exit 15:55 / 16:55 break
            flipL = fed['60'] and SLo.ctx and b1 <= -3
            flipS = fed['60'] and SLo.ctx and b1 >= 3
            ctx[v] = (flipL, flipS, inWin, nextInWin)
            for S in (SLo, SSo):
                manage(S, ST, bi, o, h, l, c, sub_o, sub_h, sub_l, TICK, PV, FEE, cprev[v], tprev[v], inFlat, tb, inWin)
            on_close_prepare(SLo, ST, bi, h, l, c, flipL, inWin, sub_h, sub_l, sub_t)
            on_close_prepare(SSo, ST, bi, h, l, c, flipS, inWin, sub_h, sub_l, sub_t)
        for k in range(len(sub_o)):
            e1.feed(sub_o[k], sub_h[k], sub_l[k], sub_c[k])
            for v in precV:
                SLo, SSo = sides[v]
                if SLo.stage == 4: prec_step(SLo, e1, sub_h[k], sub_l[k], sub_c[k], int(sub_t[k]))
                if SSo.stage == 4: prec_step(SSo, e1, sub_h[k], sub_l[k], sub_c[k], int(sub_t[k]))
        for v, (SLo, SSo) in sides.items():
            ST = stats[v]; flipL, flipS, inWin, nextInWin = ctx[v]
            on_close_zone(SLo, ST, bi, c, flipL, actionable(SSo), inWin, nextInWin)
            on_close_zone(SSo, ST, bi, c, flipS, actionable(SLo), inWin, nextInWin)
            on_close_pending(SLo, ST, bi, c, flipL, inWin, nextInWin)
            on_close_pending(SSo, ST, bi, c, flipS, inWin, nextInWin)
            for S in (SLo, SSo):
                fl = flipL if S.d == 1 else flipS
                if fl and S.stage in (1, 2): S.reset(bi)
                if run_setup(S, bi, h, l, c, swS, swB, eX, eA, eB, eC, b1, b4, inWin):
                    arm(S, ST, bi, atrX, TICK, liqs, sessH, sessL, (eC, eB, eA), inWin)
            cprev[v] = actionable(SLo) and actionable(SSo)
            tprev[v] = SLo.stage == 6 or SSo.stage == 6
        if bi % 100000 == 0 and bi:
            print(f'{sym} {bi}/{nbar} bars  {_time.time()-t0:.0f}s', flush=True)
    return stats, sp

def summarize(trades):
    if not trades:
        return dict(n=0)
    r = np.array([t[2] for t in trades]); usd = np.array([t[3] for t in trades])
    wins = r > 0
    cum = np.cumsum(r); cumu = np.cumsum(usd)
    gw = r[wins].sum(); gl = -r[~wins].sum()
    sd = r.std(ddof=1) if len(r) > 1 else float('nan')
    streak = best = 0
    for x in r:
        streak = streak + 1 if x <= 0 else 0
        best = max(best, streak)
    return dict(n=int(len(r)), win=float(wins.mean()), medR=float(np.median(r)), loseStreak=int(best),
                avgWin=float(r[wins].mean()) if wins.any() else None, avgLoss=float(r[~wins].mean()) if (~wins).any() else None,
                expR=float(r.mean()), t=float(r.mean() / (sd / math.sqrt(len(r)))) if len(r) > 1 and sd > 0 else None,
                pf=float(gw / gl) if gl > 0 else None, maxDDR=float(np.max(np.maximum.accumulate(cum) - cum)),
                netUSD=float(usd.sum()), maxDDUSD=float(np.max(np.maximum.accumulate(cumu) - cumu)))

if __name__ == '__main__':
    sym = sys.argv[1]
    lastDays = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
    stats, sp = run(sym, lastDays)
    out = {'symbol': sp['name'], 'variants': {}}
    y2019 = int(np.datetime64('2019-01-01T00:00').astype('datetime64[m]').astype('int64'))
    for v, ST in stats.items():
        tr = ST.trades
        years = {}
        for t in tr:
            years.setdefault(str(np.datetime64(t[0], 'm').astype('datetime64[Y]')), []).append(t)
        out['variants'][v] = dict(all=summarize(tr), h2011_18=summarize([t for t in tr if t[0] < y2019]),
                                  h2019_26=summarize([t for t in tr if t[0] >= y2019]),
                                  longs=summarize([t for t in tr if t[1] == 1]), shorts=summarize([t for t in tr if t[1] == -1]),
                                  years={y: summarize(ts) for y, ts in sorted(years.items())},
                                  counts=dict(prepare=ST.ready, missed=ST.missed, invalid=ST.invalid, expired=ST.expired,
                                              noPrec=ST.noPrec, ambRes=ST.ambRes, ambUnres=ST.ambUnres, entryReady=ST.entryReady, precDone=ST.precDone,
                                              noTp2=ST.noTp2, noTp3=ST.noTp3, qaChecks=ST.qaChecks, qaViol=ST.qaViol),
                                  trades=[(t[0], t[1], round(t[2], 4), round(t[3], 2), t[4]) for t in tr])
    json.dump(out, open(f'/Users/user/trading/tradingview/lab/out_{sym}' + ('_exits' if '--exits' in sys.argv else '') + (f'_{lastDays}d' if lastDays else '') + '.json', 'w'))
    for v, r in out['variants'].items():
        a = r['all']
        print(f"{sp['name']} {v:30s} n={a.get('n',0):5d} win={a.get('win',0):.3f} expR={a.get('expR',0):+.3f} "
              f"t={a.get('t') or 0:+.2f} PF={a.get('pf') or 0:.2f} net=${a.get('netUSD',0):,.0f}", flush=True)
