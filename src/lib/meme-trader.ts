// Meme Lab LIVE execution — real Solana swaps via Jupiter for the automated meme bot.
// Hard-isolated: signs with MEME_WALLET_SECRET (a dedicated wallet that holds ONLY the risk budget).
// Every buy is honeypot-checked first (must have a working SELL route back to SOL) so we never buy
// a token we can't exit. validateOnly mode confirms the whole path (quote + swap build) WITHOUT sending.
import { Connection, Keypair, VersionedTransaction, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = "https://lite-api.jup.ag/swap/v1";

function rpcUrl(): string {
  const k = process.env.HELIUS_API_KEY;
  return k ? `https://mainnet.helius-rpc.com/?api-key=${k}` : "https://api.mainnet-beta.solana.com";
}
export function walletConfigured(): boolean { return !!process.env.MEME_WALLET_SECRET; }
function loadWallet(): Keypair { return Keypair.fromSecretKey(bs58.decode(process.env.MEME_WALLET_SECRET || "")); }
export function walletAddress(): string | null { try { return loadWallet().publicKey.toBase58(); } catch { return null; } }

export async function getSolBalance(): Promise<number> {
  try { const c = new Connection(rpcUrl(), "confirmed"); return (await c.getBalance(loadWallet().publicKey)) / 1e9; }
  catch { return 0; }
}
export async function getTokenBalanceRaw(mint: string): Promise<string> {
  try {
    const c = new Connection(rpcUrl(), "confirmed");
    const res = await c.getParsedTokenAccountsByOwner(loadWallet().publicKey, { mint: new (await import("@solana/web3.js")).PublicKey(mint) });
    let raw = BigInt(0);
    for (const a of res.value) raw += BigInt(a.account.data.parsed.info.tokenAmount.amount || "0");
    return raw.toString();
  } catch { return "0"; }
}

interface Quote { outAmount: string; [k: string]: unknown }
async function jupQuote(inputMint: string, outputMint: string, amountRaw: string, slippageBps = 300): Promise<Quote | null> {
  try {
    const u = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const q = await r.json();
    return q && q.outAmount ? q : null;
  } catch { return null; }
}

export async function solPriceUsd(): Promise<number> {
  const q = await jupQuote(SOL, USDC, "1000000000");   // 1 SOL → USDC (6 decimals)
  return q ? Number(q.outAmount) / 1e6 : 0;
}

// HONEYPOT GUARD: is there a real SELL route back to SOL? If not, never buy.
export async function canSell(mint: string, tokenAmountRaw = "1000000"): Promise<boolean> {
  const q = await jupQuote(mint, SOL, tokenAmountRaw);
  return !!q && Number(q.outAmount) > 0;
}

async function executeSwap(quote: Quote, validateOnly: boolean): Promise<{ ok: boolean; sig?: string; validated?: boolean; error?: string }> {
  try {
    const wallet = loadWallet();
    const r = await fetch(`${JUP}/swap`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ok: false, error: `swap build ${r.status}` };
    const { swapTransaction } = await r.json();
    if (!swapTransaction) return { ok: false, error: "no swap tx" };
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([wallet]);
    if (validateOnly) return { ok: true, validated: true };   // built + signed OK, but NOT sent — no spend
    const conn = new Connection(rpcUrl(), "confirmed");
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");
    return { ok: true, sig };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}

export interface TradeResult { ok: boolean; sig?: string; validated?: boolean; error?: string; expectedOut?: string; solSpentLamports?: number }

// BUY: spend usdAmount worth of SOL to acquire `mint`. Honeypot-checked before spending.
export async function buyToken(mint: string, usdAmount: number, validateOnly: boolean): Promise<TradeResult> {
  if (!walletConfigured()) return { ok: false, error: "wallet not configured" };
  if (!(await canSell(mint))) return { ok: false, error: "no sell route (honeypot) — blocked" };
  const px = await solPriceUsd();
  if (px <= 0) return { ok: false, error: "no SOL price" };
  const lamports = Math.floor((usdAmount / px) * 1e9);
  const quote = await jupQuote(SOL, mint, String(lamports));
  if (!quote) return { ok: false, error: "no buy route" };
  const res = await executeSwap(quote, validateOnly);
  return { ...res, expectedOut: quote.outAmount, solSpentLamports: lamports };
}

// CASH OUT: send all SOL in the wallet to a destination address (e.g. your Kraken SOL deposit address).
// The ONLY function that can move funds OUT of the wallet — password-gated at the API layer.
export async function sweepSolTo(toAddress: string, validateOnly: boolean): Promise<TradeResult> {
  if (!walletConfigured()) return { ok: false, error: "wallet not configured" };
  try {
    const conn = new Connection(rpcUrl(), "confirmed");
    const kp = loadWallet();
    const to = new PublicKey(toAddress);                       // throws if the address is malformed
    const lamports = await conn.getBalance(kp.publicKey);
    const send = lamports - 10000;                             // leave a little for the network fee
    if (send <= 0) return { ok: false, error: "nothing to send" };
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey }).add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: send }));
    tx.sign(kp);
    if (validateOnly) return { ok: true, validated: true };
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    return { ok: true, sig, expectedOut: String(send) };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}

// SELL: dump the full token balance back to SOL.
export async function sellToken(mint: string, validateOnly: boolean): Promise<TradeResult> {
  if (!walletConfigured()) return { ok: false, error: "wallet not configured" };
  const bal = await getTokenBalanceRaw(mint);
  if (BigInt(bal) <= BigInt(0)) return { ok: false, error: "no token balance" };
  const quote = await jupQuote(mint, SOL, bal, 500);   // wider slippage on exit
  if (!quote) return { ok: false, error: "no sell route" };
  const res = await executeSwap(quote, validateOnly);
  return { ...res, expectedOut: quote.outAmount };
}
