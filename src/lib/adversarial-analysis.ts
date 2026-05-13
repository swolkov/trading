import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

export interface AdversarialResult {
  bullCase: string;
  bearCase: string;
  verdict: "strongly_bullish" | "bullish" | "neutral" | "bearish" | "strongly_bearish";
  verdictReasoning: string;
  blindSpots: string[];
  confidence: number;
  killShot: string; // The single strongest argument that decided the verdict
}

export async function runAdversarialAnalysis(
  symbol: string,
  currentAnalysis: {
    score: number;
    signal: string;
    summary: string;
    thesis: string;
    risks: string[];
    catalysts: string[];
    priceTarget: number | null;
  },
  currentPrice: number
): Promise<AdversarialResult> {
  const prompt = `You are TWO opposing analysts debating whether to trade ${symbol} at $${currentPrice.toFixed(2)}.

Here is the initial analysis:
Score: ${currentAnalysis.score}/100 | Signal: ${currentAnalysis.signal}
Summary: ${currentAnalysis.summary}
Thesis: ${currentAnalysis.thesis}
Catalysts: ${currentAnalysis.catalysts.join(", ")}
Risks: ${currentAnalysis.risks.join(", ")}
Price Target: $${currentAnalysis.priceTarget || "N/A"}

Now debate:

ANALYST A (BULL): Make the STRONGEST possible case for buying ${symbol} right now. Use every bullish argument — growth, momentum, valuation, catalysts, technicals. Be aggressive and convicted.

ANALYST B (BEAR): Destroy the bull case. Make the STRONGEST possible case AGAINST buying ${symbol}. Find every risk, every red flag, every reason this trade fails. Be ruthless.

JUDGE: After hearing both sides, who wins? What's the single "kill shot" argument that tips the scales?

Respond in this exact JSON format (no markdown, no code fences):
{
  "bullCase": "<2-3 sentences: strongest bull argument>",
  "bearCase": "<2-3 sentences: strongest bear argument>",
  "verdict": "<strongly_bullish|bullish|neutral|bearish|strongly_bearish>",
  "verdictReasoning": "<2-3 sentences: why this side wins the debate>",
  "blindSpots": ["<risk the initial analysis missed>", "<another blind spot>"],
  "confidence": <0-100: how confident is the judge in the verdict>,
  "killShot": "<the single strongest argument that decided it>"
}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        bullCase: parsed.bullCase || "",
        bearCase: parsed.bearCase || "",
        verdict: parsed.verdict || "neutral",
        verdictReasoning: parsed.verdictReasoning || "",
        blindSpots: Array.isArray(parsed.blindSpots) ? parsed.blindSpots : [],
        confidence: Math.max(0, Math.min(100, parsed.confidence || 50)),
        killShot: parsed.killShot || "",
      };
    }
  } catch {
    // fallback
  }

  return {
    bullCase: "",
    bearCase: "",
    verdict: "neutral",
    verdictReasoning: "Adversarial analysis unavailable",
    blindSpots: [],
    confidence: 50,
    killShot: "",
  };
}
