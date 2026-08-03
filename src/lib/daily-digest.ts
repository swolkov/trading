/**
 * END-OF-DAY DIGEST — one Slack message that says what the day actually did.
 *
 * Slack already reports every individual event (entry, close, reject, backstop), but there was no
 * line that said "today: 3 trades, +$180, here is the running total" — you had to reassemble the day
 * from a stream of fragments or open the dashboard. This is that line.
 *
 * ACCOUNTING RULE: the headline number is BALANCE DELTA (end-of-day equity minus start-of-day),
 * never a sum of trade rows. Summed rows have been wrong in this system before — double-logged,
 * partially reconciled — and balance delta is what the broker actually did to the account. Per-trade
 * detail comes from the CLEAN RoundTrip ledger, which is broker-fill sourced and now edge-attributed.
 */
import { prisma } from "./db";

export interface DigestInput {
  mode: "live" | "demo";
  balanceDelta: number | null;   // authoritative day P&L
  endBalance: number;
  engineDailyPnl: number;        // engine's own tally — shown only when it disagrees
  tradesToday: number;
  dailyLossLimit: number | null;
}

const money = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;

export async function buildDailyDigest(i: DigestInput): Promise<string> {
  const rtMode = i.mode === "live" ? "live" : "paper";
  const start = new Date(); start.setHours(0, 0, 0, 0);

  const today = await prisma.roundTrip.findMany({
    where: { mode: rtMode, exitTime: { gte: start } }, orderBy: { id: "asc" },
  }).catch(() => []);
  const all = await prisma.roundTrip.findMany({ where: { mode: rtMode } }).catch(() => []);

  const head = i.balanceDelta != null ? money(i.balanceDelta) : `${money(i.engineDailyPnl)} (engine)`;
  const L: string[] = [];
  L.push(`📊 *${i.mode.toUpperCase()} FUTURES — end of day*`);
  L.push(`*${head}* today · balance $${i.endBalance.toFixed(2)}`);

  // Surface a disagreement rather than hiding it — it means a fill has not reconciled yet.
  if (i.balanceDelta != null && Math.abs(i.balanceDelta - i.engineDailyPnl) > 25) {
    L.push(`⚠️ engine tallied ${money(i.engineDailyPnl)} — ${money(i.balanceDelta - i.engineDailyPnl)} still unreconciled`);
  }

  if (today.length === 0) {
    L.push(`No trades taken${i.tradesToday > 0 ? ` (${i.tradesToday} entries logged, none closed yet)` : ""}.`);
  } else {
    const wins = today.filter(t => t.pnl > 0);
    L.push(`${today.length} round-trip${today.length === 1 ? "" : "s"} · ${wins.length}W/${today.length - wins.length}L · ${Math.round(wins.length / today.length * 100)}% win`);
    for (const t of today) {
      const r = t.rMultiple != null ? ` (${t.rMultiple > 0 ? "+" : ""}${t.rMultiple.toFixed(1)}R)` : "";
      L.push(`   ${t.pnl >= 0 ? "🟢" : "🔴"} ${t.symbol} ${t.direction} ${t.contracts}x  ${money(t.pnl)}${r}  ${t.setupType ?? "—"}`);
    }
    // Per-edge, so a losing day says WHICH edge lost it.
    const byEdge: Record<string, { n: number; net: number }> = {};
    for (const t of today) {
      const k = t.setupType ?? "unattributed";
      (byEdge[k] ??= { n: 0, net: 0 }); byEdge[k].n++; byEdge[k].net += t.pnl;
    }
    if (Object.keys(byEdge).length > 1) {
      L.push(`by edge: ${Object.entries(byEdge).map(([k, v]) => `${k} ${money(v.net)} (${v.n})`).join(" · ")}`);
    }
  }

  if (i.dailyLossLimit && i.balanceDelta != null && i.balanceDelta < 0) {
    L.push(`loss budget used: $${Math.abs(i.balanceDelta).toFixed(0)} of $${i.dailyLossLimit.toFixed(0)}`);
  }

  // Running record — the number that actually matters, with the honesty check attached.
  if (all.length > 0) {
    const net = all.reduce((s, t) => s + t.pnl, 0);
    const w = all.filter(t => t.pnl > 0).length;
    const mean = net / all.length;
    const sd = all.length > 1
      ? Math.sqrt(all.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / (all.length - 1)) : 0;
    const tStat = sd > 0 ? mean / (sd / Math.sqrt(all.length)) : 0;
    L.push(`— running: ${all.length} trades · ${money(net)} · ${Math.round(w / all.length * 100)}% win · t-stat ${tStat.toFixed(2)}${Math.abs(tStat) < 2 ? " (under 2 — not yet proven)" : " (proven)"}`);
  }
  return L.join("\n");
}
