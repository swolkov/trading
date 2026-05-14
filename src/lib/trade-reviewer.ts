import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

// Review closed trades and extract lessons
export async function reviewClosedTrades(): Promise<string[]> {
  const lessons: string[] = [];

  // Find trades that closed with P&L but haven't been reviewed
  const closedTrades = await prisma.autoTradeLog.findMany({
    where: {
      pnl: { not: null },
      action: { in: ["stop_loss", "take_profit", "trailing_stop", "thesis_change", "expiry_close"] },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (closedTrades.length === 0) return lessons;

  // Check if we've already reviewed these (look for existing lessons)
  const existingLessons = await prisma.agentConfig.findUnique({
    where: { key: "trade_lessons" },
  });
  const existingCount = existingLessons?.value ? JSON.parse(existingLessons.value).length : 0;

  // Only review if we have new closed trades
  if (closedTrades.length <= existingCount) return JSON.parse(existingLessons?.value || "[]");

  // Build review prompt
  const tradesSummary = closedTrades.map((t) => {
    const won = (t.pnl || 0) > 0;
    return `${t.symbol}: ${t.action} | P&L: $${t.pnl?.toFixed(2)} (${won ? "WIN" : "LOSS"}) | AI Score: ${t.aiScore || "?"} | Reason: ${t.reason?.slice(0, 150)}`;
  }).join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `Review these closed trades and extract SPECIFIC, ACTIONABLE lessons. What patterns do you see? What should we do differently?

${tradesSummary}

Respond with a JSON array of 3-5 short lessons (1 sentence each). Focus on PATTERNS, not individual trades. Example:
["Stocks with AI score above 70 won 80% of the time — raise minimum score threshold",
"Stop losses triggered too early on volatile stocks — consider wider ATR multiplier"]

JSON array only, no markdown:`,
      }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        // Store lessons in database
        await prisma.agentConfig.upsert({
          where: { key: "trade_lessons" },
          update: { value: JSON.stringify(parsed) },
          create: { key: "trade_lessons", value: JSON.stringify(parsed) },
        });
        return parsed;
      }
    }
  } catch {
    // review failed, return existing
  }

  return JSON.parse(existingLessons?.value || "[]");
}

// Get accumulated lessons for AI prompt injection — reads from VAULT + DB
export async function getTradeLessons(): Promise<string> {
  const parts: string[] = [];

  // 1. Read vault lessons (synthesis agent writes these from 84+ trade analysis)
  try {
    const { vaultRead } = await import("./vault");
    const vaultLessons = await vaultRead("Lessons/active-lessons.md");
    if (vaultLessons && !vaultLessons.includes("No lessons yet")) {
      parts.push(`\n## VAULT BRAIN — LESSONS FROM TRADE HISTORY (MUST APPLY)\n${vaultLessons}`);
    }

    // Also read anti-patterns
    const antiPatterns = await vaultRead("Rules/anti-patterns.md");
    if (antiPatterns && !antiPatterns.includes("No anti-patterns identified yet")) {
      parts.push(`\n## ANTI-PATTERNS — AVOID THESE SETUPS\n${antiPatterns}`);
    }
  } catch { /* vault unavailable */ }

  // 2. Read DB trade lessons (trade reviewer writes these)
  try {
    const config = await prisma.agentConfig.findUnique({
      where: { key: "trade_lessons" },
    });
    if (config?.value) {
      const lessons = JSON.parse(config.value);
      if (Array.isArray(lessons) && lessons.length > 0) {
        parts.push(`\n## AI TRADE REVIEW LESSONS\n${lessons.map((l: string, i: number) => `${i + 1}. ${l}`).join("\n")}`);
      }
    }
  } catch { /* ignore */ }

  return parts.join("\n");
}
