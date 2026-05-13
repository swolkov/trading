#!/bin/bash
# Wrapper for launchd — sources env and runs vault sync
cd /Users/user/trading
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
export DATABASE_URL="postgresql://neondb_owner:npg_tkvK5BwNfp9D@ep-jolly-field-anjir64r-pooler.c-6.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require"
npx tsx scripts/vault-sync.ts >> /tmp/vault-sync.log 2>&1
