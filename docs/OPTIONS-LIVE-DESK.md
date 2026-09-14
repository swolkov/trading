# Options live desk — Robinhood, real money, one contract (Sep 13 2026)

Spencer: "go live Monday and keep learning… you do it all, that's why it's agentic." This is that desk.
It places real options orders on the Robinhood account, one contract at a time, inside the approved
**$100 maximum loss per trade including fees**, debit structures only. It runs on the Mac (the OAuth
credential lives there; Vercel never holds it) and reports to the admin like the other two desks.

## The pieces

| Piece | File | Job |
|---|---|---|
| Trade client | `scripts/robinhood/client.ts` → `RobinhoodTradeClient` | The ONE connection that may call `review_option_order`, `place_option_order`, `cancel_option_order`. The collector and research sessions keep the read-only class. Account pinned. |
| Broker adapter | `src/lib/options-live-broker.ts` | Snapshot (account, positions, orders, fresh quotes), review/placement decoders, ref_id binding, lost-response recovery (see below). |
| Core | `src/lib/options-live-executor.ts` + `options-live-policy.ts` (Codex, Sep 12) | review → durable reservation → place → reconcile, under the account lock; every limit enforced before any call. Unchanged except a `createdAtMs` stamp on intents. |
| Store | `src/lib/options-live-store.ts` on `DATABASE_URL_UNPOOLED` | Intents + owned positions, session advisory lock, autocommitted. |
| Guardian rules | `src/lib/options-live-guardian.ts` | Pure: exit rules, drawdown halt, executable prices. |
| Runner | `scripts/robinhood/live-desk.ts` `guard | entry | probe` | Every 5 min in the session: reconcile intents, ingest fills into ownership, manage exits, cancel stale entries, drawdown halt, stamp `options_live_guardian_ok_at`. On `entry` ticks (:05/:35): at most one entry a day from the research screen, re-priced on quotes fetched that second. |
| Schedulers | `scripts/com.esbueno.options-live-guard.plist` (StartInterval 300), `scripts/com.esbueno.options-live-entry.plist` (:05/:35, 09–15 h weekdays), `scripts/options-live-run.sh` | Install once: copy both plists to `~/Library/LaunchAgents/` and `launchctl bootstrap gui/$UID <plist>`. They fast-forward `/Users/user/trading-rh-options` from `main` before each run. |
| Admin | `/options` → Live desk panel (typed **ARM** / Disarm, state, probe, intents, log); `/api/options/live-desk`; System Health rows; Orders → Robinhood segment | The switch the runner reads on every tick. |

## Rules in force (`OPTIONS_LIVE_RULES`)

Debit structures only (long call, long put, call/put debit spread) so max loss = premium paid + fees ·
one contract · one open position · one entry per day · no entries in the last 30 minutes · premium
stop at 50% of entry · target at 2× entry · out 7 days before expiry · unfilled entry cancelled after
15 min · account value $300 under its high-water mark → desk disarms itself (positions stay managed).
Entry signal = the research screen's 20-session breakout/breakdown with 50/200-day alignment, on the
day's broker bars; the structure is chosen by the screen and re-priced on live quotes.

## How the first live order happens (Monday Sep 14)

1. Spencer types **ARM** on the Live Account page (sets `options_live_armed=true`, fee reserve $2 if unset).
2. 09:35 ET entry tick: adapter unverified → the desk runs a **review only** on the top candidate (or,
   with no signal, on the cheapest quality-passing debit spread). It must decode fees and buying
   power from the real response. Success sets `options_live_integration_verified=true` and pages Slack.
3. 10:05 ET tick onward: if a candidate fits the cap on live quotes, the core reviews and places
   **one contract**. Fills page Slack; the guardian takes over.
4. If nothing fits, nothing trades. That is the rule working, not the desk broken.

## The lost-response problem, solved the broker's way

Robinhood accepts `ref_id` on placement but never returns it. The adapter binds our ref_id to the
broker order: on the placement response (same call), then by the saved broker order id. Only for a
LOST placement response does it match an order Robinhood labels `placed_agent="agentic"`, created
inside the intent's window, with exactly our legs/quantity/price. Nothing else on the account places
agentic orders and the store allows one unsettled intent at a time, so one such order is ours; two
are ambiguous and the intent stays `unknown` — the desk refuses new entries until a human resolves it.

## Operating

- Log: `~/Library/Logs/options-live.log`; the admin shows the last 40 lines and every intent.
- Disarm: the button, or `options_live_armed=false`. Takes effect within 5 minutes; never touches an open position.
- An `unknown` intent: check the Robinhood app for the order, then either mark the intent settled (no order) or set its `order.id` (order exists) in `options_live_intents`. The desk will not trade past it by itself — by design.

## Railway worker (Sep 14 2026) — the desk leaves the laptop

Service **options-desk** in Railway project `futures-engine` (service id 866dd190-3f2f-437b-abf1-daf99ef58d41),
built from `Dockerfile.options-desk`, running `scripts/robinhood/desk-worker.ts`: every minute it asks
`src/lib/options-desk-schedule.ts` what is due (guard every 5 min 09:30–16:05 ET, entry :05/:35
09:35–15:35, account snapshot 17:32) and runs it in-process. Variables: `OPTIONS_DESK_WORKER`
(`on`/`off`), `ROBINHOOD_AUTH_DIR=/data/robinhood` (volume `options-desk-credential` at `/data`),
`DATABASE_URL`, `DATABASE_URL_UNPOOLED` (the account lock needs a direct connection),
`RAILWAY_DOCKERFILE_PATH=Dockerfile.options-desk`. Deploy with `railway up --service options-desk`
from a checkout of main (the `railway volume` CLI subcommand panics; use the Railway MCP/dashboard).

**Cutover from the Mac — do it OUTSIDE the session, in this order, once.** Robinhood rotates the
refresh token on every use, so exactly one consumer may hold the credential.
1. Unload the Mac jobs: `for l in options-live-guard options-live-entry options-desk; do launchctl bootout gui/$(id -u)/com.esbueno.$l; done`.
2. Copy `~/.config/esbueno-robinhood/oauth.json` to the volume as `/data/robinhood/oauth.json` (Railway dashboard → service → volume → files, or a one-off `railway ssh`). Mode 0600. Delete any stale `session.lock` there.
3. `railway variables --service options-desk --set OPTIONS_DESK_WORKER=on` (the worker reads it per tick after a redeploy; redeploy to be safe).
4. Watch the deploy logs: the next scheduled tick should log `guard tick … ET` and the admin's Live desk panel should show the guardian reporting. If a tick logs "Robinhood direct connection is not authorized", the credential copy failed — stop the worker and re-copy before re-enabling the Mac jobs.
The research sessions (`options-market-run.sh`, `claude -p`) stay on the Mac: they use Claude's own Robinhood login.
