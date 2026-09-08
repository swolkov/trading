// ── KRAKEN READ BUDGET ──────────────────────────────────────────────────────────────────────
// Kraken's private API has one rate counter per key (≈15–20 points, decaying ~0.33–0.5/s)
// and one strictly-increasing nonce per key. Every open admin page polling /api/margin/status
// spends from the same budget as the guardian and the executor. Seen live Sep 8 2026
// 00:50 UTC: the guardian's OpenPositions read failed "EAPI:Rate limit exceeded" while three
// dashboard pollers were running, and 02:30 UTC a status poll collided with the guardian on
// the nonce. Two rules follow:
//   1. Display routes share ONE short-lived snapshot per instance (displayCache) instead of
//      each issuing their own private calls.
//   2. Idempotent READS retry once on a transient Kraken error (rate limit, nonce, busy).
//      Writes (AddOrder, CancelOrder) never retry here — the executor owns that.

export function isTransientKrakenError(e: unknown): boolean {
  return /Rate limit|Invalid nonce|EService:Busy|EService:Unavailable|EGeneral:Temporary/i.test(String(e));
}

export interface RetryOpts { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry an idempotent read once (by default) on a transient Kraken error; rethrow anything else. */
export async function withReadRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 1, delayMs = opts.delayMs ?? 1500, sleep = opts.sleep ?? realSleep;
  let attempt = 0;
  for (;;) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= retries || !isTransientKrakenError(e)) throw e;
      attempt++;
      await sleep(delayMs);
    }
  }
}

export interface Cached<T> { value: T; at: number; stale: boolean }
export interface CacheOpts { ttlMs: number; graceMs?: number; now?: () => number }

/**
 * Per-instance memo for DISPLAY reads: concurrent callers share one in-flight read; a value
 * younger than ttlMs is served as-is; on a transient failure a value younger than graceMs
 * is served marked `stale` (the page says "as of", never "no positions"). Never used by the
 * guardian or the executor — they need the fresh read and fail closed on their own terms.
 */
export function displayCache<T>(fn: () => Promise<T>, opts: CacheOpts): () => Promise<Cached<T>> {
  const now = opts.now ?? (() => Date.now());
  const graceMs = opts.graceMs ?? opts.ttlMs * 4;
  let last: Cached<T> | null = null;
  let inflight: Promise<Cached<T>> | null = null;
  return async () => {
    const t = now();
    if (last && t - last.at < opts.ttlMs) return { ...last, stale: false };
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const value = await fn();
        last = { value, at: now(), stale: false };
        return last;
      } catch (e) {
        if (last && isTransientKrakenError(e) && now() - last.at < graceMs) return { ...last, stale: true };
        throw e;
      } finally { inflight = null; }
    })();
    return inflight;
  };
}
