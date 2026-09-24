"""Unit tests for the lab engine (mirror of the Pine self-test) + HTF alignment.  Run: python3 test_ict_lab.py"""
import numpy as np
import ict_lab as L

def eng(p=3):
    return L.Engine('T', p, 0.25, 2)

def test_bull_fvg_wick_close_fail():
    a = eng()
    a.feed(1000, 1002, 999, 1001); a.feed(1001, 1010, 1000, 1009)
    assert not a.zones, 'no FVG before 3 candles'
    a.feed(1009, 1012, 1008, 1011)
    assert a.evBullFVG and len(a.zones) == 1
    z = a.zones[0]; assert (z.bot, z.top, z.bull, z.inv) == (1002, 1008, True, False)
    a.feed(1010, 1011, 1000, 1004)
    assert not z.inv and not a.evBearIFVG, 'wick must not invert'
    a.feed(1004, 1005, 998, 999)
    assert z.inv and not z.bull and a.evBearIFVG, 'close inverts'
    a.feed(999, 1012, 998, 1010)
    assert z.dead, 'iFVG dies when closed back through'

def test_bear_fvg_wick_close():
    b = eng()
    b.feed(1000, 1001, 998, 999); b.feed(999, 1000, 990, 991); b.feed(991, 992, 988, 989)
    y = b.zones[0]; assert b.evBearFVG and (y.top, y.bot, y.bull) == (998, 992, False)
    b.feed(990, 1000, 989, 996); assert not y.inv
    b.feed(996, 1002, 995, 1001); assert y.inv and y.bull and b.evBullIFVG

def test_touching_is_not_a_gap():
    c = eng(); c.feed(1000, 1005, 999, 1004); c.feed(1004, 1010, 1003, 1009); c.feed(1009, 1012, 1005, 1011)
    assert not c.zones

def test_swing_delay():
    s = eng(2)
    for bar in [(100, 101, 99, 100), (100, 102, 99, 101), (101, 105, 100, 104), (104, 103, 100, 101)]:
        s.feed(*bar)
    assert s.lastPH is None
    s.feed(101, 102, 99, 100); assert s.evPH and s.lastPH == 105

def test_htf_alignment_uses_completed_candles_only():
    # 1m minutes spanning two 1H candles; chart = 5m. On every 5m bar the returned 1H index must be
    # the candle BEFORE the one containing the 5m bar's open (TV's [1] + lookahead_on).
    tmin = np.arange(0, 180)                       # 3 hours of minutes
    k5 = tmin // 5; st5 = np.concatenate([[0], np.nonzero(k5[1:] != k5[:-1])[0] + 1])
    k60 = tmin // 60; st60 = np.concatenate([[0], np.nonzero(k60[1:] != k60[:-1])[0] + 1])
    ci = np.searchsorted(k60[st60], k60[st5], side='right') - 2
    opens = tmin[st5]
    for o, j in zip(opens, ci):
        containing = o // 60
        assert j == containing - 1, (o, j)          # never the still-forming candle
    assert (ci[:12] == -1).all()                    # first hour: nothing completed yet

if __name__ == '__main__':
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn(); n += 1; print('PASS', name)
    print(f'{n} tests passed')
