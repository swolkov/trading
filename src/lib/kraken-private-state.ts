import { createHash } from "node:crypto";
import { publicPairFor } from "@/lib/kraken-pairs";
import type { OpenOrder } from "@/lib/kraken";

export interface StopReceipt { pair: string; side: string; ordertype: string; volume: number; price: number; acceptedAt: string }
const RECEIPT_PREFIX = "kraken_reduce_only_receipt_";
const receiptKey = (id: string) => `${RECEIPT_PREFIX}${id}`;

export function parseStopReceipt(raw: string): StopReceipt {
  const r = JSON.parse(raw) as Partial<StopReceipt> | null;
  if (!r || typeof r.pair !== "string" || !r.pair || !["buy", "sell"].includes(r.side ?? "")
    || typeof r.ordertype !== "string" || !r.ordertype.includes("stop")
    || typeof r.volume !== "number" || !Number.isFinite(r.volume) || r.volume <= 0
    || typeof r.price !== "number" || !Number.isFinite(r.price) || r.price <= 0
    || typeof r.acceptedAt !== "string" || !Number.isFinite(Date.parse(r.acceptedAt))) {
    throw new Error("Invalid reduce-only stop receipt; broker verification required");
  }
  return r as StopReceipt;
}

// Hold one database lock through the HTTP response: allocating a nonce alone does not
// prevent requests from arriving out of order from different server instances.
export async function orderedPrivateRequest(
  apiKey: string, method: string, params: Record<string, string>,
  send: (nonce: string) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const { prisma } = await import("@/lib/db");
  const key = `kraken_nonce_${createHash("sha256").update(apiKey).digest("hex").slice(0, 24)}`;
  let acceptedNonce: string | undefined;
  const needsReceipt = method === "AddOrder" && params.reduce_only === "true" && params.validate !== "true" && (params.ordertype ?? "").includes("stop");
  const receipt: StopReceipt = { pair: params.pair, side: params.type, ordertype: params.ordertype,
    volume: Number(params.volume), price: Number(params.price), acceptedAt: new Date().toISOString() };
  const writes = (result: Record<string, unknown>) => {
    const ids = result.txid;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !id)) throw new Error("accepted reduce-only order has no readable order id");
    return ids.map((id: string) => ({ where: { key: receiptKey(id) }, create: { key: receiptKey(id), value: JSON.stringify(receipt) }, update: { value: JSON.stringify(receipt) } }));
  };
  return preserveAcceptedResponse(async (accepted) => prisma.$transaction(async (tx) => {
    // One ordinary 15-second broker request must be able to finish ahead of a waiter.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '20s'");
    await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text", key);
    const rows = await tx.$queryRawUnsafe<{ value: string }[]>(
      `INSERT INTO "AgentConfig" (key,value) VALUES ($1, floor(extract(epoch FROM clock_timestamp())*1000000)::bigint::text)
       ON CONFLICT (key) DO UPDATE SET value=greatest("AgentConfig".value::bigint+1,
         floor(extract(epoch FROM clock_timestamp())*1000000)::bigint)::text RETURNING value`, key,
    );
    const nonce = rows[0]?.value;
    if (!nonce || !/^\d+$/.test(nonce)) throw new Error("Kraken nonce allocation failed");
    const result = await send(nonce);
    acceptedNonce = nonce;
    accepted(result); // preserve broker success even if the database commit fails
    if (needsReceipt) for (const write of writes(result)) await tx.agentConfig.upsert(write);
    return result;
  }, { maxWait: 5000, timeout: 40000 }), async (result) => {
    // Retry only idempotent local bookkeeping. Never repeat the broker request.
    // The failed transaction may also have rolled back the nonce high-water mark.
    // Preserve it with the receipts; another request's newer nonce always wins.
    await prisma.$transaction(async (tx) => {
      if (acceptedNonce) await tx.$executeRawUnsafe(
        `INSERT INTO "AgentConfig" (key,value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=greatest("AgentConfig".value::bigint, $2::bigint)::text`, key, acceptedNonce,
      );
      if (needsReceipt) for (const write of writes(result)) await tx.agentConfig.upsert(write);
    });
  });
}

export async function preserveAcceptedResponse(
  run: (accepted: (result: Record<string, unknown>) => void) => Promise<Record<string, unknown>>,
  recover: (result: Record<string, unknown>) => Promise<void>,
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> | undefined;
  try { return await run((value) => { result = value; }); }
  catch (error) {
    if (!result) throw error;
    try { await recover(result); }
    catch { throw new Error(`Broker accepted request; receipt persistence failed. Reconcile accepted order ids ${JSON.stringify(result.txid ?? [])} before retrying.`); }
    return result;
  }
}

export function receiptConfirms(order: OpenOrder, receipt: StopReceipt): boolean {
  // An explicit broker flag wins, including false. Receipt inference is only for an
  // omitted flag and an unchanged, exact order identity accepted with reduce_only=true.
  return order.reduceOnly === undefined && publicPairFor(order.pair) === publicPairFor(receipt.pair) && order.pair.split(":")[1] === receipt.pair.split(":")[1] && order.side === receipt.side
    && order.ordertype === receipt.ordertype && order.vol === receipt.volume && order.price === receipt.price;
}

export async function withReduceOnlyReceipts(orders: OpenOrder[]): Promise<OpenOrder[]> {
  const unknown = orders.filter((o) => o.reduceOnly === undefined && o.ordertype.includes("stop"));
  if (!unknown.length) return orders;
  // A failed read propagates. Treating an unavailable store as empty would churn stops.
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: unknown.map((o) => receiptKey(o.txid)) } } });
  return applyReduceOnlyReceipts(orders, new Map(rows.map((r) => [r.key.slice(RECEIPT_PREFIX.length), parseStopReceipt(r.value)])));
}

export function applyReduceOnlyReceipts(orders: OpenOrder[], receipts: ReadonlyMap<string, StopReceipt>): OpenOrder[] {
  return orders.map((o) => {
    const r = receipts.get(o.txid);
    if (r && o.reduceOnly === undefined && !receiptConfirms(o, r)) throw new Error(`Stop ${o.txid} differs from its reduce-only receipt; broker verification required`);
    return r && receiptConfirms(o, r) ? { ...o, reduceOnly: true } : o;
  });
}
