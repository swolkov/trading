import {
  contractQualityFailures, isOptionsResearch, OPTIONS_DESK_RULES, researchSignals, screenResearchContracts,
  type OptionsResearch, type ResearchContract,
} from "./options-desk-model";
import type { AccountSnapshot, LiveSnapshot } from "./options-quote-store";
import { OPTIONS_ACCOUNT_NUMBER } from "./options-snapshot-validation";

export const OPTIONS_OBSERVATION_PREFIX = "options_observation_v1:";
export const OPTIONS_RESEARCH_VERSION = "daily-range-20-sma-50-200-v1";
export interface SymbolEvidence {
  symbol: string; setup: string; session: string | null; contracts: number;
  minimumPremium: number | null; affordableLongs: number; qualityContracts: number;
  freshQuotes: number; researchCandidates: number;
  exclusions: { reason: string; contracts: number }[];
}
export interface OptionsObservation {
  schema: 1; ruleVersion: string; capturedAt: string; screenedAt: string;
  lossCeiling: number | null; buyingPower: number | null; accountAt: string | null;
  ruleSettings: typeof OPTIONS_DESK_RULES; symbols: SymbolEvidence[]; quotes: ResearchContract[]; errors: string[];
}
const cents = (n: number) => Math.round(n * 100) / 100;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
export function validEvidenceAccount(account: AccountSnapshot | null): account is AccountSnapshot {
  return !!account && account.accountNumber === OPTIONS_ACCOUNT_NUMBER && positive(account.totalValue)
    && Number.isFinite(account.buyingPower) && account.buyingPower >= 0 && Number.isFinite(Date.parse(account.at));
}
export function buildOptionsObservation(
  data: OptionsResearch, lossCeiling: number | null, account: AccountSnapshot | null, now = Date.now(),
): OptionsObservation {
  const signals = researchSignals(data.bars, now);
  const buyingPower = validEvidenceAccount(account) ? account.buyingPower : null;
  const cap = positive(lossCeiling) ? lossCeiling : null;
  const candidates = cap && buyingPower != null ? screenResearchContracts(data, cap, buyingPower, now) : [];
  const symbols = [...new Set([...Object.keys(data.bars), ...data.contracts.map(c => c.symbol)])].sort();
  return {
    ruleSettings: { ...OPTIONS_DESK_RULES }, schema: 1, ruleVersion: OPTIONS_RESEARCH_VERSION, capturedAt: data.capturedAt,
    screenedAt: new Date(now).toISOString(), lossCeiling: cap, buyingPower,
    accountAt: validEvidenceAccount(account) ? account.at : null,
    symbols: symbols.map(symbol => {
      const contracts = data.contracts.filter(c => c.symbol === symbol);
      const signal = signals.find(s => s.symbol === symbol);
      const reasons = new Map<string, number>();
      let affordableLongs = 0, qualityContracts = 0, freshQuotes = 0;
      for (const c of contracts) {
        const failures = contractQualityFailures(c, now);
        if (!failures.length) qualityContracts++;
        const fullCost = Math.ceil(c.ask * 100 - 1e-8) + OPTIONS_DESK_RULES.feeReservePerContract;
        const budgetFits = positive(c.ask) && cap != null && buyingPower != null && fullCost > 0 && fullCost <= Math.min(cap, buyingPower);
        if (budgetFits) affordableLongs++;
        else failures.push(!positive(c.ask) ? "Long premium unavailable" : cap == null || buyingPower == null ? "Account or risk budget unavailable" : "Long premium exceeds budget");
        if (Date.parse(c.at) <= now && now - Date.parse(c.at) <= 15000) freshQuotes++;
        else failures.push("Quote needs refresh before execution");
        if (c.delta == null || Math.abs(c.delta) < 0.35 || Math.abs(c.delta) > 0.75) failures.push("Long-option delta outside research range");
        if (!signal || !["20-session breakout", "20-session breakdown"].includes(signal.setup)) failures.push("No current directional entry signal");
        for (const reason of failures) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      const prices = contracts.filter(c => positive(c.ask)).map(c => Math.ceil(c.ask * 100 - 1e-8));
      return { symbol, setup: signal?.setup ?? "Insufficient or stale daily history", session: signal?.day ?? null,
        contracts: contracts.length, minimumPremium: prices.length ? Math.min(...prices) : null,
        affordableLongs, qualityContracts, freshQuotes,
        researchCandidates: candidates.filter(c => c.symbol === symbol).length,
        exclusions: [...reasons].map(([reason, count]) => ({ reason, contracts: count })),
      };
    }),
    // Preserve observed bid/ask and source timestamps. Never infer option fills or returns.
    quotes: structuredClone(data.contracts), errors: [...data.errors],
  };
}
export function optionsRiskView(account: AccountSnapshot | null, ceiling: number | null, now = Date.now()) {
  const valid = validEvidenceAccount(account);
  const equity = valid ? account.totalValue : null;
  const age = valid ? now - Date.parse(account.at) : null;
  return {
    equity, accountAt: valid ? account.at : null,
    accountFresh: age != null && age >= 0 && age <= 15 * 60_000,
    suggestedMin: equity == null ? null : cents(Math.min(equity * 0.01, positive(ceiling) ? ceiling : Infinity)),
    suggestedMax: equity == null ? null : cents(Math.min(equity * 0.02, positive(ceiling) ? ceiling : Infinity)),
    ceilingPct: equity == null || !positive(ceiling) ? null : cents(ceiling / equity * 100),
    fiveLossDrawdownPct: equity == null || !positive(ceiling) ? null : cents(5 * ceiling / equity * 100),
    automaticRiskIncrease: false,
    // A balance change is not a return. Cash flows and complete fills must be reconciled first.
    netTradingProfit: null, netReturnPct: null, tradingDrawdownPct: null,
  };
}
export function optionsPerformanceCoverage(live: LiveSnapshot | null) {
  return {
    observedOrders: Array.isArray(live?.orders) ? live.orders.length : null,
    observedPositions: Array.isArray(live?.positions) ? live.positions.length : null,
    snapshotAt: live?.at ?? null,
    verifiedRoundTrips: null, winRate: null, expectancy: null,
    gaps: ["Matched opening and closing executions with contract IDs", "Actual commissions and regulatory fees",
      "Deposits, withdrawals and assignment reconciliation", "Strategy version recorded before each entry"],
  };
}
export function parseOptionsObservation(value: string): OptionsObservation | null {
  try {
    const o = JSON.parse(value) as OptionsObservation;
    if (o.schema !== 1 || typeof o.ruleVersion !== "string" || !Number.isFinite(Date.parse(o.capturedAt))
      || !Number.isFinite(Date.parse(o.screenedAt)) || !Array.isArray(o.symbols) || !Array.isArray(o.quotes)
      || !Array.isArray(o.errors) || !o.errors.every(e => typeof e === "string")) return null;
    if (!o.symbols.every(s => s && typeof s.symbol === "string" && typeof s.setup === "string"
      && [s.contracts, s.affordableLongs, s.qualityContracts, s.freshQuotes, s.researchCandidates].every(n => Number.isSafeInteger(n) && n >= 0)
      && (s.minimumPremium === null || positive(s.minimumPremium)) && Array.isArray(s.exclusions)
      && s.exclusions.every(e => typeof e.reason === "string" && Number.isSafeInteger(e.contracts) && e.contracts >= 0))) return null;
    if (!isOptionsResearch({ source: "Robinhood MCP", capturedAt: o.capturedAt, bars: {}, contracts: o.quotes, scans: [], errors: o.errors })) return null;
    return o;
  } catch { return null; }
}

export function summarizeOptionsHistory(observations: OptionsObservation[]) {
  const quotes = new Set<string>(), sessions = { calls: new Set<string>(), puts: new Set<string>() };
  const dates: string[] = [];
  for (const o of observations) {
    for (const q of o.quotes) { quotes.add(`${q.id}:${q.at}`); dates.push(q.at); }
    for (const s of o.symbols) {
      const group = s.setup === "20-session breakout" ? sessions.calls : s.setup === "20-session breakdown" ? sessions.puts : null;
      if (group && s.session) group.add(`${o.ruleVersion}:${s.symbol}:${s.session}`);
    }
  }
  dates.sort();
  return {
    captures: observations.length, distinctContractQuotes: quotes.size,
    oldestQuote: dates[0] ?? null, newestQuote: dates.at(-1) ?? null,
    callSetupSessions: sessions.calls.size, putSetupSessions: sessions.puts.size,
    recent: observations.slice(0, 12).map(o => ({ capturedAt: o.capturedAt, screenedAt: o.screenedAt,
      ruleVersion: o.ruleVersion, symbols: o.symbols.length, contracts: o.quotes.length,
      candidates: o.symbols.reduce((n, s) => n + s.researchCandidates, 0), errors: o.errors.length })),
  };
}
