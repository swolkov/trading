import { prisma } from "./db";
import { getNews, getPositions } from "./alpaca";
import { sendNotification } from "./notifications";
import Anthropic from "@anthropic-ai/sdk";

// ============ EVENT CATALYST AGENT ============
// Monitors upcoming market-moving events and auto-adjusts trading behavior.
// FOMC, CPI, PPI, earnings, ex-dividend — anything that causes big moves.
// Reduces position sizing before known events. Classifies breaking news.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

export interface MarketEvent {
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM ET
  name: string;
  category: "fed" | "economic" | "earnings" | "dividend" | "expiration" | "other";
  impact: "high" | "medium" | "low";
  affectedSymbols: string[]; // empty = broad market
  sizeReduction: number; // 0.0 to 1.0 — how much to reduce sizing (1.0 = no trades)
}

export interface EventCalendarResult {
  upcomingEvents: MarketEvent[];
  eventsToday: MarketEvent[];
  eventsTomorrow: MarketEvent[];
  activeReductions: { reason: string; multiplier: number }[];
  newsAlerts: NewsClassification[];
}

export interface NewsClassification {
  headline: string;
  impact: "high" | "medium" | "low" | "none";
  sentiment: "bullish" | "bearish" | "neutral";
  affectedSymbols: string[];
  action: string;
}

// Known recurring events (static calendar)
function getRecurringEvents(year: number, month: number): MarketEvent[] {
  const events: MarketEvent[] = [];

  // FOMC meetings 2025-2026 (8 per year, roughly every 6 weeks)
  // These are approximate — the agent should verify against live calendars
  const fomcMonths = [1, 3, 5, 6, 7, 9, 11, 12];
  if (fomcMonths.includes(month)) {
    // FOMC typically mid-month, Wednesday
    const fomcDay = month <= 6 ? 18 : 17;
    events.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(fomcDay).padStart(2, "0")}`,
      time: "14:00",
      name: "FOMC Rate Decision",
      category: "fed",
      impact: "high",
      affectedSymbols: [],
      sizeReduction: 0.7, // reduce to 30% of normal sizing
    });
  }

  // CPI — typically 2nd week of month
  events.push({
    date: `${year}-${String(month).padStart(2, "0")}-12`,
    time: "08:30",
    name: "CPI Release",
    category: "economic",
    impact: "high",
    affectedSymbols: [],
    sizeReduction: 0.5,
  });

  // PPI — typically day after CPI
  events.push({
    date: `${year}-${String(month).padStart(2, "0")}-13`,
    time: "08:30",
    name: "PPI Release",
    category: "economic",
    impact: "medium",
    affectedSymbols: [],
    sizeReduction: 0.3,
  });

  // Jobs report — first Friday of month
  const firstFriday = getFirstFriday(year, month);
  events.push({
    date: firstFriday,
    time: "08:30",
    name: "Non-Farm Payrolls",
    category: "economic",
    impact: "high",
    affectedSymbols: [],
    sizeReduction: 0.5,
  });

  // Options expiration — 3rd Friday of month
  const thirdFriday = getThirdFriday(year, month);
  events.push({
    date: thirdFriday,
    name: "Monthly Options Expiration (OpEx)",
    category: "expiration",
    impact: "medium",
    affectedSymbols: [],
    sizeReduction: 0.2, // slightly reduce — gamma risk
  });

  return events;
}

function getFirstFriday(year: number, month: number): string {
  const d = new Date(year, month - 1, 1);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function getThirdFriday(year: number, month: number): string {
  const d = new Date(year, month - 1, 1);
  let fridays = 0;
  while (fridays < 3) {
    if (d.getDay() === 5) fridays++;
    if (fridays < 3) d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split("T")[0];
}

// Get earnings dates for our positions using Finnhub
async function getEarningsDates(): Promise<MarketEvent[]> {
  const events: MarketEvent[] = [];

  try {
    const positions = await getPositions();
    const symbols = [...new Set(positions.map((p) => {
      const match = p.symbol.match(/^([A-Z]+)/);
      return match ? match[1] : p.symbol;
    }))];

    // Check Finnhub for each symbol's earnings
    for (const symbol of symbols.slice(0, 10)) { // limit to avoid rate limits
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/calendar/earnings?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY || ""}`
        );
        if (!res.ok) continue;
        const data = await res.json();

        if (data.earningsCalendar) {
          for (const earning of data.earningsCalendar.slice(0, 3)) {
            const eventDate = earning.date;
            if (!eventDate) continue;

            // Only care about events within next 7 days
            const daysUntil = (new Date(eventDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
            if (daysUntil < 0 || daysUntil > 7) continue;

            events.push({
              date: eventDate,
              time: earning.hour === "bmo" ? "pre-market" : earning.hour === "amc" ? "after-close" : undefined,
              name: `${symbol} Earnings (EPS est: $${earning.epsEstimate || "?"})`,
              category: "earnings",
              impact: "high",
              affectedSymbols: [symbol],
              sizeReduction: 0.8, // heavily reduce — earnings are binary events
            });
          }
        }
      } catch {
        // Skip individual symbol failures
      }
    }
  } catch {
    // Positions fetch failed — skip earnings
  }

  return events;
}

// Classify breaking news using LLM
async function classifyBreakingNews(limit: number = 10): Promise<NewsClassification[]> {
  const results: NewsClassification[] = [];

  try {
    const news = await getNews(undefined, limit);
    if (news.length === 0) return results;

    // Only classify headlines from last 2 hours
    const recentNews = news.filter((n) => {
      const age = Date.now() - new Date(n.created_at).getTime();
      return age < 2 * 60 * 60 * 1000;
    });

    if (recentNews.length === 0) return results;

    const headlines = recentNews.map((n) => `- ${n.headline} (${n.symbols.join(", ")})`).join("\n");

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Classify these market news headlines for trading impact. For each, return JSON with: headline, impact (high/medium/low/none), sentiment (bullish/bearish/neutral), affectedSymbols (array), action (brief trading advice).

Return ONLY a JSON array, no markdown.

Headlines:
${headlines}`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as NewsClassification[];
      results.push(...parsed.filter((r) => r.impact === "high" || r.impact === "medium"));
    }
  } catch {
    // News classification failed — not critical
  }

  return results;
}

export async function runEventCatalystCheck(): Promise<EventCalendarResult> {
  const startTime = Date.now();

  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Build event calendar
  const [recurringEvents, earningsEvents, newsAlerts] = await Promise.all([
    Promise.resolve(getRecurringEvents(now.getFullYear(), now.getMonth() + 1)),
    getEarningsDates(),
    classifyBreakingNews(10),
  ]);

  const allEvents = [...recurringEvents, ...earningsEvents];

  // Filter to upcoming (next 7 days)
  const upcomingEvents = allEvents.filter((e) => {
    const daysUntil = (new Date(e.date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return daysUntil >= 0 && daysUntil <= 7;
  }).sort((a, b) => a.date.localeCompare(b.date));

  const eventsToday = allEvents.filter((e) => e.date === today);
  const eventsTomorrow = allEvents.filter((e) => e.date === tomorrow);

  // Calculate active size reductions
  const activeReductions: { reason: string; multiplier: number }[] = [];

  // Events TODAY — apply full reduction
  for (const event of eventsToday) {
    if (event.sizeReduction > 0) {
      activeReductions.push({
        reason: `${event.name} TODAY${event.time ? ` at ${event.time}` : ""}`,
        multiplier: 1 - event.sizeReduction,
      });
    }
  }

  // Events TOMORROW — apply partial reduction (close of day)
  for (const event of eventsTomorrow) {
    if (event.impact === "high" && event.sizeReduction > 0.3) {
      activeReductions.push({
        reason: `${event.name} TOMORROW — reducing new entries`,
        multiplier: 1 - event.sizeReduction * 0.5, // half the reduction
      });
    }
  }

  // High-impact news — immediate reduction
  const highImpactNews = newsAlerts.filter((n) => n.impact === "high");
  if (highImpactNews.length > 0) {
    activeReductions.push({
      reason: `Breaking news: ${highImpactNews.map((n) => n.headline).join("; ").slice(0, 100)}`,
      multiplier: 0.5,
    });
  }

  // Store the most restrictive size multiplier for other agents
  const effectiveMultiplier = activeReductions.length > 0
    ? Math.min(...activeReductions.map((r) => r.multiplier))
    : 1.0;

  // Store with TTL — expires at end of trading day (9 PM ET) so it doesn't persist if agent crashes
  const ttlNow = new Date();
  const expiresAt = new Date(ttlNow);
  expiresAt.setUTCHours(21 + (ttlNow.getTimezoneOffset() === 240 ? 4 : 5), 0, 0, 0); // 9 PM ET
  if (expiresAt < ttlNow) expiresAt.setDate(expiresAt.getDate() + 1);

  await prisma.agentConfig.upsert({
    where: { key: "event_size_override" },
    update: { value: JSON.stringify({ multiplier: effectiveMultiplier, expiresAt: expiresAt.toISOString(), updatedAt: ttlNow.toISOString() }) },
    create: { key: "event_size_override", value: JSON.stringify({ multiplier: effectiveMultiplier, expiresAt: expiresAt.toISOString(), updatedAt: ttlNow.toISOString() }) },
  });

  // Store event calendar for dashboard
  await prisma.agentConfig.upsert({
    where: { key: "event_calendar" },
    update: {
      value: JSON.stringify({
        lastRun: new Date().toISOString(),
        eventsToday: eventsToday.map((e) => e.name),
        eventsTomorrow: eventsTomorrow.map((e) => e.name),
        upcoming: upcomingEvents.length,
        effectiveMultiplier,
        newsAlerts: highImpactNews.length,
      }),
    },
    create: {
      key: "event_calendar",
      value: JSON.stringify({
        lastRun: new Date().toISOString(),
        eventsToday: eventsToday.map((e) => e.name),
        eventsTomorrow: eventsTomorrow.map((e) => e.name),
        upcoming: upcomingEvents.length,
        effectiveMultiplier,
      }),
    },
  });

  // Notify on high-impact events today
  if (eventsToday.some((e) => e.impact === "high")) {
    const highImpact = eventsToday.filter((e) => e.impact === "high");
    await sendNotification(
      `📅 HIGH-IMPACT EVENTS TODAY:\n${highImpact.map((e) => `• ${e.name}${e.time ? ` at ${e.time}` : ""} — sizing reduced to ${((1 - e.sizeReduction) * 100).toFixed(0)}%`).join("\n")}\n\nAll agents adjusted.`,
      "general"
    );
  }

  // Notify on breaking news
  if (highImpactNews.length > 0) {
    await sendNotification(
      `📰 BREAKING NEWS:\n${highImpactNews.map((n) => `• ${n.headline} [${n.sentiment.toUpperCase()}] — ${n.action}`).join("\n")}`,
      "general"
    );
  }

  // Notify on position-specific earnings
  const positionEarnings = earningsEvents.filter((e) => e.affectedSymbols.length > 0);
  if (positionEarnings.length > 0) {
    await sendNotification(
      `🎯 EARNINGS FOR YOUR POSITIONS:\n${positionEarnings.map((e) => `• ${e.name} on ${e.date}${e.time ? ` (${e.time})` : ""}`).join("\n")}\n\nConsider closing or hedging before earnings.`,
      "options"
    );
  }

  const summary = `Events: ${eventsToday.length} today, ${eventsTomorrow.length} tomorrow, ${upcomingEvents.length} this week | News: ${highImpactNews.length} high-impact | Size override: ${(effectiveMultiplier * 100).toFixed(0)}%`;

  await prisma.agentRun.create({
    data: {
      runType: "event_catalyst",
      stocksScanned: 0,
      tradesPlaced: 0,
      positionsManaged: earningsEvents.length,
      errors: 0,
      summary,
      durationMs: Date.now() - startTime,
    },
  });

  return {
    upcomingEvents,
    eventsToday,
    eventsTomorrow,
    activeReductions,
    newsAlerts,
  };
}
