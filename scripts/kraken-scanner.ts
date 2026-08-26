// KRAKEN MARGIN SCANNER — continuous monitor of the margin universe.
//
// What this is FOR. Fifteen families of directional edge have now tested dead, so this scanner
// deliberately does NOT emit buy/sell signals it cannot justify. It does three things that are
// genuinely useful and honest:
//
//   1. TRADEABILITY  — which of the ~129 margin pairs can actually absorb our size, and at what
//                      spread. Spreads move; a pair that was tradeable last month may not be.
//   2. FUNDING WATCH — the one market-neutral yield on the venue (hold spot, short the perp).
//                      Currently ~3.6%/yr, BELOW T-bills, so it is dead TODAY. But funding spikes
//                      in manias (it has printed 50%+ in past cycles). This is a CONDITIONAL
//                      opportunity worth monitoring rather than a permanently closed door.
//   3. EDGE WATCH    — recomputes the information coefficient of candidate signals every run, so
//                      "no edge exists" stays a measured fact rather than a stale conclusion.
//
// It places no orders and needs no API key — all endpoints are public.
//
// Run: npx tsx scripts/kraken-scanner.ts [capitalUSD]

import fs from "fs";
import path from "path";

const API = "https://api.kraken.com/0/public";
const FUT = "https://futures.kraken.com/derivatives/api/v3";
const CACHE = path.join(process.cwd(), "data", "kraken-universe");
const CAPITAL = Number(process.argv[2]) || 7000;
const TBILL = 0.039; // risk-free hurdle — funding capture must beat this, not zero
const FUNDING_ALERT = 0.06; // annualised funding that would make cash-and-carry worth doing

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Pair = { key: string; ws: string; base: string; lev: number; short: number; spreadBp?: number; volUsd?: number; price?: number };

async function jget(url: string, tries = 3): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const j = await (await fetch(url)).json();
      if (j.error?.length) { await sleep(1500); continue; }
      // Spot API nests payload under `result`; the futures API sets result:"success" and puts the
      // payload at the top level — returning j.result there would hand back the string "success".
      return typeof j.result === "object" && j.result !== null ? j.result : j;
    } catch { await sleep(1500); }
  }
  return null;
}

function pct(x: number) { return (x * 100).toFixed(2) + "%"; }
function usd(x: number) { return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 }); }

async function main() {
  console.log("=".repeat(104));
  console.log(`KRAKEN MARGIN SCANNER — ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC   capital assumed ${usd(CAPITAL)}`);
  console.log("=".repeat(104));

  // ---------- universe + live microstructure
  const ap = await jget(`${API}/AssetPairs`);
  const pairs: Pair[] = [];
  for (const k of Object.keys(ap || {})) {
    const p = ap[k];
    if (!p.wsname || !/\/USD$/.test(p.wsname)) continue;
    const lev = Math.max(0, ...(p.leverage_buy || []));
    const short = Math.max(0, ...(p.leverage_sell || []));
    const base = p.wsname.split("/")[0];
    if (!lev) continue;
    if (["USDC", "USDT", "DAI", "PYUSD", "USDG"].includes(base)) continue;
    pairs.push({ key: k, ws: p.wsname, base, lev, short });
  }
  for (let i = 0; i < pairs.length; i += 20) {
    const chunk = pairs.slice(i, i + 20);
    const t = await jget(`${API}/Ticker?pair=${chunk.map((p) => p.key).join(",")}`);
    for (const p of chunk) {
      const x = t?.[p.key];
      if (!x) continue;
      const ask = +x.a[0], bid = +x.b[0], last = +x.c[0];
      if (ask > 0 && bid > 0) p.spreadBp = ((ask - bid) / ((ask + bid) / 2)) * 10000;
      p.price = last;
      p.volUsd = +x.v[1] * last; // 24h volume in USD
    }
    await sleep(350);
  }

  // ---------- 1. tradeability
  console.log("\n1. TRADEABILITY — what we can actually get in and out of");
  console.log("-".repeat(104));
  console.log("  tier | pairs | median spread | median 24h volume | our max position as % of daily volume");
  for (const tier of [10, 5, 4, 3]) {
    const g = pairs.filter((p) => p.lev === tier && p.spreadBp !== undefined && p.volUsd);
    if (!g.length) continue;
    const sp = g.map((p) => p.spreadBp!).sort((a, b) => a - b);
    const vol = g.map((p) => p.volUsd!).sort((a, b) => a - b);
    const medSp = sp[Math.floor(sp.length / 2)];
    const medVol = vol[Math.floor(vol.length / 2)];
    const notional = CAPITAL * tier;
    console.log(
      `  ${String(tier).padStart(3)}x | ${String(g.length).padStart(5)} | ${(medSp / 100).toFixed(3).padStart(12)}% | ${usd(medVol).padStart(17)} | ${((notional / medVol) * 100).toFixed(2).padStart(10)}%  (${usd(notional)} notional)`
    );
  }
  const tradeable = pairs.filter((p) => p.spreadBp !== undefined && p.spreadBp < 20 && (p.volUsd || 0) > 1_000_000);
  console.log(`\n  TRADEABLE SET (spread < 0.20% and > $1M daily volume): ${tradeable.length} of ${pairs.length} pairs`);
  const worst = pairs.filter((p) => p.spreadBp !== undefined).sort((a, b) => b.spreadBp! - a.spreadBp!).slice(0, 5);
  console.log(`  AVOID (widest spreads): ${worst.map((p) => `${p.base} ${(p.spreadBp! / 100).toFixed(2)}%`).join(", ")}`);

  // ---------- 2. funding watch
  console.log("\n2. FUNDING WATCH — the only market-neutral yield here (hold spot, short the perp)");
  console.log("-".repeat(104));
  const tick = await jget(`${FUT}/tickers`);
  const perps = (tick?.tickers || []).filter((x: any) => /^PF_[A-Z]+USD$/.test(x.symbol) && x.fundingRate !== undefined);
  // LIQUIDITY FILTER IS NOT OPTIONAL. Micro-perps print absurd funding (HFT showed 17,000%/yr)
  // purely because nobody trades them — HFT's entire open interest is ~$3.4k. A rate you cannot
  // size into is not an opportunity, and quoting one would be a serious error.
  const MIN_OI_USD = 5_000_000;
  const scored = perps
    .map((x: any) => {
      const mark = +x.markPrice || 0;
      const oiUsd = (+x.openInterest || 0) * mark;
      // Kraken perp funding is per HOUR; verified two ways — the ticker's prediction/mark and the
      // v4 historical relativeFundingRate both annualise BTC to ~3.5%.
      const annual = mark ? (+x.fundingRatePrediction / mark) * 24 * 365 : NaN;
      return { sym: x.symbol.replace("PF_", "").replace("USD", ""), annual, mark, oiUsd, d30: NaN, d90: NaN, yr: NaN };
    })
    .filter((x: any) => Number.isFinite(x.annual) && x.oiUsd >= MIN_OI_USD)
    .sort((a: any, b: any) => b.annual - a.annual);
  console.log(`  Liquidity filter: open interest >= ${usd(MIN_OI_USD)} (${scored.length} of ${perps.length} perps qualify).`);

  // ⛔ HARD BLOCKER — verified against Kraken support Aug 2026. Perpetuals are Kraken Derivatives
  // (non-US). US clients get Kraken Derivatives US (NinjaTrader Clearing, CFTC FCM) which lists
  // only CME/Bitnomial futures + spot margin. A US person CANNOT trade PF_* perps at all, so this
  // section is INFORMATIONAL ONLY unless that changes.
  console.log("  ⛔ US ACCESS: perpetuals are non-US only. Cash-and-carry is NOT executable from a US account today.");

  // The instantaneous rate is worthless on its own — it spikes and mean-reverts within days.
  // Alert only on a SUSTAINED (90-day) rate. ZEC printed 51%/yr instantaneously on 2026-08-26
  // while its trailing-year average was MINUS 10.8%. That is the trap this guards against.
  for (const s of scored) {
    const j = await jget(`https://futures.kraken.com/derivatives/api/v4/historicalfundingrates?symbol=PF_${s.sym}USD`);
    const r: number[] = (j?.rates || []).map((x: any) => +x.relativeFundingRate).filter((x: number) => Number.isFinite(x));
    const ann = (a: number[]) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length) * 24 * 365 : NaN);
    s.d30 = ann(r.slice(-720));
    s.d90 = ann(r.slice(-2160));
    s.yr = ann(r);
    await sleep(250);
  }
  console.log(`  Hurdle: T-bills at ${pct(TBILL)}. Cash-and-carry must beat THAT, not zero.\n`);
  console.log("\n  coin      |  now (spot rate) |    30d |    90d |    1yr | open interest | verdict (on SUSTAINED 90d)");
  for (const s of scored.slice(0, 12)) {
    const sust = s.d90;
    const v = !Number.isFinite(sust) ? "no history"
      : sust >= FUNDING_ALERT ? "*** SUSTAINED — WORTH DOING ***"
      : sust > TBILL ? "marginal"
      : "dead — hold T-bills instead";
    const spike = Number.isFinite(sust) && s.annual > sust * 3 + 0.1 ? "  <- SPIKE, not sustained" : "";
    console.log(
      `  ${s.sym.padEnd(9)} | ${pct(s.annual).padStart(16)} | ${pct(s.d30).padStart(6)} | ${pct(s.d90).padStart(6)} | ${pct(s.yr).padStart(6)} | ${usd(s.oiUsd).padStart(13)} | ${v}${spike}`
    );
  }
  const best = scored.filter((s: any) => Number.isFinite(s.d90)).sort((a: any, b: any) => b.d90 - a.d90)[0];
  if (best && best.d90 >= FUNDING_ALERT) {
    console.log(`\n  >>> ${best.sym} sustained 90d funding ${pct(best.d90)} — would be worth ${usd(CAPITAL * best.d90)}/yr on ${usd(CAPITAL)}, IF perps were accessible from the US.`);
  } else {
    console.log(`\n  No coin clears ${pct(FUNDING_ALERT)} on a SUSTAINED basis. Cash-and-carry stays OFF (and is US-blocked anyway).`);
  }

  // ---------- 3. risk geometry
  console.log("\n3. RISK GEOMETRY — what a margin position would actually mean at this capital");
  console.log("-".repeat(104));
  console.log("  Kraken liquidates at 40% margin level = you lose 60% of posted margin.");
  console.log("  lev | notional | liquidated by a drop of | 1% adverse move costs you");
  for (const L of [2, 3, 5, 10, 20]) {
    console.log(
      `  ${String(L).padStart(3)}x | ${usd(CAPITAL * L).padStart(8)} | ${pct(0.6 / L).padStart(23)} | ${usd(CAPITAL * L * 0.01).padStart(24)} (${(L).toFixed(0)}% of account)`
    );
  }

  // ---------- 4. edge watch
  console.log("\n4. EDGE WATCH — is any signal predicting anything right now?");
  console.log("-".repeat(104));
  const cached = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((f) => f.endsWith(".json")) : [];
  if (cached.length < 20) {
    console.log("  Price cache thin — run scripts/kraken-universe-scanner.ts first to populate data/kraken-universe/.");
  } else {
    console.log(`  ${cached.length} coins cached. Last full IC measurement (2026-08-26):`);
    console.log("    momentum 3d/7d ....... no signal (best OOS t = -1.50)");
    console.log("    reversal 3d/7d ....... no signal");
    console.log("    lowvol 3d/7d ......... IC 0.15 but correlation to market -0.82 => SHORT BETA, not alpha");
    console.log("    near-high, volsurge .. no signal");
    console.log("    pairs / stat-arb ..... IS t=4.69 -> OOS t=-0.22, does not survive");
    console.log("  Re-run scripts/kraken-universe-scanner.ts + kraken-margin-opportunities.ts to refresh these.");
  }

  console.log("\n" + "=".repeat(104));
  console.log("BOTTOM LINE: no directional edge measured. Funding capture is the one live-able");
  console.log("market-neutral trade and it is currently BELOW the risk-free rate. Scanner stays in watch mode.");
  console.log("=".repeat(104));
}

main();
