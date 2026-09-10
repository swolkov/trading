---
name: options-desk
description: Run one Robinhood data pull for the options paper book — refresh quotes on open positions, fill outstanding option-chain requests, update the account snapshot, then run the scan. Use when Spencer says "run the options desk", "options pull", "update options", or when the scheduled options agent fires.
---

# Options Desk — one Robinhood pull

The options paper book (`/options/paper`) moved off Alpaca onto Robinhood on Sep 9 2026.
**The app cannot reach Robinhood** — its only official route is an OAuth MCP bound to a
Claude session, not an API key a server can hold. So this skill is the entire data path.
Nothing on that page advances unless this runs.

## HARD RULES — read every run

1. **PAPER ONLY. Never call `place_option_order`, `place_equity_order`, or any Robinhood
   write tool.** This book has not passed its gate. Only read tools are used here.
2. **The tradable account is `685528705`** ("Agentic", limited margin, funded $500).
   `5UR47259` is the main account — readable, but **never pass it to anything.**
3. **Never invent a quote.** If a contract has no two-sided market or Robinhood errors,
   leave it out. A missing quote is handled everywhere (position left alone, entry refused);
   a fabricated one corrupts the record permanently.
4. **Never edit the model to make a trade happen.** The universe, correlation groups, delta
   band, DTE window, spread ceiling and the two-entries-a-month cap are pre-registered in
   `src/lib/options-paper-model.ts` and were Codex-reviewed. If nothing qualifies, zero
   entries is the correct outcome.
5. Database commands use `--env-file=.env.local` (prod database in this repo), **not**
   `railway run`.

## The four steps

### 1. Work list
```bash
node --env-file=.env.local --import tsx scripts/options-rh-agent.ts worklist
```
Returns `openPositions` (occ, symbol, expiry, strike, type), `chainRequests`, and
`quoteStore`. **If `nothingToDo` is true and the account snapshot is fresh, stop.**

### 2. Account snapshot
`get_accounts`, then `get_portfolio` on `685528705`. Carry `option_level` through — the page
shows it. Level 3 was applied for on 2026-09-09; **if it has flipped to `option_level_3`,
say so**, because spreads unlock and that is worth telling Spencer.

### 3. Fetch from Robinhood
**Open positions first — they are the safety-critical half.** An unmarked position is a
stop that never gets checked; a missed entry costs one sample.

For each entry in `openPositions` (Robinhood identifies contracts by symbol + expiry + strike +
type, never by OCC). **A spread appears as TWO entries — `leg: "long"` and `leg: "short"` — and
BOTH must be quoted.** Quoting only the long leg silently freezes the position: it stops
marking and never reaches its stop or its 21-day floor.
1. `get_option_chains` with `underlying_symbol` → chain `id`.
2. `get_option_instruments` with that `chain_id`, `expiration_dates` = its expiry,
   `strike_price` = its strike, `type` → the instrument UUID.
3. `get_option_quotes` on those UUIDs, batched ≤ 20.

For each entry in `chainRequests` — **fetch BOTH calls and puts**:
1. `get_option_chains` → the expirations inside `[expiryFrom, expiryTo]`. Fetch **every**
   expiry in that window, not just the nearest: the engine compares them against each other.
2. `get_option_instruments` per matching expiry, once with `type: "call"` and once with
   `type: "put"`, following `next` only until the strikes span `[strikeMin, strikeMax]`.
3. `get_option_quotes` on those strikes, batched ≤ 20.
   - **Use the request's own `strikeMin` / `strikeMax`.** Do not substitute a rule of thumb:
     the window is set per request and it DIFFERS BY DIRECTION, because the legs sit on
     opposite sides of spot. A long signal wants deep-in-the-money calls *below* spot; a short
     signal wants deep-in-the-money puts *above* it.
   - **Always fetch both calls and puts** across that window, whichever way the signal points.
     Both sides are needed even for a one-directional trade, because the at-the-money straddle
     is what supplies the expected move every structure is ranked against.
   - **Without a call AND a put near the money there is no straddle, no expected move, and
     that expiry is skipped entirely.** If a symbol keeps producing no trade, check both sides
     arrived.
4. **Do not pre-filter on delta, spread or price yourself.** The engine applies the real
   gates — liquidity on every leg, budget, and profitability at the expected move — and
   filtering first would quietly bypass rules that were reviewed.

Budget: roughly 120–150 contracts per requested symbol now that both sides are fetched. That
is the cost of comparing expiries and structures properly; the book still takes at most two
entries a month, so it is paid rarely.

### 4. Write the payload and run
Write the JSON to a **temp path outside the repo** — `"$TMPDIR/options-payload.json"` or the
session scratchpad. **Never the repo root:** the scheduled job runs from a machine-managed
checkout that is reset and cleaned every run, and a stray file there is either wiped without
warning or quietly accumulates. Quotes go in **Robinhood's own shape**; the script derives the
OCC key and rejects anything that does not round-trip:
```json
{
  "account": { "accountNumber": "685528705", "type": "limited_margin", "optionLevel": "option_level_2",
               "cash": 500, "buyingPower": 500, "optionsValue": 0, "totalValue": 500 },
  "underlyings": { "IREN": 46.93 },
  "quotes": [ { "symbol": "IREN", "expiration": "2026-11-20", "strike": 37, "type": "call",
                "bid": 11.4, "ask": 11.6, "bidSize": 10, "askSize": 5,
                "quoteTs": "2026-09-09T20:14:58Z", "delta": 0.78, "theta": -0.05,
                "iv": 0.97, "dayVolume": 120 } ],
  "chainsFulfilled": ["IREN"]
}
```
Then:
```bash
node --env-file=.env.local --import tsx scripts/options-rh-agent.ts ingest "$TMPDIR/options-payload.json"
```
This writes the quotes and then runs **the same scan the daily cron runs**, so a chain
filled now can open a position now. Report what it prints: quotes written, resolved, opened,
refused.

## Read budget
About 2 + (3 × open POSITION LEGS — a spread counts as two) + (4–6 × chain requests). Concurrency is capped by the
model at 3 open positions per sleeve, so a normal run is well under 40 calls. **If a run
would exceed ~80, do the open positions and skip the chain requests** — they survive for
three days and the next run picks them up.

## When something breaks
- **Robinhood auth failed / MCP not connected** → do not retry in a loop. Report that the
  session needs `/mcp robinhood` re-authentication and stop. The page's red staleness banner
  is the correct visible failure.
- **500 / "context deadline exceeded"** on an instruments query → that endpoint is slow on
  deep queries. Retry once, then skip that symbol; the chain request stays pending.
- **A chain request sitting for days** → the agent is not running often enough. Say so.
- **Quotes stale > 36 hours** → the book refuses them by design: positions stop marking and
  nothing can open. This is a real incident, not a quiet market. Say so plainly.

## What the book can open
**Four sleeves, two directions, two sizes** — `opt-3.5k`, `opt-5k` (long) and `opt-3.5k-bear`,
`opt-5k-bear` (short). Each is an independent experiment with its own entry cap, its own book
caps and its own verdict; a sleeve only ever sees signals of its own direction, so a bearish
result can never be pooled into the bullish record.

- **Long signal** — a new 50-session HIGH while above the 200-day average. Shapes: long
  in-the-money call, call debit spread, put credit spread. Exits on a 25-session low.
- **Short signal** — the exact mirror: a new 50-session LOW while BELOW the 200-day average.
  Shapes: long in-the-money put, put debit spread, call credit spread. Exits on a 25-session
  high.

Same numbers, opposite sign, so if the short rule fails it fails as a fair test of the mirror
rather than of a differently-tuned rule. A name cannot be at a 50-session high and low on the
same day, so the two never collide.

The engine compares every listed expiry in the 60–120 day window, each against its own
expected move, and takes the best return on capital at risk — judged at spot MINUS the
expected move for a short signal. "Nothing qualifies" is a normal answer.

⚠️ **The short book is UNVALIDATED and expected to be the harder half.** This desk's crypto
record found the mirrored short signal lost on every slice, and 22 of 39 names are usually
above their 200-day average, so it will sit idle much of the time. It runs in paper precisely
because that is where an unvalidated idea belongs — and it is kept in its own sleeves so it
cannot contaminate anything.

## What the record means
30+ resolved, positive net, t ≥ 2, across 7+ distinct days — same bar as every other desk.
At two entries per sleeve per month this is roughly **15 months** to a verdict, and the page
says so. "Gathering" for a long time is the measurement working, not stalling.

## How this runs unattended
A launchd job (`scripts/com.esbueno.options-desk.plist`, installed at
`~/Library/LaunchAgents/com.esbueno.options-desk.plist`) runs
`scripts/options-desk-run.sh` **weekdays at 17:32 local** — after the 16:00 close so the
daily bars are settled and the option quotes are the day's real closing marks. Running
before the open returns the PREVIOUS session's quote, which is stale by a day.

The runner drives `claude -p` with a tight `--allowedTools` list (the Robinhood **read**
tools plus the two script invocations) and an explicit `--disallowedTools` list naming every
Robinhood order tool. That allowlist, not this document's prose, is what actually prevents
an unattended session from placing an order.

It runs from a **dedicated checkout at `/Users/user/trading-rh-options`**, not the main working
tree — that tree belongs to interactive sessions and usually carries dozens of uncommitted
money-path files, which a scheduled job must never depend on or disturb. The checkout is
fast-forwarded to `origin/main` and cleaned BEFORE the runner is invoked (before, so a script is
never replaced while bash is still reading it). If the update fails the run proceeds anyway:
marking open positions and checking their stops matters more than being current.

Log: `~/Library/Logs/options-desk.log`. Manage with:
```bash
launchctl print gui/$(id -u)/com.esbueno.options-desk     # state, run count, last exit
launchctl kickstart -p gui/$(id -u)/com.esbueno.options-desk   # run once now
launchctl bootout gui/$(id -u)/com.esbueno.options-desk   # stop it
```
The runner exits cleanly with a logged `[skip]` if the Robinhood port is not present in
`/Users/user/trading`, so it is safe to install before the PR merges.
