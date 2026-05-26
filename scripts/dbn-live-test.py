#!/usr/bin/env python3
"""Databento LIVE connection test — proves entitlement + streaming before building the sidecar.
Subscribes to ES mbp-1 (top of book), reads a few records, reports. Hard 20s timeout."""
import os, re, signal, sys

def api_key():
    if os.environ.get("DATABENTO_API_KEY"):
        return os.environ["DATABENTO_API_KEY"]
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", ".env.local")) as f:
        m = re.search(r"^DATABENTO_API_KEY=(.+)$", f.read(), re.M)
        if not m:
            sys.exit("DATABENTO_API_KEY not found in .env.local")
        return m.group(1).strip().strip('"').strip("'")

def main():
    import databento as db
    client = db.Live(key=api_key())
    client.subscribe(dataset="GLBX.MDP3", schema="mbp-1", stype_in="continuous", symbols=["ES.v.0"])
    print("subscribed: GLBX.MDP3 mbp-1 ES.v.0 — waiting for records...")

    def timeout(*_):
        print("\n⏱ 20s elapsed — connection OK, but no price records (market may be quiet).")
        client.terminate(); sys.exit(0)
    signal.signal(signal.SIGALRM, timeout); signal.alarm(20)

    n = 0
    for rec in client:
        cls = type(rec).__name__
        # price (MBP-1) messages carry a top-of-book level
        lv = getattr(rec, "levels", None)
        if lv:
            bid = lv[0].bid_px / 1e9; ask = lv[0].ask_px / 1e9
            print(f"  {cls}: bid {bid:.2f} / ask {ask:.2f}  spread {ask-bid:.2f}")
            n += 1
            if n >= 3:
                print(f"\n✅ LIVE STREAMING CONFIRMED — {n} top-of-book records, key entitled.")
                client.terminate(); break
        else:
            print(f"  ({cls})")  # system / symbol-mapping messages

if __name__ == "__main__":
    main()
