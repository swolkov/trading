# Robinhood Level 3 execution core

Status: maximum loss of $100 per options trade including fees authorized by Spencer on September 12 and stored in `options_live_max_loss_usd`. Options paper trading is retired. See ROBINHOOD-OPTIONS-DESK-2026-09-12.md for the research desk, direct OAuth client and durable-store foundations. Offline execution policy and orchestration implemented; **not connected, armed, scheduled, or deployed for live trading**. The scheduled options runner now collects real account snapshots only. Its broker allowlist remains read-only. No broker order was reviewed, placed, or cancelled during implementation.

The connected-account inspection supplied to this implementation identified account `685528705` as active, Agentic, `agentic_allowed=true`, `option_level_3`, `limited_margin`, with $500 options buying power. This is an observed snapshot, not a permanent balance or authorization for a particular loss amount. The core pins the account identity and requires a fresh complete broker snapshot each time. Maximum loss and a round-trip fee reserve must be explicitly supplied; there is no dollar-risk default.

## Supported structures

`src/lib/options-live-policy.ts` validates broker option identities, contract metadata, bid/ask quotes, account permissions and a verified regular market session.

| Structure | Existing kind | Opening geometry | Maximum contractual loss before fees |
| --- | --- | --- | --- |
| Long call | `long_call` | Buy call | Limit debit × 100 × quantity |
| Long put | `long_put` | Buy put | Limit debit × 100 × quantity |
| Call debit spread | `call_debit` | Buy lower strike, sell higher | Limit debit × 100 × quantity |
| Put debit spread | `put_debit` | Buy higher strike, sell lower | Limit debit × 100 × quantity |
| Put credit spread | `put_credit` | Sell higher strike, buy lower | (Width − limit credit) × 100 × quantity |
| Call credit spread | `call_credit` | Sell lower strike, buy higher | (Width − limit credit) × 100 × quantity |

Spreads use one atomic two-leg order, same underlying, option type and expiry, one contract per leg per unit. The core preserves the selected legs and derives debit/credit direction from their geometry. It rejects naked shorts, calendars, duplicate contracts, adjusted multipliers, noninteger quantities and invalid prices. Contract metadata must come from verified broker instrument lookups, not a ticker or OCC label alone. This core does not select strategies or establish profitability.

## Entry and close policy

New entries require explicit live arming, maximum loss and a positive round-trip fee reserve; a successful account guardian check within 60 seconds; and a complete broker snapshot with every leg's quote within 15 seconds. Future timestamps fail. Existing positions, outstanding broker orders and unresolved durable submission reservations block entries.

Maximum contractual loss plus the fee reserve must fit both the authorized maximum loss and current buying power. Broker review must match the exact requested order and fit these limits. Policy, ownership and the broker snapshot are reread after review, so a disarm or position change can still prevent placement. Orders are limit-only, `gfd`, `regular_hours`; expiry-day entry is excluded.

Disarming stops entries while allowing a whole-position close of an explicitly owned position, with the exact remaining contracts, sides and quantity independently matching broker exposure. Manual positions cannot be closed. A close does not require the entry loss cap or a healthy guardian, but still requires a fee budget, fresh quotes, regular-session execution and broker review. Expiry-day closes remain possible. An opening vertical limit must stay below its width; an owned close may equal the full width when broker review approves it. This is not an emergency market-flatten mechanism.

## Tool and response boundary

`src/lib/options-live-executor.ts` uses an injected broker interface and constructs the discovered inputs:

- `review_option_order`: `account_number`, `legs[{option_id,side,position_effect,ratio_quantity}]`, positive integer-string `quantity`, `direction`, `type=limit`, string `price`, `time_in_force=gfd`, `market_hours=regular_hours`.
- `place_option_order`: the same fields plus UUID `ref_id`.
- Discovered cancellation tool: `cancel_option_order`, with `account_number` and `order_id`. Cancellation orchestration is outstanding guardian work.

Optional review-only `chain_symbol` and `underlying_type` are omitted. They are never sent to placement. Actual tick-size and collateral restrictions must pass broker review; cent formatting does not establish every contract's valid tick.

Real response schemas have not been captured and verified. **No production response decoder is installed.** The injected broker must set `responseSchemasVerified=true` only after validated adapters exist. Otherwise execution and reconciliation refuse. Unit tests use explicit fake normalized responses, not claimed Robinhood raw responses.

The adapter must normalize review responses into the actual account, a fingerprint reconstructed from reviewed legs/quantity/price/direction, review time, approval, maximum loss before fees, estimated fees and buying-power requirement. Order responses must supply actual account, exact `ref_id`, broker order ID, reconstructed request fingerprint, state and executed quantity. A decoder must never copy requested identity fields into an unknown response merely to pass checks.

A complete snapshot requires successful pagination of all positions and active orders, plus historical lookup for the requested UUID. Empty, truncated or failed responses cannot establish completeness. Metadata, timestamps, permissions and market-session boundaries must be verified, including holidays and early closes.

## Durable submission and recovery

Before placement, the core stores account, UUID, action and fingerprint as `submitting`. Production storage must persist across restarts and lock the account across every process that can submit. Its lock must not expire while the callback can still place an order. The in-memory store in unit tests is never a production implementation.

A timeout, unknown response or post-submission persistence error retains the reservation. The same UUID is never submitted again. A new UUID cannot bypass unresolved risk. Recovery requires exactly one broker order matching saved UUID, account and fingerprint. Zero results, duplicates or mismatched identities remain unknown. It never adopts a trade based on ticker, timing or a possibly manual position.

A rejected/cancelled order releases its reservation only when reconciliation confirms zero fills. Cancellation with fills retains it. Reconciliation binds to the already-known broker order ID and preserves the highest observed fill count; a later lower count or conflicting ID marks the intent unknown and cannot release its reservation. Filled entries and closes stay reserved until a separate verified guardian records the position lifecycle. That guardian must derive durable ownership from confirmed fills, handle partial fills and positions, and release reservations only after settlement is verified. This core does not invent that evidence or automatically clear a timeout.

## Required before live activation

1. Enforce the approved $100 total maximum loss from configuration. Establish a conservative round-trip fee reserve from verified broker fees inside that limit. Keep live arming false until the integration checks below pass.
2. Implement the authorized OAuth/client adapter and durable store. Preserve the snapshot collector's read-only allowlist until a separate integration is reviewed.
3. Capture and verify real review, placement, cancellation, lookup, position, contract, quote and session responses. Test malformed responses, lost responses, pagination and stale data.
4. Implement live monitoring, ownership ingestion and account-wide locking. Cover stale-order cancellation, partial fills, exits, expiry, exercise/assignment, missing legs and lost data. Assignment can create underlying exposure; contractual spread payoff is not a guarantee against additional operational exposure or costs.
5. Reconcile broker fees, collateral and review amounts against this policy for each structure. Use broker-supported nonfunding review/simulation where available. The offline test broker is not a Robinhood paper account.
6. Independently review the integration and perform explicitly authorized acceptance checks before enabling live entries. Account approval, strategy evidence and live-risk authorization are separate requirements; no profitability promise is made.

## Offline tests

`node --import tsx --test tests/options-live-executor.test.ts` requires no credentials or database. It covers all six structures, fee-inclusive sizing, stale/invalid reads, ownership, review-time disarm, unknown responses, durable-write failures, exact UUID recovery and concurrent entry exclusion. Broker compatibility remains unverified until the integration checks above are complete.
