# Session Prep

Prepare a trading session briefing by reading key files from the Obsidian vault.

## Instructions

Read the following files IN ORDER from the vault at `/Users/user/Desktop/Trading/Trading/`. Use the `Read` tool with full file paths (NOT the obsidian-trading MCP server).

### Step 1: Read Core Files

1. `Read /Users/user/Desktop/Trading/Trading/Rules/risk-management.md` — Hard limits, never skip
2. `Read /Users/user/Desktop/Trading/Trading/Brain/market-regime.md` — Current market environment
3. `Read /Users/user/Desktop/Trading/Trading/Brain/volatility-environment.md` — Vol context
4. Use `Glob` with pattern `*.md` in `/Users/user/Desktop/Trading/Trading/Strategies/` to list available strategies, then read the most relevant one(s)
5. `Read /Users/user/Desktop/Trading/Trading/Lessons/active-lessons.md` — Top lessons to apply today
6. `Read /Users/user/Desktop/Trading/Trading/Rules/anti-patterns.md` — Known traps to avoid
7. Use `Glob` with pattern `*.md` in `/Users/user/Desktop/Trading/Trading/Agent-Config/` and read all agent config files found
8. Use `Glob` with pattern `*.md` in `/Users/user/Desktop/Trading/Trading/Journal/` to find journal entries, then read the **last 3** entries by date (most recent files)

### Step 2: Produce Session Briefing

After reading all files, produce a concise **Session Briefing** with the following sections:

---

## Session Briefing — [Today's Date]

### Market Regime & Vol Environment
- 1-2 lines summarizing current regime classification and volatility context

### Active Risk Limits
- Max daily loss
- Max concurrent positions
- Max position size
- Any other hard constraints from risk-management.md

### Top 3 Lessons to Apply Today
1. (from active-lessons.md — pick the 3 most relevant to current regime)
2. ...
3. ...

### Top 3 Anti-Patterns to Avoid
1. (from anti-patterns.md — pick the 3 most relevant to current regime)
2. ...
3. ...

### Recent Trade Context
- Summary of last 3 journal entries: win/loss pattern, what worked, what didn't
- Any streaks or emotional flags to be aware of

### Strategy Parameters & Changes
- Note any recent parameter changes in strategy files
- Which strategy is most relevant for today's regime

---

### Important Notes
- Be concise. Summarize, do not dump raw file contents.
- If a file does not exist, note it and continue.
- Prioritize information relevant to the CURRENT market regime when selecting lessons and anti-patterns.
- Flag anything that seems inconsistent (e.g., strategy params not matching current vol environment).
