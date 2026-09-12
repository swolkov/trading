# Trading readiness audit, September 12, 2026

Read-only checks at approximately 17:35–17:45 UTC, against production DB, Railway runtime logs and the production admin. No orders, arming changes or risk changes were made.

## Kraken

Production DB and Live Desk agree: auto=true, validate-only=false, swing-pyr selected, one slot. Existing sizing remains 4% base / 8% high conviction. No open position displayed. Scanner heartbeat 17:37:49, guardian 17:40:00, trade sync 17:35:03 UTC. This confirms running machinery, not profitable strategy performance. Automatic risk growth remains held pending verified financing and current-campaign profitability.

## Robinhood options

$1,500 latest verified broker snapshot, $100 approved loss ceiling. Research collector works. Options paper remains retired and options_live_armed=false. Native connection credential file absent; a fresh broker consent page was opened for Spencer. Its broker scopes include all-account reads and agentic-account trading; the installed client permits reads only. Integration verification, verified fee reserve and guardian-health config are unset. Fill reconciliation, exit/guardian implementation and event coverage remain prerequisites. Consent alone does not enable live execution.

## Tradovate futures

trading_mode_futures=paper, futures_mode=demo. Railway has no active deployments for either futures engine. Last paper heartbeat August 31 14:33:03 UTC; last live heartbeat August 31 14:35:06 UTC. Recent engine logs end with Stopping Container. Historical live_quotes timestamps remain August 25.

Demo authentication with existing Railway credentials succeeded (HTTP200), and /account/list returned an active demo account. No demo orders were submitted. The Databento sidecar is running but its current log says: "User authentication failed: A live data license is required to access GLBX.MDP3." This is not a weekend closure issue. Do not restart a trading engine and claim it works until data entitlement and quote delivery are verified. Live futures remain unauthorized.

Databento's current activation workflow requires a qualifying plan and the dataset license questionnaire. Subscriber status and actual use determine pricing and terms. TradingView chart access does not establish entitlement for this server's Databento API connection.

Sources: https://databento.com/docs/portal/live-data and https://tradovate.zendesk.com/hc/en-us/articles/4408926673171-How-Do-I-Connect-My-Tradovate-Account-to-TradingView

## Admin correction

System Health now includes paper-only futures configuration, paper/live heartbeat reporting, a 75-second process-lease view, separately reported entry authorization, and raw data-source telemetry. Stale/future/malformed heartbeats cannot appear ready. Disabled and unknown modes remain distinct from paper. Source names are not colored as proof of data entitlement. The top status explicitly identifies Kraken so it cannot imply Robinhood is live.

Seven focused offline tests cover these distinctions. Production build and independent reviews are required before release. This health display does not connect a broker, enable execution, certify a license, or establish a profitable strategy.
