import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import { getSessionValue, setSessionValue, SessionKeys } from "./session-context";
import { getVaultContextForAI, vaultWrite } from "./vault";
import { emitEventSafe } from "./event-bus";

// ============ FABLE 5 ADVISOR ============
// Strategic brain that runs once per day (premarket) and on-demand for borderline setups.
// Worker models (Sonnet) handle routine grading; Fable 5 handles the hard calls.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ─── Model Configuration (DB-overridable) ─────────────────────────────────────

// Fable 5 confirmed: model ID "claude-fable-5", $10 input / $50 output per MTok
// Uses adaptive thinking (NOT the old enabled+budget_tokens style)
const DEFAULT_ADVISOR_MODEL = "claude-fable-5";
const DEFAULT_WORKER_MODEL = "claude-sonnet-4-6";

// RESILIENCE: if the primary advisor model becomes unavailable (deprecated, pulled, region-blocked,
// overloaded), fall through this chain so strategic grading keeps its full capability instead of
// silently dropping to "no advisor." Most → least preferred. DB-overridable via advisor_fallback_models.
const DEFAULT_ADVISOR_FALLBACKS = ["claude-opus-4-8", "claude-sonnet-4-6"];

// Models that require adaptive thinking (reject type: "enabled" + budget_tokens).
// Sonnet 4.6 is included so it works as a fallback advisor — its legacy budget_tokens (8000) would
// otherwise equal escalation's max_tokens (8000) and 400 (budget must be < max_tokens).
const ADAPTIVE_THINKING_MODELS = new Set(["claude-fable-5", "claude-mythos-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6"]);

/** Get the correct thinking config for a given model */
function getThinkingConfig(model: string): { type: "adaptive" } | { type: "enabled"; budget_tokens: number } {
  if (ADAPTIVE_THINKING_MODELS.has(model)) {
    return { type: "adaptive" };
  }
  // Legacy models (Opus 4.6, Sonnet 4.6) still support enabled+budget_tokens (deprecated but functional)
  return { type: "enabled", budget_tokens: 8000 };
}

/** Read model config from AgentConfig DB. Falls back to defaults. */
async function getModelConfig(): Promise<{ advisorModel: string; workerModel: string; advisorChain: string[] }> {
  let advisorModel = DEFAULT_ADVISOR_MODEL;
  let workerModel = DEFAULT_WORKER_MODEL;
  let fallbacks = DEFAULT_ADVISOR_FALLBACKS;
  try {
    const keys = ["advisor_model", "worker_model", "advisor_fallback_models"];
    const configs = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const cfg: Record<string, string> = {};
    for (const c of configs) cfg[c.key] = c.value;
    advisorModel = cfg.advisor_model || DEFAULT_ADVISOR_MODEL;
    workerModel = cfg.worker_model || DEFAULT_WORKER_MODEL;
    if (cfg.advisor_fallback_models) {
      const parsed = cfg.advisor_fallback_models.split(",").map((s) => s.trim()).filter(Boolean);
      if (parsed.length > 0) fallbacks = parsed;
    }
  } catch { /* use defaults */ }
  // Build the resilience chain: primary first, then fallbacks, deduped (so the primary is never retried).
  const advisorChain = [...new Set([advisorModel, ...fallbacks])];
  return { advisorModel, workerModel, advisorChain };
}

type AdvisorCallParams = {
  max_tokens: number;
  messages: Anthropic.MessageParam[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

/**
 * Call messages.create with automatic model fallback. Tries each model in the chain in order; on any
 * model-availability failure (model pulled/deprecated/region-blocked, 5xx, overloaded) it falls through
 * to the next. Bails immediately only on 401 (bad API key — no model would work). Throws if the whole
 * chain fails, so the caller's own graceful fallback (neutral plan / null) still applies.
 */
async function createWithModelFallback(
  params: AdvisorCallParams,
  chain: string[],
): Promise<{ response: Anthropic.Message; modelUsed: string; fellBack: boolean }> {
  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: params.max_tokens,
        thinking: getThinkingConfig(model),
        ...(params.effort ? { output_config: { effort: params.effort } } : {}),
        messages: params.messages,
      });
      if (i > 0) console.warn(`[ADVISOR] primary model unavailable — request served by fallback "${model}"`);
      return { response, modelUsed: model, fellBack: i > 0 };
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const more = i < chain.length - 1 ? " — trying next model" : "";
      console.error(`[ADVISOR] model "${model}" failed (status ${status ?? "?"})${more}: ${err instanceof Error ? err.message : String(err)}`);
      if (status === 401) throw err; // auth failure — every model will reject; don't waste calls
    }
  }
  throw lastErr;
}

// ─── Daily Plan ───────────────────────────────────────────────────────────────

export interface DailyPlan {
  date: string;
  bias: "bullish" | "bearish" | "neutral";
  biasConfidence: number;
  instruments: Record<string, {
    priority: "high" | "medium" | "low" | "avoid";
    direction: "long" | "short" | "both" | "avoid";
    notes: string;
  }>;
  preferredSetups: string[];
  avoidSetups: string[];
  riskAdjustment: "normal" | "reduce_size" | "tighten_stops" | "aggressive";
  warnings: string[];
  reasoning: string;
}

/** Read today's plan from session context. Returns null if no plan yet. */
export async function getDailyPlan(): Promise<DailyPlan | null> {
  return getSessionValue<DailyPlan>(SessionKeys.DAILY_PLAN);
}

/**
 * Generate today's trading plan using Fable 5.
 * Called once from premarket cron. Stored in SessionContext for all agents to read.
 */
export async function generateDailyPlan(context: {
  regime: string;
  regimeRecommendation: string;
  macroBias: string;
  macroSummary: string;
  tradingRules: string[];
  futuresGap: string;
  newsHighlights: string[];
  vixLevel?: number;
}): Promise<DailyPlan> {
  const { advisorChain } = await getModelConfig();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // Load vault intelligence for richer context
  let vaultContext = "";
  try {
    vaultContext = await getVaultContextForAI("advisor", "Strategies/futures-scalping.md");
  } catch { /* vault optional */ }

  // Load recent performance from DB
  let recentPerf = "";
  try {
    const recentTrades = await prisma.autoTradeLog.findMany({
      where: {
        pnl: { not: null },
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        symbol: { in: ["MES", "MNQ", "ES", "NQ", "GC", "MBT", "MGC"] },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { symbol: true, aiSignal: true, pnl: true, createdAt: true },
    });
    if (recentTrades.length > 0) {
      const wins = recentTrades.filter(t => (t.pnl ?? 0) > 0).length;
      const totalPnl = recentTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
      recentPerf = `\nRECENT 7-DAY PERFORMANCE: ${recentTrades.length} trades, ${wins} wins (${(wins / recentTrades.length * 100).toFixed(0)}% WR), $${totalPnl.toFixed(0)} total P&L`;
      recentPerf += `\nLast 5 trades: ${recentTrades.slice(0, 5).map(t => `${t.symbol} ${t.aiSignal} $${(t.pnl ?? 0).toFixed(0)}`).join(" | ")}`;
    }
  } catch { /* perf optional */ }

  const prompt = `You are the STRATEGIC ADVISOR for an automated futures trading system. Your job is to produce today's TRADING PLAN that guides all execution decisions.

TODAY: ${today}
MARKET REGIME: ${context.regime} — ${context.regimeRecommendation}
MACRO BIAS: ${context.macroBias} — ${context.macroSummary}
${context.tradingRules.length > 0 ? `MACRO RULES: ${context.tradingRules.join(" | ")}` : ""}
FUTURES OVERNIGHT: ${context.futuresGap || "No significant gap"}
${context.vixLevel ? `VIX: ${context.vixLevel.toFixed(1)}` : ""}
${context.newsHighlights.length > 0 ? `OVERNIGHT NEWS:\n${context.newsHighlights.map(n => `- ${n}`).join("\n")}` : "No major news"}
${vaultContext}
${recentPerf}

INSTRUMENTS AVAILABLE:
- LIVE ($1K account): MES (S&P micro, $5/pt), MNQ (Nasdaq micro, $2/pt — currently removed)
- DEMO ($59K account): ES ($50/pt), NQ ($20/pt), GC ($100/pt gold), MBT ($0.10/$1 BTC micro)

SETUP TYPES AVAILABLE: opening_range_breakout, gap_fill, vwap_reversion, trend_continuation, ema_momentum, pullback_to_ema, rsi_bounce, nr4 (narrow range breakout)

Based on ALL the above context, produce a SPECIFIC, ACTIONABLE trading plan for today.

Respond ONLY with JSON (no markdown):
{
  "bias": "bullish"|"bearish"|"neutral",
  "biasConfidence": 50-95,
  "instruments": {
    "MES": {"priority": "high"|"medium"|"low"|"avoid", "direction": "long"|"short"|"both"|"avoid", "notes": "why"},
    "ES": {"priority": "...", "direction": "...", "notes": "..."},
    "NQ": {"priority": "...", "direction": "...", "notes": "..."},
    "GC": {"priority": "...", "direction": "...", "notes": "..."},
    "MBT": {"priority": "...", "direction": "...", "notes": "..."}
  },
  "preferredSetups": ["setup_type_1", "setup_type_2"],
  "avoidSetups": ["setup_type_to_avoid"],
  "riskAdjustment": "normal"|"reduce_size"|"tighten_stops"|"aggressive",
  "warnings": ["specific time-based warnings, e.g. FOMC at 2pm"],
  "reasoning": "2-3 sentence strategic summary"
}`;

  try {
    // xhigh effort: strategic daily plan deserves deep thinking (runs once per day, cost is negligible).
    // Auto-falls through the model chain if the primary advisor model is unavailable.
    const { response, modelUsed, fellBack } = await createWithModelFallback({
      max_tokens: 16000,
      effort: "xhigh",
      messages: [{ role: "user", content: prompt }],
    }, advisorChain);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let jsonText = text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonText = jsonMatch[1].trim();

    const raw = JSON.parse(jsonText);
    if (!raw.bias || typeof raw.biasConfidence !== "number" || !raw.instruments) {
      throw new Error(`Malformed plan response: missing bias/biasConfidence/instruments`);
    }
    const plan: DailyPlan = {
      date: today,
      bias: raw.bias,
      biasConfidence: raw.biasConfidence,
      instruments: raw.instruments || {},
      preferredSetups: raw.preferredSetups || [],
      avoidSetups: raw.avoidSetups || [],
      riskAdjustment: raw.riskAdjustment || "normal",
      warnings: [...(raw.warnings || []), ...(fellBack ? [`⚠️ Primary advisor model unavailable — plan generated by fallback model ${modelUsed}`] : [])],
      reasoning: raw.reasoning || "",
    };

    // Store in session context (expires at midnight ET)
    await setSessionValue(SessionKeys.DAILY_PLAN, plan);

    // Write to vault (DB-backed) for human review and other agents
    try {
      await vaultWrite("Brain/daily-plan.md", `---
date: "${today}"
generated_by: "fable-5-advisor"
model: "${modelUsed}"
bias: "${plan.bias}"
bias_confidence: ${plan.biasConfidence}
risk_adjustment: "${plan.riskAdjustment}"
---

# Daily Trading Plan — ${today}

## Bias: ${plan.bias.toUpperCase()} (${plan.biasConfidence}% confidence)

## Risk: ${plan.riskAdjustment.replace(/_/g, " ").toUpperCase()}

## Instrument Focus
${Object.entries(plan.instruments).map(([sym, cfg]) =>
  `| ${sym} | ${cfg.priority} | ${cfg.direction} | ${cfg.notes} |`
).join("\n")}

## Preferred Setups
${plan.preferredSetups.map(s => `- ${s.replace(/_/g, " ")}`).join("\n")}

## Avoid
${plan.avoidSetups.map(s => `- ${s.replace(/_/g, " ")}`).join("\n")}

## Warnings
${plan.warnings.length > 0 ? plan.warnings.map(w => `- ${w}`).join("\n") : "None"}

## Reasoning
${plan.reasoning}
`, "fable-5-advisor");
    } catch { /* vault write optional */ }

    // Emit event so orchestrator knows
    emitEventSafe("session.premarket_ready", "fable-5-advisor", {
      message: `Daily plan: ${plan.bias} (${plan.biasConfidence}%), risk: ${plan.riskAdjustment}`,
    });

    return plan;
  } catch (err) {
    // Fallback: neutral plan if Fable 5 fails
    const fallback: DailyPlan = {
      date: today,
      bias: "neutral",
      biasConfidence: 50,
      instruments: {
        MES: { priority: "high", direction: "both", notes: "advisor unavailable — default to technicals" },
        ES: { priority: "medium", direction: "both", notes: "advisor unavailable" },
        NQ: { priority: "medium", direction: "both", notes: "advisor unavailable" },
        GC: { priority: "medium", direction: "both", notes: "advisor unavailable" },
        MBT: { priority: "low", direction: "both", notes: "advisor unavailable" },
      },
      preferredSetups: [],
      avoidSetups: [],
      riskAdjustment: "normal",
      warnings: [`Fable 5 advisor failed: ${err instanceof Error ? err.message : "unknown"}`],
      reasoning: "Advisor unavailable — proceed on technicals alone with default parameters.",
    };
    await setSessionValue(SessionKeys.DAILY_PLAN, fallback);
    return fallback;
  }
}

// ─── Escalation Advisor ───────────────────────────────────────────────────────

export interface EscalationRequest {
  symbol: string;
  direction: string;
  setupType: string;
  reasoning: string;
  price: number;
  stopDistance: number;
  targetDistance: number;
  rsi: number;
  atr: number;
  vwap: number;
  trend15: string;
  dayType: string;
  session: string;
  workerGrade: string;        // What Sonnet said: "A", "B", "agree", etc.
  workerReasoning: string;
  technicalScore: number;
  mode: "live" | "demo";
  patternStats?: { matchCount: number; winRate: number; avgR: number };
}

export interface EscalationResult {
  finalGrade: "A+" | "A" | "B" | "C";
  agree: boolean;
  reasoning: string;
  overrideWorker: boolean;    // true if Fable 5 disagrees with Sonnet
}

/**
 * Escalate a borderline setup to Fable 5 for a second opinion.
 * Called when the worker model grades A or B (the ambiguous zone).
 */
export async function escalateToAdvisor(req: EscalationRequest): Promise<EscalationResult | null> {
  const { advisorChain } = await getModelConfig();

  // Read today's daily plan for strategic context
  const plan = await getDailyPlan();
  const planContext = plan
    ? `TODAY'S PLAN (from this morning's strategic analysis):
Bias: ${plan.bias} (${plan.biasConfidence}% confidence)
Risk adjustment: ${plan.riskAdjustment}
${plan.instruments[req.symbol] ? `${req.symbol} guidance: ${plan.instruments[req.symbol].priority} priority, direction: ${plan.instruments[req.symbol].direction} — ${plan.instruments[req.symbol].notes}` : "No specific guidance for this instrument"}
Preferred setups: ${plan.preferredSetups.join(", ") || "none specified"}
Avoid setups: ${plan.avoidSetups.join(", ") || "none specified"}
Warnings: ${plan.warnings.join("; ") || "none"}`
    : "No daily plan available — assess purely on setup merit.";

  const patternCtx = req.patternStats
    ? `Pattern memory: ${req.patternStats.matchCount} historical matches, ${(req.patternStats.winRate * 100).toFixed(0)}% WR, avg ${req.patternStats.avgR.toFixed(2)}R`
    : "No pattern history for this setup type.";

  const prompt = `You are the SENIOR ADVISOR reviewing a borderline trade setup that the fast grader (Sonnet) flagged as "${req.workerGrade}".

Your job: make the FINAL CALL. The worker model handles clear A+ (slam dunks) and C (garbage) autonomously. You only see the ambiguous middle — the A and B grades where money is won or lost.

${req.mode === "live" ? "LIVE ACCOUNT ($1K). Real money. Only approve if the edge is genuine." : "DEMO ACCOUNT ($59K). Aggressive learning mode. Approve if there's any reasonable edge."}

SETUP:
${req.symbol} @ $${req.price.toFixed(2)} | ${req.direction.toUpperCase()} | ${req.setupType.replace(/_/g, " ")}
${req.reasoning}
RSI: ${req.rsi.toFixed(0)} | ATR: ${req.atr.toFixed(2)} | VWAP: $${req.vwap.toFixed(2)}
15m trend: ${req.trend15} | Day type: ${req.dayType} | Session: ${req.session}
Stop: ${req.stopDistance.toFixed(2)} pts | Target: ${req.targetDistance.toFixed(2)} pts | R:R: ${(req.targetDistance / req.stopDistance).toFixed(1)}
Technical score: ${req.technicalScore}%

WORKER GRADE: ${req.workerGrade}
Worker reasoning: ${req.workerReasoning}

${patternCtx}

${planContext}

Consider:
1. Does this setup ALIGN with today's strategic plan?
2. Does the pattern history support or contradict this trade?
3. Is the worker's grade too generous or too harsh given the full context?
4. Would you risk real money on this setup right now?

Respond ONLY with JSON:
{"finalGrade": "A+"|"A"|"B"|"C", "agree": true/false, "reasoning": "one decisive sentence", "overrideWorker": true/false}`;

  try {
    // Auto-falls through the model chain if the primary advisor model is unavailable, so live
    // borderline setups keep their senior second opinion instead of dropping to the worker grade.
    const { response } = await createWithModelFallback({
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }, advisorChain);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let jsonText = text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonText = jsonMatch[1].trim();

    const raw = JSON.parse(jsonText);
    if (!raw.finalGrade || typeof raw.agree !== "boolean") {
      throw new Error(`Malformed escalation response: missing finalGrade/agree`);
    }
    return {
      finalGrade: raw.finalGrade,
      agree: raw.agree,
      reasoning: raw.reasoning || "",
      overrideWorker: !!raw.overrideWorker,
    } as EscalationResult;
  } catch (err) {
    // If advisor fails, trust the worker grade
    console.error("[ADVISOR] Escalation failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Plan Context for Grading Prompts ─────────────────────────────────────────

/**
 * Get a compact string of today's plan context suitable for injection into grading prompts.
 * Returns empty string if no plan exists.
 */
export async function getPlanContextForGrading(symbol: string): Promise<string> {
  const plan = await getDailyPlan();
  if (!plan) return "";

  const symPlan = plan.instruments[symbol];
  const parts: string[] = [
    `\n=== TODAY'S STRATEGIC PLAN (Fable 5 Advisor) ===`,
    `Bias: ${plan.bias.toUpperCase()} (${plan.biasConfidence}%)`,
    `Risk: ${plan.riskAdjustment.replace(/_/g, " ")}`,
  ];

  if (symPlan) {
    parts.push(`${symbol}: ${symPlan.priority} priority, favor ${symPlan.direction} — ${symPlan.notes}`);
  }

  if (plan.preferredSetups.length > 0) {
    parts.push(`Preferred setups today: ${plan.preferredSetups.join(", ")}`);
  }
  if (plan.avoidSetups.length > 0) {
    parts.push(`AVOID today: ${plan.avoidSetups.join(", ")}`);
  }
  if (plan.warnings.length > 0) {
    parts.push(`WARNINGS: ${plan.warnings.join(" | ")}`);
  }

  parts.push(`=== END PLAN ===\n`);
  return parts.join("\n");
}

// ─── Escalation Decision Logic ────────────────────────────────────────────────

/** Determine if a setup should be escalated to the Fable 5 advisor. */
export function shouldEscalate(params: {
  workerGrade: string;        // "A+", "A", "B", "C" or agree/disagree
  workerAgree: boolean;
  mode: "live" | "demo";
  contracts: number;
  recentRegimeShift: boolean;
  planConflict: boolean;      // setup direction conflicts with daily plan bias
}): boolean {
  // Clear calls don't need escalation
  if (params.workerGrade === "A+" || params.workerGrade === "C") return false;
  if (!params.workerAgree) return false;  // Worker already killed it

  // Borderline grades always escalate on live
  if (params.mode === "live" && (params.workerGrade === "A" || params.workerGrade === "B")) return true;

  // Large positions escalate regardless of mode
  if (params.contracts > 2) return true;

  // Regime shift or plan conflict = escalate
  if (params.recentRegimeShift) return true;
  if (params.planConflict) return true;

  // Demo B grades: escalate (demo A grades are fine without advisor)
  if (params.mode === "demo" && params.workerGrade === "B") return true;

  return false;
}
