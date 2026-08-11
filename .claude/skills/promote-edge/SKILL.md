---
name: promote-edge
description: The evidence bar and exact steps for promoting an edge to live, demoting one, or arming a demo trial — the discipline that keeps unproven setups away from real money.
---

# Edge Promotion / Demotion Protocol

## The bars (pre-committed — do not negotiate mid-drawdown)
- **PROMOTE to live**: t-stat > 2 on REAL fills (demo RoundTrips, not shadow counterfactuals), both halves positive, AND survives review (slippage-adjusted, no single-period dependence). Shadow numbers alone NEVER promote — they carry no slippage (the gap_fill artifact).
- **ARM a demo trial**: promotion-radar flag (n≥50 resolved shadows, net>0, t≥2) or equivalent research finding. New edges default `defaultDemo: true, defaultLive: false` — ALWAYS.
- **DEMOTE from live**: rolling-20 expectancy < 0 (EXPECTANCY, not win rate — a 60% win rate can lose money at bad payoff; this exact mistake delayed the Aug 10 demotion).
- **RE-PROMOTE**: the edge's demo rolling-20 expectancy > 0.

## Switch mechanics
- Flags: `edge_<key>_<mode>` in AgentConfig ("true"/"false"); absent = registry default.
- Registry: `src/lib/realtime-edges.ts` (new edges = new entry + engines redeploy; flag flips = config only, engine picks up in ~5–10 min, NO deploy).
- Verify EVERY switch in the running engine: `railway logs -s <service> | grep "\[EDGES\]"` — the ON/off list is the ground truth. A permission classifier sometimes blocks live-enabling config writes: verify the flag actually landed, retry with Spencer's explicit approval.

## Current state pointers
- Memory: `project_aug10_trend_off_risk_down.md` (latest decisions + triggers), `MEMORY.md` index.
- The nightly digest's PROMOTION RADAR line surfaces candidates automatically; its verdicts still require this protocol.
