// CRYPTO REGIME (Sep 15 2026) — the desk brief's MARKET REGIME section, gathered from public
// data and the desk's own stamps, and written to the vault as Brain/crypto-regime.md (stale since
// June until now). Public Kraken OHLC/Ticker only — never a private read. Every source is a soft
// catch: a missing feed leaves its line "—".
//
// Refreshed by the daily desk brief (margin-brief-build.ts) and by runMarginSynthesis; this
// module imports nothing from the synthesis so the two cannot form a cycle.
import { getKrakenOHLC, type KrakenBar } from "@/lib/kraken-margin";
import { krakenPublic } from "@/lib/kraken";
import { prisma } from "@/lib/db";
import { vaultWrite } from "@/lib/vault";
import { SCAN_UNIVERSE } from "@/lib/kraken-pairs";
import { barFeatures, type TfFeatures } from "@/lib/margin-scanner";
import { regimeLabel } from "@/lib/margin-regime-label";
import { readLatestDerivatives } from "@/lib/margin-derivatives";
import { readEventPolicy } from "@/lib/margin-events";
import { renderRegimeLines, type BriefMajor, type BriefRegime } from "@/lib/margin-brief";

export const CRYPTO_REGIME_PATH = "Brain/crypto-regime.md";

/** Annualised realised volatility of the last `n` completed daily closes (log returns). */
export function realizedVol(closes: number[], n = 20): number | null {
  const xs = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (xs.length < n + 1) return null;
  const tail = xs.slice(-(n + 1));
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) rets.push(Math.log(tail[i] / tail[i - 1]));
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(365);
}

/** Breadth over the universe: coins whose 1d close is above their 20d SMA (needs the scan's features). */
export function breadthOf(features: Record<string, TfFeatures> | null | undefined): { above: number; of: number } | null {
  if (!features) return null;
  let above = 0, of = 0;
  for (const c of SCAN_UNIVERSE) {
    const f = features[`${c}:1d`];
    if (!f || !Number.isFinite(f.close) || !Number.isFinite(f.sma20)) continue;
    of++; if (f.close > f.sma20) above++;
  }
  return of ? { above, of } : null;
}

const dedupDaily = (bars: KrakenBar[]) => bars.filter((b, i) => i === bars.length - 1 || bars[i + 1].t !== b.t);

async function majorOf(coin: "BTC" | "ETH", features: Record<string, TfFeatures> | null | undefined): Promise<{ major: BriefMajor | null; dailyCloses: number[] }> {
  let d1 = features?.[`${coin}:1d`] ?? null;
  let h4 = features?.[`${coin}:4h`] ?? null;
  let dailyCloses: number[] = [];
  try {
    const bars = dedupDaily(await getKrakenOHLC(`${coin}/USD`, 1440));
    dailyCloses = bars.slice(0, -1).map((b) => b.c);
    if (!d1) d1 = barFeatures(bars, 1440);
  } catch { /* soft */ }
  if (!h4) { try { h4 = barFeatures(await getKrakenOHLC(`${coin}/USD`, 240), 240); } catch { /* soft */ } }
  const major = d1 && Number.isFinite(d1.close) && Number.isFinite(d1.sma20) ? { close: d1.close, sma20: d1.sma20, label: regimeLabel(d1, h4) } : null;
  return { major, dailyCloses };
}

/** Gather the regime. `features` (from scanUniverse) saves the 1d/4h fetches and enables breadth. */
export async function gatherRegime(features: Record<string, TfFeatures> | null = null): Promise<BriefRegime> {
  const [btc, eth] = await Promise.all([majorOf("BTC", features), majorOf("ETH", features)]);
  let ethBtc: number | null = null;
  try {
    const t = await krakenPublic("Ticker", { pair: "ETHXBT" });
    const c = (Object.values(t)[0] as { c?: string[] } | undefined)?.c?.[0];
    ethBtc = c ? parseFloat(c) : null;
    if (ethBtc != null && !Number.isFinite(ethBtc)) ethBtc = null;
  } catch { ethBtc = null; }
  const deriv = await readLatestDerivatives().catch(() => null);
  const event = await readEventPolicy().then((p) => ({ mode: p.mode, reason: p.reason })).catch(() => null);
  let btcShock: string | null = null;
  try {
    const raw = (await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_intel_latest" } }))?.value;
    const p = raw ? (JSON.parse(raw) as { btcShock?: { barsOk: boolean; shock: string | null } }) : null;
    btcShock = p?.btcShock ? (!p.btcShock.barsOk ? "unknown" : p.btcShock.shock ? `shock-${p.btcShock.shock}` : "calm") : null;
  } catch { btcShock = null; }
  return {
    btc: btc.major, eth: eth.major, ethBtc,
    breadth: breadthOf(features),
    realizedVol20: realizedVol(btc.dailyCloses, 20),
    funding: deriv ? { btc: deriv.byCoin.BTC?.funding8hRel ?? null, eth: deriv.byCoin.ETH?.funding8hRel ?? null } : null,
    fearGreed: deriv?.fearGreed ? { value: deriv.fearGreed.value, label: deriv.fearGreed.label } : null,
    event, btcShock,
  };
}

/** Pure: the vault page. */
export function renderCryptoRegime(r: BriefRegime, at: string): string {
  const day = at.slice(0, 10);
  const headline = r.btc?.label ?? "unknown";
  return [
    "---", `last_updated: "${day}"`, `updated_by: "margin-desk"`, "tags: [regime, crypto, margin]", "---", "",
    "# Crypto Market Regime", "",
    `> Written by rule from public Kraken data and the desk's own stamps (margin-crypto-regime.ts) at ${at.slice(11, 16)}Z. Not a gate — the only regime filter this desk tested (selective-btc) lost at t=−6; labels are measured on the paper record first.`, "",
    "## Current Regime", `**BTC**: \`${headline}\` · **ETH**: \`${r.eth?.label ?? "unknown"}\``, "",
    ...renderRegimeLines(r), "",
    "## Labels",
    "| Label | Rule |", "|---|---|",
    "| panic | 1d vol ≥3× its 30-bar norm AND a ≥8% daily move |",
    "| breakout | 4h vol ≥1.8× norm with price through its 20-bar range |",
    "| low-vol compression | 4h vol ≤0.55× norm |",
    "| high-vol chop | 4h vol ≥1.5× norm, daily flat |",
    "| strong bull / bear | 1d and 4h both above/below their 20-bar mean and the close 20 bars ago |",
    "| weak bull / bear | 1d trending, 4h not agreeing |",
    "| range | 1d flat |", "",
    "## Implications for the margin desk",
    "- Nothing here sizes or gates a trade. The BTC-shock veto (alt entries against a ≥3%/1h BTC move) and the event-calendar veto are the only intelligence that can withhold an entry, and both are stated above.",
    "- Read with [[crypto-desk-brief]] (the daily eight-section brief) and Performance/margin-statistics.md.", "",
  ].join("\n");
}

export async function refreshCryptoRegime(features: Record<string, TfFeatures> | null = null): Promise<{ regime: BriefRegime; path: string }> {
  const regime = await gatherRegime(features);
  await vaultWrite(CRYPTO_REGIME_PATH, renderCryptoRegime(regime, new Date().toISOString()), "margin-desk");
  return { regime, path: CRYPTO_REGIME_PATH };
}
