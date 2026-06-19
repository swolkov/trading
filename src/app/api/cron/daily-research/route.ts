import { prisma } from "@/lib/db";
import { vaultRead, vaultWrite } from "@/lib/vault";
import {
  buildChronicle, chronicleMarkdown, analyzeInstrument, morningBriefMarkdown,
  CHRONICLE_SYMBOLS, FOCUS_SYMBOLS, type Bar, type Basket, type Inst,
} from "@/lib/market-chronicle";
import { type Candle } from "@/lib/svg-chart";

export const maxDuration = 300;

// ============ DAILY RESEARCH CRON ============
// Cloud-reliable replacement for the Mac launchd jobs (market-chronicle.ts @5pm + morning-brief.ts
// @9:25am). Pulls the cross-asset daily basket from the Databento HISTORICAL API at runtime (no local
// CSVs — Vercel FS is read-only), then writes the SAME intelligence those scripts produce:
//   • Brain/market-history.md   (regime / vol / risk tone / day type / historical analogues)
//   • Brain/morning-brief.md    (key levels + chronicle + AI daily plan)
//   • Brain/charts/<SYM>-morning.svg  (each chart persisted as its own VaultDocument so it survives
//                                       in the cloud — Vercel can't write the Obsidian folder)
// The math is shared via src/lib/market-chronicle.ts so cron + scripts stay consistent.
// Each section is try/caught so a single Databento hiccup never 500s the whole cron.

// Databento daily OHLCV fetch — mirrors scripts/dbn-fetch-daily.ts (continuous front-month, GLBX.MDP3).
function dbnAuth(): string | null {
  const k = process.env.DATABENTO_API_KEY;
  return k ? "Basic " + Buffer.from(k + ":").toString("base64") : null;
}

async function fetchDaily(symbol: string, startISO: string, endISO: string, auth: string): Promise<Map<string, Bar>> {
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: symbol + ".v.0", stype_in: "continuous",
    schema: "ohlcv-1d", start: startISO, end: endISO,
    encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 120)}`);
  const csv = await res.text();
  const m = new Map<string, Bar>();
  for (const r of csv.trim().split("\n").slice(1)) {
    const c = r.split(","); const o = +c[4], h = +c[5], l = +c[6], cl = +c[7], v = +c[8];
    if (isFinite(cl) && cl > 0) m.set(c[0].slice(0, 10), { o, h, l, c: cl, v });
  }
  return m;
}

// Pull the chronicle basket (~18 months) into an in-memory Map per symbol. Failed symbols → empty Map.
async function fetchBasket(auth: string): Promise<Basket> {
  const end = new Date(Date.now() - 1 * 86_400_000);          // T-1 (Databento daily settles next day)
  const start = new Date(end.getTime() - 18 * 30 * 86_400_000); // ~18 months for analogue depth
  const startISO = start.toISOString().slice(0, 10), endISO = end.toISOString().slice(0, 10);
  const MK: Basket = {};
  const BATCH = 6;
  for (let i = 0; i < CHRONICLE_SYMBOLS.length; i += BATCH) {
    await Promise.all(CHRONICLE_SYMBOLS.slice(i, i + BATCH).map(async (sym) => {
      try { MK[sym] = await fetchDaily(sym, startISO, endISO, auth); }
      catch (e) { console.error(`[daily-research] ${sym} fetch failed:`, e instanceof Error ? e.message : e); MK[sym] = new Map(); }
    }));
  }
  return MK;
}

function toCandles(m: Map<string, Bar> | undefined): Candle[] {
  if (!m) return [];
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({ date, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const result: Record<string, unknown> = { today };

  const dbAuth = dbnAuth();
  if (!dbAuth) {
    return Response.json({ error: "DATABENTO_API_KEY missing" }, { status: 500 });
  }

  // 1) Pull the cross-asset daily basket from Databento (in-memory, no CSVs).
  let MK: Basket = {};
  try {
    MK = await fetchBasket(dbAuth);
    const got = Object.values(MK).filter((m) => m.size > 0).length;
    result.symbolsFetched = got;
    if (got === 0) throw new Error("no symbols returned");
  } catch (e) {
    result.basketError = e instanceof Error ? e.message : String(e);
    // Without the basket there's nothing to compute — bail with 200 so the cron isn't marked failed.
    return Response.json({ status: "no-data", ...result });
  }

  // 2) Market chronicle → Brain/market-history.md
  let rowsLen = 0;
  try {
    const rows = buildChronicle(MK);
    rowsLen = rows.length;
    if (rows.length) {
      await vaultWrite("Brain/market-history.md", chronicleMarkdown(rows, today), "daily-research");
      result.marketHistory = `${rows.length} days`;
    } else {
      result.marketHistory = "no rows";
    }
  } catch (e) {
    result.chronicleError = e instanceof Error ? e.message : String(e);
  }

  // 3) Per-instrument charts → persist each SVG as its own VaultDocument (survives in the cloud).
  const insts: Inst[] = [];
  try {
    for (const sym of FOCUS_SYMBOLS) {
      const it = analyzeInstrument(sym, toCandles(MK[sym]));
      if (!it) continue;
      insts.push(it);
      try { await vaultWrite(`Brain/charts/${sym}-morning.svg`, it.svg, "daily-research"); }
      catch (e) { console.error(`[daily-research] chart ${sym} persist failed:`, e instanceof Error ? e.message : e); }
    }
    result.charts = insts.map((i) => i.sym);
  } catch (e) {
    result.chartError = e instanceof Error ? e.message : String(e);
  }

  // 4) Morning brief → Brain/morning-brief.md (reads regime / AI plan / chronicle / lessons from vault).
  try {
    if (insts.length) {
      const [regimeDoc, planDoc, histDoc, lessonsDoc] = await Promise.all([
        vaultRead("Brain/market-regime.md"), vaultRead("Brain/daily-plan.md"),
        vaultRead("Brain/market-history.md"), vaultRead("Lessons/active-lessons.md"),
      ]);
      const md = morningBriefMarkdown({
        today, insts, regimeDoc, planDoc, histDoc, lessonsDoc,
        chartPath: (sym) => `charts/${sym}-morning.svg`,
      });
      await vaultWrite("Brain/morning-brief.md", md, "daily-research");
      result.morningBrief = "ok";
    } else {
      result.morningBrief = "skipped (no instruments)";
    }
  } catch (e) {
    result.briefError = e instanceof Error ? e.message : String(e);
  }

  // Heartbeat
  try {
    await prisma.agentConfig.upsert({
      where: { key: "daily_research_last_run" },
      update: { value: new Date().toISOString() },
      create: { key: "daily_research_last_run", value: new Date().toISOString() },
    });
  } catch {}

  return Response.json({ status: "ok", rows: rowsLen, ...result });
}
