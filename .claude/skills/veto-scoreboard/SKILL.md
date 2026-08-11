---
name: veto-scoreboard
description: Read the engine-activity veto ledger (saved vs missed) and promotion radar with the CORRECT sign conventions. Run when Spencer asks about declined trades, "missed profits," or engine activity screenshots.
---

# Veto Scoreboard — the sign conventions that were misread twice in one day

## THE TWO CONVENTIONS (2026-08-10, commit 89586dd)
- **DB (`ShadowTrade.dollarPnl`) = RAW**: what the DECLINED trade would have made. Negative = would have lost = **gate saved money**.
- **Engine-activity feed UI = NEGATED** ("what blocking did for you"): 🟢 green/"saved" = good block · 🔴 red/"missed" = the veto cost a winner. **Spencer reads the feed — when he cites a screenshot number, it is the NEGATED one.**
- Rows with `status: "open"` are interim marks — only RESOLVED rows are decision-grade.

## The query (raw ledger, resolved only)

```bash
cat > scripts/_veto.ts <<'TS'
import { prisma } from "../src/lib/db";
(async () => {
  const start = new Date(); start.setHours(0,0,0,0);
  for (const mode of ["live","demo"]) {
    const v = await prisma.shadowTrade.findMany({ where:{ mode, resolvedAt:{gte:start}, dollarPnl:{not:null} }, select:{dollarPnl:true} });
    const saved = v.filter(x=>x.dollarPnl!<0).reduce((s,x)=>s-x.dollarPnl!,0);
    const missed = v.filter(x=>x.dollarPnl!>0).reduce((s,x)=>s+x.dollarPnl!,0);
    console.log(`${mode}: saved $${saved.toFixed(0)} · missed $${missed.toFixed(0)} → gate ${saved-missed>=0?"earned":"cost"} $${Math.abs(saved-missed).toFixed(0)} (${v.length} blocks)`);
  }
  await prisma.$disconnect();
})();
TS
railway run --service futures-engine-live npx tsx scripts/_veto.ts; rm -f scripts/_veto.ts
```

## Rules for interpreting
- One day's "gate cost $X" is NOT a verdict — categories are judged on their full resolved sums (the radar does this nightly at n≥50, t≥2).
- Screenshot timestamps: Spencer's machine is **GMT-7** — convert before querying windows.
- Before interpreting ANY UI number, read the component that renders it (`src/components/futures/engine-activity.tsx`).
