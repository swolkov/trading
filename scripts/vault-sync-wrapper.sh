#!/bin/bash
# Wrapper for launchd — sources env from .env.local and runs vault sync.
cd /Users/user/trading || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
# Read DATABASE_URL from .env.local (NEVER hardcode the credential here).
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')"
[ -z "$DATABASE_URL" ] && { echo "DATABASE_URL not found in .env.local" >&2; exit 1; }
npx tsx scripts/vault-sync.ts >> /tmp/vault-sync.log 2>&1
