@AGENTS.md

## Obsidian Trading Brain

All trading agents use the Obsidian vault at `/Users/user/Desktop/Trading/Trading/` as their persistent memory and learning system.

### Vault Path
`/Users/user/Desktop/Trading/Trading/`

### How to Access Vault Files
- **Reading**: Use the built-in `Read` tool with the full path (e.g., `Read /Users/user/Desktop/Trading/Trading/Brain/market-regime.md`). This is instant. Do NOT use the `obsidian-trading` MCP server for reads — it is extremely slow and frequently times out.
- **Writing/Editing**: Use the built-in `Write` or `Edit` tools with the full path.
- **Searching**: Use `Grep` or `Glob` with path `/Users/user/Desktop/Trading/Trading/` for fast searches.
- **MCP server**: Only use `obsidian-trading` MCP for tag operations (`add-tags`, `remove-tags`, `rename-tag`) that require Obsidian-specific functionality.

### Agent Protocols

**Before every trading session**, agents MUST read (in order):
1. `Rules/risk-management.md` — Hard limits, never skip
2. `Brain/market-regime.md` — Current market environment
3. `Brain/volatility-environment.md` — Vol context
4. `Strategies/<relevant-strategy>.md` — Current parameters
5. `Lessons/active-lessons.md` — Top lessons to apply
6. `Rules/anti-patterns.md` — Known traps to avoid
7. `Agent-Config/<agent-name>.md` — Agent-specific config
8. Last 3 `Journal/` entries — Recent trade context

**After every trade**, agents MUST write:
1. Append trade YAML block to `Journal/YYYY-MM-DD.md` (use `Journal/_template.md` format)
2. Log decision rationale in `Decisions/YYYY-MM-DD.md`
3. Any observation to `Lessons/raw-observations.md`

**After every session**, agents MUST:
1. Complete session summary in Journal
2. Update `Performance/statistics.md`

**Research agent** MUST update:
1. `Brain/market-regime.md` — regime classification
2. `Brain/volatility-environment.md` — vol assessment
3. `Brain/macro-outlook.md` — economic calendar, Fed
4. `Research/watchlist.md` — scored opportunities
5. `Research/sectors.md` — relative strength

**Synthesis agent** (run after every 10 trades or weekly):
1. Analyze Journal entries → update `Performance/statistics.md`
2. Extract patterns → update `Lessons/active-lessons.md`
3. Identify anti-patterns → update `Rules/anti-patterns.md`
4. Adjust strategy parameters in `Strategies/` if statistically supported (>20 trade sample)

### Event Bus & Orchestrator

The orchestrator is the **nervous system** — it routes events between agents in real-time (every 1 min via cron). Agents emit events, the orchestrator processes them and updates ephemeral session state.

**Event emission** is automatic via `logTradeToJournal()`, `logDecision()`, `updateMarketRegime()`, and `runSynthesis()`. No manual event emission needed.

**Before placing trades**, agents SHOULD check:
```typescript
import { areEntriesPaused } from "@/lib/orchestrator";
const { paused, reason } = await areEntriesPaused("live");
if (paused) return; // orchestrator has paused entries
```

**Key files**:
- `src/lib/event-bus.ts` — `emitEvent()`, `emitEventSafe()`, typed events
- `src/lib/session-context.ts` — `getSessionValue()`, `setSessionValue()`, ephemeral day state
- `src/lib/orchestrator.ts` — `runOrchestrator()`, `areEntriesPaused()`, `getSessionTradingSummary()`
- `src/app/api/cron/orchestrator/route.ts` — runs every 1 min

**Vault brain files**:
- `Brain/orchestrator.md` — Event bus architecture & status
- `Agent-Config/orchestrator-agent.md` — Orchestrator config & workflows

### Key Directories
| Dir | Purpose |
|-----|---------|
| `Brain/` | Live market intelligence (regime, vol, macro, orchestrator) |
| `Strategies/` | Evolving playbooks with parameters |
| `Journal/` | Every trade with full YAML context |
| `Lessons/` | Synthesized patterns from trade history |
| `Research/` | Watchlists, sectors, catalysts |
| `Rules/` | Hard constraints — only user can modify |
| `Performance/` | Running stats, equity curve |
| `Agent-Config/` | Per-agent instructions and adjustments |
| `Decisions/` | Decision logs — trades taken AND skipped |
