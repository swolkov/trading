/**
 * Strategy assignment lookup — bridges code-level registry and DB-level configuration.
 *
 * The CODE registry (src/lib/strategies/registry.ts) declares what strategies EXIST.
 * The DB layer (StrategyAssignment table) declares where they RUN: which accounts have which
 * strategies enabled/observed/disabled, plus per-symbol contract caps.
 *
 * SAFETY: every read falls back to "code defaults" on any DB error (table missing, connection
 * dropped, etc.). The engine never breaks because the assignment table isn't seeded yet.
 *
 * CACHING: in-memory TTL cache to avoid hammering the DB on every engine cycle (engine runs
 * every minute, but assignments change rarely — admin toggles only).
 */

import { prisma } from "./db";
import { STRATEGIES, STRATEGY_REGISTRY_ONLY_SYMBOLS } from "./strategies/registry";

export type AccountKey =
  | "demo-futures"
  | "live-futures"
  | "paper-stocks"
  | "paper-crypto";

export type AssignmentStatus = "active" | "observation" | "disabled";

export interface ResolvedAssignment {
  accountKey: AccountKey;
  strategyId: string;
  status: AssignmentStatus;
  maxContractsOverride: number | null;
  source: "db" | "default";
}

const CACHE_TTL_MS = 30_000;
interface CacheEntry { data: Map<string, ResolvedAssignment>; expires: number; }
const cache = new Map<AccountKey, CacheEntry>();

/** Map engine tradingMode → AccountKey. */
export function accountKeyForFuturesMode(tradingMode: string): AccountKey {
  return tradingMode === "live" ? "live-futures" : "demo-futures";
}

/**
 * Load all assignments for an account, falling back to "default" for any strategy that has no
 * DB row. Cached for 30s. Defensive: returns code defaults if the DB call throws (e.g. table
 * doesn't exist because the migration hasn't been run yet).
 */
async function loadAssignmentsForAccount(accountKey: AccountKey): Promise<Map<string, ResolvedAssignment>> {
  const cached = cache.get(accountKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const result = new Map<string, ResolvedAssignment>();

  // Seed result with code defaults for every registered strategy.
  for (const strat of STRATEGIES) {
    result.set(strat.id, {
      accountKey,
      strategyId: strat.id,
      // Code default: registered strategies are "active" on their applicable accounts.
      // For now, assume any account can run any registered strategy unless DB says otherwise.
      status: "active",
      maxContractsOverride: null,
      source: "default",
    });
  }

  try {
    const rows = await prisma.strategyAssignment.findMany({ where: { accountKey } });
    for (const row of rows) {
      result.set(row.strategyId, {
        accountKey,
        strategyId: row.strategyId,
        status: (["active", "observation", "disabled"] as const).includes(row.status as AssignmentStatus)
          ? (row.status as AssignmentStatus)
          : "observation",
        maxContractsOverride: row.maxContractsOverride ?? null,
        source: "db",
      });
    }
  } catch (e) {
    // Table doesn't exist yet, or DB is unreachable. Fall through with code defaults.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[strategy-assignments] DB read failed for ${accountKey}, using code defaults:`, e instanceof Error ? e.message : e);
    }
  }

  cache.set(accountKey, { data: result, expires: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Get the resolved assignment for one (account, strategy). Returns null if the strategy
 * isn't registered at all (not just disabled in DB — completely unregistered in code).
 */
export async function getAssignment(accountKey: AccountKey, strategyId: string): Promise<ResolvedAssignment | null> {
  const all = await loadAssignmentsForAccount(accountKey);
  return all.get(strategyId) ?? null;
}

/**
 * Check if a (symbol, account) is observation-only — either because the symbol is in
 * STRATEGY_REGISTRY_ONLY_SYMBOLS and has no active assignment, or all its assignments are
 * status=observation/disabled.
 */
export async function isSymbolObservationOnly(accountKey: AccountKey, symbol: string): Promise<boolean> {
  if (!STRATEGY_REGISTRY_ONLY_SYMBOLS.has(symbol)) return false;
  const matchingStrategies = STRATEGIES.filter((s) => s.applicableSymbols.includes(symbol));
  if (matchingStrategies.length === 0) return true; // no strategy → observation
  const assignments = await loadAssignmentsForAccount(accountKey);
  return !matchingStrategies.some((s) => assignments.get(s.id)?.status === "active");
}

/**
 * Resolve the contract cap for (account, symbol, strategy). Priority:
 *   1. DB assignment.maxContractsOverride if set
 *   2. Code constant LIVE_MAX_CONTRACTS_PER_SYMBOL[symbol] (passed by caller)
 *   3. Caller-provided fallback (current sizing limit)
 */
export async function resolveMaxContracts(
  accountKey: AccountKey,
  strategyId: string | null,
  codeFallback: number | undefined,
  callerFallback: number,
): Promise<number> {
  if (strategyId) {
    const a = await loadAssignmentsForAccount(accountKey);
    const row = a.get(strategyId);
    if (row && row.maxContractsOverride !== null) return row.maxContractsOverride;
  }
  return codeFallback ?? callerFallback;
}

/** Force-clear the cache after an admin write so changes take effect immediately. */
export function invalidateAssignmentsCache(accountKey?: AccountKey) {
  if (accountKey) cache.delete(accountKey);
  else cache.clear();
}

/**
 * Returns ALL assignments grouped by (accountKey, strategyId) for the admin view.
 * Falls back to defaults for un-rowed combinations. Safe to call when table is missing.
 */
export async function listAllAssignments(): Promise<ResolvedAssignment[]> {
  const accounts: AccountKey[] = ["demo-futures", "live-futures", "paper-stocks", "paper-crypto"];
  const out: ResolvedAssignment[] = [];
  for (const acc of accounts) {
    const m = await loadAssignmentsForAccount(acc);
    for (const a of m.values()) out.push(a);
  }
  return out;
}
