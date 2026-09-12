# Broker safety repair, September 12, 2026

Working branch: `codex/broker-safety-20260912`, based on production commit `cc56dec`.
Working checkout: `/private/tmp/trading-broker-safety-20260912`.
No commit, push, merge or deployment performed. Other checkouts' uncommitted work was preserved.

## Operational changes already made

- Switched the configured Kraken sleeve from `swing-wide` to `swing-pyr` on Spencer's instruction, preserving risk and limits.
- Subsequently paused **new Kraken entries** with `kraken_margin_auto=false` after reproducing stop-replacement and pyramid-recovery defects. Config readback confirmed the pause. `swing-pyr` and the existing 4% base / 8% high-conviction risk remain configured. The guardian remains enabled. Latest account inspection was flat with no margin orders.
- Set the futures desk to paper, and verified Tradovate demo authentication and an active demo account with no exposure. Both futures engines remain stopped. The Databento feed rejects authentication because a GLBX.MDP3 live-data license is required. Paper trading is not operational until data access and the demo engine are restored and verified.
- Verified the Robinhood Agentic account has Level 3 options permission, $500 buying power and no exposure at inspection. Existing scheduled options collection and paper scans were operational. No live options order was reviewed, placed or cancelled.

## Kraken repair in this branch

- Serialize private API requests across processes, preserve accepted responses through database failures, and record exact reduce-only stop receipts.
- Require a replacement stop ID before cancelling prior protection. Failed cancellations and unsettled pyramid additions cannot be reported as verified coverage.
- Recover pyramid ownership only from an exact transaction/parent match. Preserve protection when acceptance or ownership is uncertain. Lock final submission and ledger recording against concurrent closes.
- Reserve daily entry attempts before broker submission; missing/corrupt counters refuse entries. Unknown acceptance cannot bypass the daily limit.
- Allocate closing fees correctly across parent/add lots and partial reversals. Include positive posted USD margin/rollover costs in the daily entry breaker; unknown non-USD financing blocks entries.
- Freeze paper sizing at entry. Missing quotes cannot fabricate a time exit. Missing risk configuration, incomplete scans and truncated shadow reads block live entry assessment.
- Use frozen size in live/paper comparison and propagate failed ownership/demotion evidence. Hold automatic risk increases until complete financing and current-campaign profitability are verified.

Historical financing attribution and strategy profitability are not certified by these repairs. Offline tests cannot certify production broker behavior or database concurrency. Keep entries paused until the reviewed changes are shipped and production protection, accounting and configuration are checked.

## Options work

See `ROBINHOOD-LIVE-EXECUTION.md` for the six supported structures, tool boundary and activation requirements. This branch adds a disconnected execution policy/core, not a live trading service. Long calls, long puts, and all four defined-risk vertical spreads are covered. No strategy is claimed to maximize profits.

Maximum dollar loss remains unset pending Spencer's answer. Production OAuth transport, verified response decoders, durable storage/ownership, position monitoring and cancellation/assignment handling remain outstanding. Level 3 permission alone does not supply these components or a loss budget.

## Validation

Final validation: 289 consolidated offline tests passed, including 16 options execution tests. TypeScript, targeted ESLint, whitespace checks and the production webpack build passed. The final options fixes were followed by a fresh consolidated test run, TypeScript and lint checks. The first build failed because sandbox DNS could not fetch Google Fonts; the network-approved retry passed. A separate existing options snapshot integration test failed with `connect EPERM 127.0.0.1:9` because this isolated checkout deliberately has no test database. It was excluded from the offline suite; no production database was used for tests. Database integration and live broker acceptance checks remain outstanding.

Commit/push require Spencer's request under the supplied AGENTS.md instructions. Review deployment separately from live rearming.
