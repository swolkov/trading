---
name: engines-health
description: Full verified health check of both trading engines, config, data feeds, and admin — the exact protocol, with every known trap baked in. Run at session start and whenever Spencer asks "is everything working."
---

# Engines Health Check — verified, never assumed

Run ALL of these. Report what the systems SAY, never what you expect.

## 1. Engines + config + market data (one script)

```bash
cat > scripts/_health.ts <<'TS'
import { prisma } from "../src/lib/db";
(async () => {
  const c: Record<string,string> = {};
  for (const r of await prisma.agentConfig.findMany()) c[r.key]=r.value;
  for (const m of ["live","demo"]) {
    const h = JSON.parse(c[`futures_engine_heartbeat_${m}`]||"{}");
    const age = Math.round((Date.now()-Date.parse(h.timestamp||h.ts||h.at||0))/1000);
    console.log(`${isFinite(age)&&age<300?"●":"✗"} ${m.toUpperCase()} eq $${h.equity} | risk $${h.riskPerTrade} | pnl $${h.dailyPnl} | md ${h.mdHealth||h.md} | hb ${isFinite(age)?age+"s":"STALE"} | pos ${c[`futures_positions_${m}`]}`);
  }
  const eq = Number(JSON.parse(c["futures_engine_heartbeat_live"]).equity);
  console.log(`live TRUE P&L (balance delta): $${(eq-Number(c["starting_capital_live"])).toFixed(2)}  ← quote THIS, never ledger sums`);
  console.log(`risk ${c["live_futures_risk_per_trade_pct"]}% | daily cap ${c["live_futures_daily_loss_limit_pct"]}% | blackouts ${c["macro_blackout_dates"]}`);
  const q: any[] = await prisma.$queryRawUnsafe(`select symbol, ts from live_quotes where symbol in ('GC','NQ','ES')`);
  console.log(`md age: ${q.map(r=>`${r.symbol} ${Math.round((Date.now()-Number(r.ts))/1000)}s`).join(" · ")}`);
  await prisma.$disconnect();
})();
TS
railway run --service futures-engine-live npx tsx scripts/_health.ts; rm -f scripts/_health.ts
```

## 2. Engines actually RUNNING the expected build

```bash
railway logs -s futures-engine-live 2>&1 | grep "\[EDGES\]" | tail -1
railway logs -s futures-engine 2>&1 | grep "\[EDGES\]" | tail -1
```

## Known traps (each cost real money or a wrong report once)
- **Quotes stale 17:00–18:00 ET = CME daily halt — NORMAL.** Do not report an outage.
- **Config keys end in `_pct`** (`live_futures_daily_loss_limit_pct`). Querying without `_pct` returns "(default)" and produced a false "one loser ends the day" claim.
- **Deploy freshness is proven by "Starting Container" + Mode line in logs**, never by deployment timestamps (plain `railway redeploy` rebuilds the PREVIOUS commit).
- **Engine picks up config in ~5–10 min** — verify `riskPerTrade` in the heartbeat after risk changes; don't assume.
- Demo mode string is `"demo"` in ShadowTrade but `"paper"` in RoundTrip.
