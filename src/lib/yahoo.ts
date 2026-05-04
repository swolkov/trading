// eslint-disable-next-line @typescript-eslint/no-require-imports
const yahooFinance = require("yahoo-finance2").default || require("yahoo-finance2");

// ---------- Company Profile ----------

export interface CompanyProfile {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  description: string;
  website: string;
  marketCap: number;
  employees: number;
  country: string;
  exchange: string;
  currency: string;
}

export async function getCompanyProfile(
  symbol: string
): Promise<CompanyProfile | null> {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ["assetProfile", "price"],
    });
    const profile = result.assetProfile;
    const price = result.price;
    if (!profile || !price) return null;

    return {
      symbol,
      name: price.longName || price.shortName || symbol,
      sector: profile.sector || "N/A",
      industry: profile.industry || "N/A",
      description: profile.longBusinessSummary || "",
      website: profile.website || "",
      marketCap: price.marketCap || 0,
      employees: profile.fullTimeEmployees || 0,
      country: profile.country || "",
      exchange: price.exchangeName || "",
      currency: price.currency || "USD",
    };
  } catch {
    return null;
  }
}

// ---------- Key Statistics ----------

export interface KeyStats {
  pe: number | null;
  forwardPe: number | null;
  peg: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  eps: number | null;
  forwardEps: number | null;
  beta: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyDayAvg: number | null;
  twoHundredDayAvg: number | null;
  avgVolume: number | null;
  dividendYield: number | null;
  dividendRate: number | null;
  exDividendDate: string | null;
  shortRatio: number | null;
  shortPercentOfFloat: number | null;
  earningsDate: string | null;
  revenue: number | null;
  revenueGrowth: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  profitMargin: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  freeCashFlow: number | null;
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  recommendationMean: number | null;
  recommendationKey: string | null;
  numberOfAnalysts: number | null;
}

export async function getKeyStats(symbol: string): Promise<KeyStats | null> {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: [
        "defaultKeyStatistics",
        "financialData",
        "summaryDetail",
        "earningsTrend",
        "price",
      ],
    });

    const stats = result.defaultKeyStatistics;
    const fin = result.financialData;
    const detail = result.summaryDetail;
    const price = result.price;

    return {
      pe: detail?.trailingPE ?? null,
      forwardPe: detail?.forwardPE ?? stats?.forwardPE ?? null,
      peg: stats?.pegRatio ?? null,
      priceToBook: stats?.priceToBook ?? null,
      priceToSales: stats?.priceToSalesTrailing12Months ?? null,
      eps: stats?.trailingEps ?? null,
      forwardEps: stats?.forwardEps ?? null,
      beta: stats?.beta ?? null,
      fiftyTwoWeekHigh: detail?.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: detail?.fiftyTwoWeekLow ?? null,
      fiftyDayAvg: detail?.fiftyDayAverage ?? null,
      twoHundredDayAvg: detail?.twoHundredDayAverage ?? null,
      avgVolume: detail?.averageVolume ?? null,
      dividendYield: detail?.dividendYield ?? null,
      dividendRate: detail?.dividendRate ?? null,
      exDividendDate: detail?.exDividendDate
        ? new Date(detail.exDividendDate).toISOString()
        : null,
      shortRatio: stats?.shortRatio ?? null,
      shortPercentOfFloat: stats?.shortPercentOfFloat ?? null,
      earningsDate: null,
      revenue: fin?.totalRevenue ?? null,
      revenueGrowth: fin?.revenueGrowth ?? null,
      grossMargin: fin?.grossMargins ?? null,
      operatingMargin: fin?.operatingMargins ?? null,
      profitMargin: fin?.profitMargins ?? null,
      returnOnEquity: fin?.returnOnEquity ?? null,
      returnOnAssets: fin?.returnOnAssets ?? null,
      debtToEquity: fin?.debtToEquity ?? null,
      currentRatio: fin?.currentRatio ?? null,
      freeCashFlow: fin?.freeCashflow ?? null,
      targetMeanPrice: fin?.targetMeanPrice ?? null,
      targetHighPrice: fin?.targetHighPrice ?? null,
      targetLowPrice: fin?.targetLowPrice ?? null,
      recommendationMean: fin?.recommendationMean ?? null,
      recommendationKey: fin?.recommendationKey ?? null,
      numberOfAnalysts: fin?.numberOfAnalystOpinions ?? null,
    };
  } catch {
    return null;
  }
}

// ---------- Financial Statements ----------

export interface IncomeStatement {
  date: string;
  revenue: number;
  costOfRevenue: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingIncome: number;
  netIncome: number;
  eps: number;
  ebitda: number;
}

export async function getIncomeStatements(
  symbol: string
): Promise<IncomeStatement[]> {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ["incomeStatementHistory"],
    });
    const statements = result.incomeStatementHistory?.incomeStatementHistory;
    if (!statements) return [];

    return statements.map((s: Record<string, number | string | Date | null>) => ({
      date: s.endDate ? new Date(s.endDate).toISOString().split("T")[0] : "",
      revenue: s.totalRevenue || 0,
      costOfRevenue: s.costOfRevenue || 0,
      grossProfit: s.grossProfit || 0,
      operatingExpenses: s.totalOperatingExpenses || 0,
      operatingIncome: s.operatingIncome || 0,
      netIncome: s.netIncome || 0,
      eps: s.netIncome && s.totalRevenue ? Number(s.netIncome) / Number(s.totalRevenue) : 0,
      ebitda: s.ebitda || 0,
    }));
  } catch {
    return [];
  }
}

// ---------- Earnings ----------

export interface EarningsData {
  quarterly: {
    date: string;
    actual: number | null;
    estimate: number | null;
    surprise: number | null;
    surprisePercent: number | null;
  }[];
  annual: {
    year: number;
    earnings: number;
    revenue: number;
  }[];
}

export async function getEarnings(
  symbol: string
): Promise<EarningsData | null> {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ["earnings", "earningsHistory"],
    });

    const earnings = result.earnings;
    const history = result.earningsHistory;

    const quarterly =
      history?.history?.map((h: Record<string, number | string | Date | null>) => ({
        date: h.quarter ? new Date(h.quarter).toISOString().split("T")[0] : "",
        actual: h.epsActual ?? null,
        estimate: h.epsEstimate ?? null,
        surprise: h.epsDifference ?? null,
        surprisePercent: h.surprisepercent ?? null,
      })) || [];

    const annual =
      earnings?.financialsChart?.yearly?.map((y: Record<string, number | string>) => ({
        year: y.date,
        earnings: y.earnings || 0,
        revenue: y.revenue || 0,
      })) || [];

    return { quarterly, annual };
  } catch {
    return null;
  }
}

// ---------- Analyst Recommendations ----------

export interface AnalystRecommendation {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export async function getAnalystRecommendations(
  symbol: string
): Promise<AnalystRecommendation[]> {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ["recommendationTrend"],
    });
    const trends = result.recommendationTrend?.trend;
    if (!trends) return [];

    return trends.map((t: Record<string, number | string>) => ({
      period: t.period || "",
      strongBuy: t.strongBuy || 0,
      buy: t.buy || 0,
      hold: t.hold || 0,
      sell: t.sell || 0,
      strongSell: t.strongSell || 0,
    }));
  } catch {
    return [];
  }
}
