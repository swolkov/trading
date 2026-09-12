# Direct Robinhood collection and execution readiness

## Verified direct access

Spencer completed OAuth consent on September 12. The native read-only client successfully initialized the official MCP connection, listed 73 tools and read the configured account. The actual account was active, Level 3, with $1,500 cash, buying power and value, no positions and no orders. Credentials remain on the Mac outside the repository and production DB.

The direct collector now replaces the AI-driven account-snapshot runner. It reads the complete paginated account orders and open positions, resolves held contracts by exact option ID, preserves pending buy/sell/exercise/assignment/expiration activity, validates balances and saves account, positions/orders and connection status in one transaction. A failed page, malformed payload, mismatched contract, conflicting duplicate or collection deadline failure leaves prior snapshots unchanged. It has no order review, placement, cancellation, exercise or live-arm path. The existing weekday after-close cadence remains an account snapshot job, not a position guardian.

The launchd checkout update now uses fetch plus fast-forward merge, preserving uncommitted and untracked files. The previous reset/clean instructions were removed.

## Concrete execution blocker

The actual broker tool catalog accepts ref_id as a place_option_order input. However, the published placement and order-list output schemas do not include ref_id, and get_option_orders has order_id lookup but no ref_id filter. The current local executor requires exact reference correlation, particularly when the placement response is lost. The adapter cannot simply assert verification or invent the missing identity. A broker-supported recovery design and verification are still necessary; matching only contract and time is not sufficient ownership proof.

Capability inspection rejects missing or unsupported schema structures rather than treating them as proof that fields are absent. A hash identifies the catalog checked; no credentials or other-account payloads are persisted in capability status. Connection checks are separate from execution readiness.

Fill lifecycle and verified automatic exits remain unfinished. The macro calendar is unavailable in production, and fresh market-session quotes are unavailable on this Saturday. The live adapter must enforce every entry rule, event gate and actual broker fee requirement before any later user-controlled activation. This release does not implement or activate those money-moving paths and does not claim profitability.

## Validation

32 focused offline tests passed: direct collector 12, executor core 18 and retirement 2. A production webpack build includes TypeScript; targeted lint, shell syntax and plist validation also pass. Both independent reviewers approved after fixes. Actual direct broker collection succeeded with the latest code. No broker order was submitted or reviewed, no risk limit was changed and options_live_armed remains false.
