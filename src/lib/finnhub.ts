const FINNHUB_URL = "https://finnhub.io/api/v1";
const API_KEY = () => process.env.FINNHUB_API_KEY || "";

async function finnhubFetch(endpoint: string) {
  const url = `${FINNHUB_URL}${endpoint}${endpoint.includes("?") ? "&" : "?"}token=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub error ${res.status}`);
  return res.json();
}

// ---------- Insider Transactions ----------

export interface InsiderTransaction {
  name: string;
  share: number;
  change: number;
  transactionDate: string;
  transactionCode: string; // P=purchase, S=sale
  transactionPrice: number;
}

export async function getInsiderTransactions(symbol: string): Promise<InsiderTransaction[]> {
  try {
    const data = await finnhubFetch(`/stock/insider-transactions?symbol=${symbol}`);
    return (data.data || []).slice(0, 20).map((t: Record<string, unknown>) => ({
      name: t.name || "",
      share: t.share || 0,
      change: t.change || 0,
      transactionDate: t.transactionDate || "",
      transactionCode: t.transactionCode || "",
      transactionPrice: t.transactionPrice || 0,
    }));
  } catch {
    return [];
  }
}

// ---------- Congressional Trading ----------

export interface CongressionalTrade {
  name: string;
  symbol: string;
  transactionType: string;
  transactionDate: string;
  amount: string;
  disclosure: string;
}

export async function getCongressionalTrading(symbol: string): Promise<CongressionalTrade[]> {
  try {
    const data = await finnhubFetch(`/stock/congressional-trading?symbol=${symbol}`);
    return (data.data || []).slice(0, 10);
  } catch {
    return [];
  }
}

// ---------- Earnings Calendar ----------

export interface EarningsCalendarItem {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  hour: string; // bmo = before market open, amc = after market close
}

export async function getEarningsCalendar(
  from?: string,
  to?: string
): Promise<EarningsCalendarItem[]> {
  try {
    const today = new Date();
    const fromDate = from || today.toISOString().split("T")[0];
    const toDate = to || new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const data = await finnhubFetch(`/calendar/earnings?from=${fromDate}&to=${toDate}`);
    return (data.earningsCalendar || []).slice(0, 50);
  } catch {
    return [];
  }
}

// ---------- Economic Calendar ----------

export interface EconomicEvent {
  country: string;
  event: string;
  time: string;
  impact: string; // low, medium, high
  actual: number | null;
  estimate: number | null;
  prev: number | null;
  unit: string;
}

export async function getEconomicCalendar(): Promise<EconomicEvent[]> {
  try {
    const today = new Date();
    const from = today.toISOString().split("T")[0];
    const to = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const data = await finnhubFetch(`/calendar/economic?from=${from}&to=${to}`);
    return (data.economicCalendar || [])
      .filter((e: Record<string, string>) => e.country === "US")
      .slice(0, 30);
  } catch {
    return [];
  }
}

// ---------- Social Sentiment ----------

export interface SocialSentiment {
  symbol: string;
  redditMentions: number;
  twitterMentions: number;
  redditPositive: number;
  redditNegative: number;
  twitterPositive: number;
  twitterNegative: number;
  score: number; // -1 to 1
}

export async function getSocialSentiment(symbol: string): Promise<SocialSentiment | null> {
  try {
    const data = await finnhubFetch(`/stock/social-sentiment?symbol=${symbol}&from=${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]}`);
    const reddit = data.reddit || [];
    const twitter = data.twitter || [];

    const redditMentions = reddit.reduce((s: number, r: Record<string, number>) => s + (r.mention || 0), 0);
    const twitterMentions = twitter.reduce((s: number, t: Record<string, number>) => s + (t.mention || 0), 0);
    const redditPos = reddit.reduce((s: number, r: Record<string, number>) => s + (r.positiveScore || 0), 0);
    const redditNeg = reddit.reduce((s: number, r: Record<string, number>) => s + (r.negativeScore || 0), 0);
    const twitterPos = twitter.reduce((s: number, t: Record<string, number>) => s + (t.positiveScore || 0), 0);
    const twitterNeg = twitter.reduce((s: number, t: Record<string, number>) => s + (t.negativeScore || 0), 0);

    const totalPos = redditPos + twitterPos;
    const totalNeg = redditNeg + twitterNeg;
    const score = totalPos + totalNeg > 0 ? (totalPos - totalNeg) / (totalPos + totalNeg) : 0;

    return {
      symbol,
      redditMentions,
      twitterMentions,
      redditPositive: redditPos,
      redditNegative: redditNeg,
      twitterPositive: twitterPos,
      twitterNegative: twitterNeg,
      score,
    };
  } catch {
    return null;
  }
}

// ---------- Analyst Recommendations ----------

export interface AnalystUpgradeDowngrade {
  symbol: string;
  company: string;
  fromGrade: string;
  toGrade: string;
  action: string; // upgrade, downgrade, init, reiterated
  time: string;
}

export async function getUpgradesDowngrades(symbol: string): Promise<AnalystUpgradeDowngrade[]> {
  try {
    const data = await finnhubFetch(`/stock/upgrade-downgrade?symbol=${symbol}`);
    return (data || []).slice(0, 10).map((d: Record<string, string>) => ({
      symbol: d.symbol || symbol,
      company: d.company || "",
      fromGrade: d.fromGrade || "",
      toGrade: d.toGrade || "",
      action: d.action || "",
      time: d.gradeTime || "",
    }));
  } catch {
    return [];
  }
}

// ---------- Recommendation Trends ----------

export interface RecommendationTrend {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export async function getRecommendationTrends(symbol: string): Promise<RecommendationTrend[]> {
  try {
    return await finnhubFetch(`/stock/recommendation?symbol=${symbol}`);
  } catch {
    return [];
  }
}

// ---------- Company Peers ----------

export async function getCompanyPeers(symbol: string): Promise<string[]> {
  try {
    return await finnhubFetch(`/stock/peers?symbol=${symbol}&grouping=industry`);
  } catch {
    return [];
  }
}
