#!/bin/zsh
# Daily Morning Brief — runs ~9:25 AM ET (just after the 9am premarket cron writes today's regime +
# AI daily plan). Consolidates regime + plan + chronicle analogues + key levels + SVG charts into
# Brain/morning-brief.md. Include npm-global (railway CLI) + homebrew so `railway run` resolves under launchd.
export PATH="/Users/user/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/user/trading || exit 1
railway run npx tsx scripts/morning-brief.ts
