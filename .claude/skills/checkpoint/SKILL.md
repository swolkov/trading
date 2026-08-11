---
name: checkpoint
description: The new-book 10-trade referee — decides whether live risk stays at 5% or steps back to 3%. Run when the new book (trades entered after 2026-08-10 19:45 UTC) approaches 10 round-trips, or when Spencer asks about risk sizing.
---

# New-Book Checkpoint (armed 2026-08-10)

**Rule** (stored in `live_risk_raise_rule`): the new book = live RoundTrips entered after
2026-08-10T19:45Z (edges: gold_long_europe, gold_short, index_overbought_short). At **10 trades**:
expectancy > 0 → **5% stays**. Expectancy ≤ 0 → **step back to 3%** and say so plainly.
Judge on EXPECTANCY (avg R), never win rate — a 60% win rate loses money at bad payoff.

```bash
cat > scripts/_ckpt.ts <<'TS'
import { prisma } from "../src/lib/db";
(async () => {
  const rt = await prisma.roundTrip.findMany({ where:{ mode:"live", entryTime:{gt:new Date("2026-08-10T19:45:00Z")} }, orderBy:{entryTime:"asc"} });
  const r = rt.map(t=>t.rMultiple).filter((x):x is number=>x!=null);
  const exp = r.length? r.reduce((s,x)=>s+x,0)/r.length : 0;
  console.log(`new book: ${rt.length}/10 trades · net $${rt.reduce((s,t)=>s+t.pnl,0).toFixed(0)} · expectancy ${exp>=0?"+":""}${exp.toFixed(3)}R`);
  console.log(rt.length>=10 ? (exp>0 ? "VERDICT: positive → 5% stays" : "VERDICT: non-positive → step risk to 3% (live_futures_risk_per_trade_pct)") : "not yet at 10 — no action");
  await prisma.$disconnect();
})();
TS
railway run --service futures-engine-live npx tsx scripts/_ckpt.ts; rm -f scripts/_ckpt.ts
```

If stepping down: upsert `live_futures_risk_per_trade_pct = "3"`, verify heartbeat `riskPerTrade` updates (~5–10 min), report.
