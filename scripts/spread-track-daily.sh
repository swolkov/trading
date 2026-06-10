#!/bin/zsh
# Daily forward-track of the validated spread edge. Pulls latest Databento bars (included → $0),
# re-runs the forward eval, appends a row to reports/spread-track-record.csv. Run by launchd ~5pm.
# Include npm-global (railway CLI) + homebrew so the scheduled `railway run` review resolves under launchd.
export PATH="/Users/user/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/user/trading || exit 1
npx tsx scripts/spread-track.ts --refresh    # refresh daily data + bank the metrics ledger row
npx tsx scripts/spread-paper-trade.ts        # advance the $50K spread paper account on the fresh data
npx tsx scripts/spread-shadow.ts             # capture REAL bid/ask fills on new signals → fill-certainty ledger
railway run npx tsx scripts/fable5-system-review.ts  # Fable 5 head-of-desk on clean prod-DB data → Brain/system-review.md
