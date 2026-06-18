#!/usr/bin/env python3
"""
Databento MARKET-DATA SIDECAR — the ONE live feed for the whole system.
Streams real-time top-of-book (mbp-1), trades, AND 10-level depth (mbp-10) from Databento
and writes to Postgres tables that engines + UI read.

Tables:
  live_quotes  — top-of-book bid/ask/mid/cumvol per symbol (engines + chart use this as PRIMARY)
  live_depth   — JSON 10-level bid/ask ladder per symbol (UI depth ladder; engines fall back if missing)

ONE sidecar = ONE Databento live session (stays within the 2-device limit) → serves demo + live via DB.
Execution stays on Tradovate; this only changes where PRICES come from.

Env: DATABENTO_API_KEY + DATABASE_URL (from .env.local).
"""
import os, re, sys, time, traceback, json

SYMBOLS = [
    "ES.v.0", "NQ.v.0", "GC.v.0",  # equity indexes + gold (engines map MES/MNQ/MGC to these prices)
    "MBT.v.0", "MET.v.0", "BFF.v.0", "MXR.v.0", "MSL.v.0",  # CME crypto micros (BTC/ETH/BTC-weekly/XRP/SOL)
]
WRITE_EVERY = 1.0           # seconds between DB upserts of live_quotes (throttle)
DEPTH_WRITE_EVERY = 2.0     # depth churns hard; write at most every 2s
# MBP-10 disabled — our current Databento plan returns "Not authorized for mbp-10 schema".
# Upgrade to Plus/Pro tier to enable, then set this True and redeploy with:
#   railway up ./sidecar --path-as-root --service databento-sidecar
ENABLE_MBP10 = False

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
        c.execute("""CREATE TABLE IF NOT EXISTS live_depth (
            symbol text PRIMARY KEY,
            bids jsonb,         -- array of {price, size} sorted desc
            asks jsonb,         -- array of {price, size} sorted asc
            levels int default 0,
            ts bigint,
            updated_at timestamptz DEFAULT now()
        )""")
    return conn

def upsert_quotes(conn, latest):
    with conn.cursor() as c:
        for sym, (bid, ask, ts, vol) in latest.items():
            c.execute("""INSERT INTO live_quotes(symbol,bid,ask,mid,ts,vol,source,updated_at)
                VALUES(%s,%s,%s,%s,%s,%s,'databento',now())
                ON CONFLICT(symbol) DO UPDATE SET bid=%s,ask=%s,mid=%s,ts=%s,vol=%s,source='databento',updated_at=now()""",
                (sym, bid, ask, (bid+ask)/2, ts, vol, bid, ask, (bid+ask)/2, ts, vol))

def upsert_depth(conn, depth_latest):
    with conn.cursor() as c:
        for sym, (bids, asks, ts) in depth_latest.items():
            bids_json = json.dumps(bids)
            asks_json = json.dumps(asks)
            n = max(len(bids), len(asks))
            c.execute("""INSERT INTO live_depth(symbol, bids, asks, levels, ts, updated_at)
                VALUES(%s, %s::jsonb, %s::jsonb, %s, %s, now())
                ON CONFLICT(symbol) DO UPDATE SET bids=%s::jsonb, asks=%s::jsonb, levels=%s, ts=%s, updated_at=now()""",
                (sym, bids_json, asks_json, n, ts, bids_json, asks_json, n, ts))

def extract_levels(rec):
    """Pull bid/ask price+size from any number of book levels."""
    lv = getattr(rec, "levels", None)
    if not lv:
        return [], []
    bids, asks = [], []
    for level in lv:
        bp = getattr(level, "bid_px", 0) / 1e9 if getattr(level, "bid_px", 0) else 0
        bs = getattr(level, "bid_sz", 0)
        ap = getattr(level, "ask_px", 0) / 1e9 if getattr(level, "ask_px", 0) else 0
        asz = getattr(level, "ask_sz", 0)
        if bp > 0 and bs > 0: bids.append({"price": bp, "size": bs})
        if ap > 0 and asz > 0: asks.append({"price": ap, "size": asz})
    return bids, asks

def stream_once(conn):
    import databento as db
    client = db.Live(key=env("DATABENTO_API_KEY"))
    client.subscribe(dataset="GLBX.MDP3", schema="mbp-1", stype_in="continuous", symbols=SYMBOLS)
    client.subscribe(dataset="GLBX.MDP3", schema="trades", stype_in="continuous", symbols=SYMBOLS)
    mbp10_subscribed = False
    if ENABLE_MBP10:
        try:
            client.subscribe(dataset="GLBX.MDP3", schema="mbp-10", stype_in="continuous", symbols=SYMBOLS)
            mbp10_subscribed = True
        except Exception as e:
            print(f"[sidecar] WARN: mbp-10 subscription failed ({e}) — continuing with mbp-1 + trades only", flush=True)

    schemas = "mbp-1 + trades" + (" + mbp-10" if mbp10_subscribed else "")
    print(f"[sidecar] subscribed {SYMBOLS} ({schemas})", flush=True)

    id_to_sym, latest, depth_latest, cumvol = {}, {}, {}, {}
    last_write, last_depth_write, last_log = 0.0, 0.0, 0.0
    # Stale-mapping watchdog: detect quarterly contract rollovers (e.g. NQM→NQU) without a stream crash.
    # After the first successful symbol match, count consecutive messages with unrecognized instrument IDs.
    # >200 in a row OR >120s of all-unknown messages → reconnect so Databento re-sends SymbolMappingMsg.
    had_match, consec_unknown, unknown_start = False, 0, 0.0

    for rec in client:
        name = type(rec).__name__
        if name == "SymbolMappingMsg":
            raw = getattr(rec, "stype_in_symbol", None) or getattr(rec, "stype_out_symbol", "")
            id_to_sym[rec.instrument_id] = raw.split(".")[0]
            consec_unknown = 0  # fresh mapping = connection is healthy
            continue
        sym = id_to_sym.get(getattr(rec, "instrument_id", None))
        if not sym:
            if had_match:  # only count unknowns after we've proven mappings work
                consec_unknown += 1
                if consec_unknown == 1:
                    unknown_start = time.time()
                elapsed = time.time() - unknown_start
                if consec_unknown > 200 or elapsed > 120:
                    raise Exception(f"Stale instrument mapping — {consec_unknown} unrecognized msgs over {elapsed:.0f}s. Contract rollover? Reconnecting.")
            continue
        had_match = True
        consec_unknown = 0

        if name == "TradeMsg":
            cumvol[sym] = cumvol.get(sym, 0) + (getattr(rec, "size", 0) or 0)
            continue

        # MBP messages — top of book (mbp-1) OR full ladder (mbp-10)
        lv = getattr(rec, "levels", None)
        if not lv:
            continue

        # Top of book always — keep live_quotes fresh
        bid_l, ask_l = lv[0].bid_px / 1e9, lv[0].ask_px / 1e9
        if bid_l > 0 and ask_l > 0:
            latest[sym] = (bid_l, ask_l, int(getattr(rec, "ts_event", time.time_ns()) // 1_000_000), cumvol.get(sym, 0))

        # Depth — only when message carries 10 levels (MBP-10 schema)
        if mbp10_subscribed and len(lv) > 1:
            bids, asks = extract_levels(rec)
            if bids and asks:
                depth_latest[sym] = (bids, asks, int(getattr(rec, "ts_event", time.time_ns()) // 1_000_000))

        now = time.time()
        if now - last_write >= WRITE_EVERY and latest:
            upsert_quotes(conn, latest); last_write = now
        if mbp10_subscribed and now - last_depth_write >= DEPTH_WRITE_EVERY and depth_latest:
            try: upsert_depth(conn, depth_latest)
            except Exception as e: print(f"[sidecar] depth upsert error: {e}", flush=True)
            last_depth_write = now
        if now - last_log >= 30:
            depth_status = f" depth={len(depth_latest)} syms" if mbp10_subscribed else ""
            print(f"[sidecar] {', '.join(f'{s} {v[0]:.2f}/{v[1]:.2f} vol={int(v[3])}' for s,v in latest.items())}{depth_status}", flush=True)
            last_log = now

def main():
    conn = db_connect()
    print("[sidecar] DB ready (live_quotes + live_depth)", flush=True)
    while True:
        try:
            stream_once(conn)
        except KeyboardInterrupt:
            print("[sidecar] stopped"); return
        except Exception:
            print("[sidecar] stream error — reconnecting in 5s:\n" + traceback.format_exc(), flush=True)
            time.sleep(5)
            try: conn.close()
            except Exception: pass
            try:
                conn = db_connect()
                print("[sidecar] DB reconnected", flush=True)
            except Exception:
                print("[sidecar] DB reconnect failed — will retry", flush=True)

if __name__ == "__main__":
    main()
