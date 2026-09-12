# Options paper retirement and live loss authorization

Spencer authorized a maximum $100 loss per options trade, including fees, and requested removal of options paper trading on September 12, 2026. This is a loss ceiling, not a promised return. Live options remain inactive until the broker adapter, durable tracking and guardian are finished and verified.

Production settings recorded: `options_live_max_loss_usd=100`, `options_live_armed=false`, `options_paper_autotrack=false`, `options_paper_enabled=false`.

This change removes options simulations from the dashboard, sidebar, account page, unified orders and system health. `/options/paper` redirects to the real account; its API returns 410. Historical database rows are retained as an archive, with no continuing marking or simulated settlement. Kraken and Tradovate paper policies are unaffected.

The options cron is removed. Legacy calls to the shared scan, direct paper opening and paper evaluation return before database or market-data work. The existing weekday 17:32 local collector keeps refreshing the real account with broker read tools only; its new prompt and allowlist no longer request paper worklists, chains or scans. Ingest rejects the wrong account, missing collections, failed pagination confirmations and malformed account/position/order rows before saving anything. The installed launchd job refreshes its dedicated checkout before running this script.

The real account, dashboard and top bar continue to show actual account snapshots and explicitly label live execution inactive. The approved dollar cap is read from configuration; an unavailable value displays as unset. Existing execution tests verify the cap includes fees.

Validation: 19 focused tests passed, covering retired entry points with no database and the $100 fee-inclusive boundary. TypeScript, targeted lint, shell syntax and production build checked before publication. Broker acceptance testing is not part of this retirement change.
