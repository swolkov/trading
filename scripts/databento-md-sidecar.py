#!/usr/bin/env python3
"""
Databento MARKET-DATA SIDECAR (Phase 4) — the ONE live feed for the whole system.
Streams real-time top-of-book (mbp-1) for ES/NQ/GC from Databento and upserts the latest
bid/ask/mid into a Postgres `live_quotes` table. Both engines read that table as their PRIMARY
market-data source (fail-safe: stale/missing → engines fall back to their existing Tradovate→Yahoo chain).

ONE sidecar = ONE Databento live session (stays within the 2-device limit) → serves demo + live via DB.
Execution stays on Tradovate; this only changes where PRICES come from.

  python3 scripts/databento-md-sidecar.py            (runs forever; reconnects on drop)
Env: DATABENTO_API_KEY + DATABASE_URL (from .env.local).
"""
import os, re, sys, time, traceback

SYMBOLS = ["ES.v.0", "NQ.v.0", "GC.v.0"]   # full-size; engines map micros (MES→ES, etc.) to these prices
WRITE_EVERY = 1.0                           # seconds between DB upserts (throttle)

def env(name):
    if os.environ.get(name):
        return os.environ[name]
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", ".env.local")) as f:
        m = re.search(rf"^{name}=(.+)$", f.read(), re.M)
        return m.group(1).strip().strip('"').strip("'") if m else None

def db_connect():
    import psycopg2
    url = env("DATABASE_URL") or env("POSTGRES_URL")
    if not url:
        sys.exit("DATABASE_URL not found")
    if "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    conn = psycopg2.connect(url)
    conn.autocommit = True
    with conn.cursor() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS live_quotes (
            symbol text PRIMARY KEY, bid double precision, ask double precision,
            mid double precision, ts bigint, source text, updated_at timestamptz DEFAULT now())""")
        c.execute("ALTER TABLE live_quotes ADD COLUMN IF NOT EXISTS vol double precision DEFAULT 0")
    return conn

def upsert(conn, latest):
    with conn.cursor() as c:
        for sym, (bid, ask, ts, vol) in latest.items():
            c.execute("""INSERT INTO live_quotes(symbol,bid,ask,mid,ts,vol,source,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s,'databento',now())
                ON CONFLICT(symbol) DO UPDATE SET bid=%s,ask=%s,mid=%s,ts=%s,vol=%s,source='databento',updated_at=now()""",
                (sym, bid, ask, (bid+ask)/2, ts, vol, bid, ask, (bid+ask)/2, ts, vol))

def stream_once(conn):
    import databento as db
    client = db.Live(key=env("DATABENTO_API_KEY"))
    client.subscribe(dataset="GLBX.MDP3", schema="mbp-1", stype_in="continuous", symbols=SYMBOLS)
    print(f"[sidecar] subscribed {SYMBOLS}", flush=True)
    id_to_sym, latest, last_write, last_log = {}, {}, 0.0, 0.0
    for rec in client:
        name = type(rec).__name__
        if name == "SymbolMappingMsg":
            raw = getattr(rec, "stype_in_symbol", None) or getattr(rec, "stype_out_symbol", "")
            id_to_sym[rec.instrument_id] = raw.split(".")[0]   # "ES.v.0" → "ES"
            continue
        lv = getattr(rec, "levels", None)
        if not lv:
            continue
        sym = id_to_sym.get(getattr(rec, "instrument_id", None))
        if not sym:
            continue
        bid, ask = lv[0].bid_px / 1e9, lv[0].ask_px / 1e9
        vol = (getattr(lv[0], "bid_sz", 0) or 0) + (getattr(lv[0], "ask_sz", 0) or 0)   # top-of-book size = liquidity-weighted volume proxy
        if bid > 0 and ask > 0:
            latest[sym] = (bid, ask, int(getattr(rec, "ts_event", time.time_ns()) // 1_000_000), vol)
        now = time.time()
        if now - last_write >= WRITE_EVERY and latest:
            upsert(conn, latest); last_write = now
        if now - last_log >= 30:
            print(f"[sidecar] {', '.join(f'{s} {v[0]:.2f}/{v[1]:.2f}' for s,v in latest.items())}", flush=True)
            last_log = now

def main():
    conn = db_connect()
    print("[sidecar] DB ready (live_quotes)", flush=True)
    while True:
        try:
            stream_once(conn)
        except KeyboardInterrupt:
            print("[sidecar] stopped"); return
        except Exception:
            print("[sidecar] stream error — reconnecting in 5s:\n" + traceback.format_exc(), flush=True)
            time.sleep(5)

if __name__ == "__main__":
    main()
