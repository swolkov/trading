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

For each open position (Robinhood identifies contracts by symbol + expiry + strike + type,
never by OCC):
1. `get_option_chains` with `underlying_symbol` → chain `id`.
2. `get_option_instruments` with that `chain_id`, `expiration_dates` = its expiry,
   `strike_price` = its strike, `type` → the instrument UUID.
3. `get_option_quotes` on those UUIDs, batched ≤ 20.

For each entry in `chainRequests`:
1. `get_option_chains` → the expirations inside `[expiryFrom, expiryTo]`.
2. `get_option_instruments` per matching expiry, `type: "call"`, following `next` only until
   the strikes span `[strikeMin, strikeMax]`.
3. `get_option_quotes` on those strikes, batched ≤ 20. Cap at ~60 contracts per symbol; if
   the window holds more, keep the ones nearest **0.80 × spot** — the 0.70–0.85 delta band
   the model selects from sits there. **Do not pre-filter on delta or spread yourself**;
   `pickContract` applies the real gates and skipping them would bypass the review.

### 4. Write the payload and run
Write JSON to the scratchpad — quotes in **Robinhood's own shape**; the script derives the
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
node --env-file=.env.local --import tsx scripts/options-rh-agent.ts ingest <payload.json>
```
This writes the quotes and then runs **the same scan the daily cron runs**, so a chain
filled now can open a position now. Report what it prints: quotes written, resolved, opened,
refused.

## Read budget
About 2 + (3 × open positions) + (4–6 × chain requests). Concurrency is capped by the
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

## What the record means
30+ resolved, positive net, t ≥ 2, across 7+ distinct days — same bar as every other desk.
At two entries per sleeve per month this is roughly **15 months** to a verdict, and the page
says so. "Gathering" for a long time is the measurement working, not stalling.
