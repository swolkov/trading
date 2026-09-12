# Options research evidence and account risk visibility

## Scope

Spencer confirmed a $1,500 options account and requested genuine strategy learning and risk management in admin. The broker account collector independently confirmed $1,500 cash, buying power and total value on September 12 at 17:13:41 UTC. The saved $100 maximum planned loss including fees remains unchanged. This release places no orders, activates no trading, restores no paper simulation and changes no Kraken or futures settings.

## Operational changes

The read-only research collector now discovers up to six additional $10–$100 underlyings from actual broker scanner results and verified equity quotes, alongside the six base symbols. It decodes oversized scanner responses in the calling process, then supplies validated ticker seeds to a separate read-only quote collection. It collects five nearby strikes for calls and puts, batching quote requests and reporting missing matched quotes explicitly. Current research retains at most six base symbols plus six discoveries; old discoveries belong in history. Scanner pages accumulate and deduplicate symbols instead of overwriting earlier pages. Earnings display follows the actual research universe.

Each successful collector import archives only the newly observed data, preserving actual option quotes, source timestamps, screening time, rule version/settings, account snapshot timestamp, risk ceiling and exclusion reasons. The dedicated `options_research_observations` table avoids adding a growing archive to engine configuration reads. Raw capture SHA identifies an import; replays cannot overwrite original observations or inherit a later collection's prices. Inherited data can remain in the bounded current display with its original source dates, but never becomes new archived evidence. The reader loads at most 120 collections; the UI shows the most recent 12. Historical records are retained.

Admin now shows account-based risk illustrations capped by the existing dollar ceiling, a five-full-loss comparison, contract affordability and screening failures, distinct observed quote counts, unique call/put setup sessions, collection history and performance-data gaps. Repeated quote timestamps and symbol/session/version signals count once. The percent range is advice, not an armed execution limit, and cannot update risk settings.

## Meaning of learning

This is collection and audit of real observations. It does not fit a model, automatically rewrite rules, promote a strategy, infer option returns from stock movements, invent fills or attribute deposits to profit. Account snapshots lack matched opening/closing executions, full actual fees, assignment/cash-flow reconciliation and pre-entry strategy attribution. Consequently realized performance, win rate, expectancy and trading drawdown remain explicitly unavailable rather than zero. Orders/positions in a snapshot are not a verified performance ledger.

The next performance milestone requires those actual broker fields and reconciliation. Historical evaluation requires actual option quote history and a separate evaluation period. Short samples are operational checks, not proof of profitability. Live execution still requires the previously documented broker connection, response verification, recovery, exits and calendar coverage.

## Validation

42 focused offline tests passed, including deposit handling, full-premium affordability, stale/future snapshot labels, shared screening gates, zero ask, scan pagination, raw capture replay after intervening data, bounded symbol rotation, deduplicated observations and missing-performance handling. Both independent reviewers approved after fixes. Tests that alter production trading snapshots were excluded. Production build, type/lint checks and real collector/admin readback are verified separately during release.
