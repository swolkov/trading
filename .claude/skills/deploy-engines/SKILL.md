---
name: deploy-engines
description: The safe engine deploy ritual for both Railway engines — every step exists because skipping it once cost real money or shipped stale code. Use for ANY engine deploy.
---

# Engine Deploy Ritual

## Rules first
- **Push does NOT deploy either engine.** Both need explicit redeploys.
- **`railway redeploy` without `--from-source` REBUILDS THE PREVIOUS COMMIT** — fresh timestamp, stale code. This shipped a live out-of-envelope trade on Jul 28.
- **Market hours: deploy after 4 PM ET** unless Spencer explicitly says now ("Deploy when Spencer says" overrides).
- Typecheck BEFORE deploying: `npx tsc --noEmit -p tsconfig.json` must exit 0.
- Engines only need a deploy if `src/` changed: `git diff --stat <deployed-commit> HEAD -- src/` — empty diff = no deploy owed (scripts/ is research, not engine code).

## The sequence

```bash
railway redeploy --from-source -s futures-engine-live -y
railway redeploy --from-source -s futures-engine -y
# wait for terminal state — poll deployment list, NOT sleep
until railway deployment list -s futures-engine-live 2>/dev/null|head -2|tail -1|grep -qE "SUCCESS|FAILED"; do :; done
until railway deployment list -s futures-engine 2>/dev/null|head -2|tail -1|grep -qE "SUCCESS|FAILED"; do :; done
```

## Verify the RESTART, not the timestamp

```bash
railway logs -s futures-engine-live 2>&1 | grep -E "Starting Container|Mode:|\[EDGES\]|STARTUP" | tail -4
```
Must see: fresh `Starting Container`, correct `Mode:`, the expected `[EDGES] N registered` count (count is the tell for new edges), and `[STARTUP] Loss-limit baseline restored` + `Tilt state restored` (proves state survived).

## After
- Admin (Vercel) auto-deploys on push — verify with `vercel ls --yes` → latest Production ● Ready.
- Report deployment IDs + the verified log lines. Never report "deployed" from the redeploy command alone.
