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

  // VETO SCOREBOARD (2026-08-10). Raw ShadowTrade.dollarPnl = what the DECLINED trade would have
  // made; negative = dodged loser = the gate saved money. Reported in WORDS because the bare sign
  // was misread twice in one day (see engine-activity.tsx ShadowTag — the UI shows the negation).
  try {
    const vetoes = await prisma.shadowTrade.findMany({
      where: { mode: i.mode === "live" ? "live" : "demo", resolvedAt: { gte: start }, dollarPnl: { not: null } },
      select: { dollarPnl: true },
    });
    if (vetoes.length > 0) {
      const saved = vetoes.filter(v => v.dollarPnl! < 0).reduce((s, v) => s - v.dollarPnl!, 0);
      const missed = vetoes.filter(v => v.dollarPnl! > 0).reduce((s, v) => s + v.dollarPnl!, 0);
      const net = saved - missed;
      L.push(`vetoes: saved $${saved.toFixed(0)} · missed $${missed.toFixed(0)} → gate ${net >= 0 ? "earned" : "cost"} $${Math.abs(net).toFixed(0)} today (${vetoes.length} blocks)`);
    }
  } catch { /* veto line is additive — never break the digest */ }

  // PROMOTION RADAR (2026-08-10). The shadow ledger can quietly accumulate proof that a BLOCKED
  // category is systematically profitable — and until now nothing raised an alarm; finding it
  // required someone to go looking (or_breakout was found that way, by hand). This scans every
  // blocked setup/direction nightly and flags any with n>=50 resolved counterfactuals, positive
  // net, and t>=2 — the same statistical bar edges must clear everywhere else in the system.
  // ALERT-ONLY by design: shadow counterfactuals carry NO slippage or fees and overstate reality
  // (the gap_fill lesson), so a human decision + demo trial still stands between an alert and a
  // live switch. This automates the NOTICING, not the promoting.
  try {
    const resolved = await prisma.shadowTrade.findMany({
      where: { mode: i.mode === "live" ? "live" : "demo", dollarPnl: { not: null } },
      select: { setupType: true, direction: true, dollarPnl: true, symbol: true },
    });
    // Split gold from index — pooling them once buried a real signal inside a known-dead one.
    const cats: Record<string, number[]> = {};
    for (const v of resolved) {
      const cls = /GC/.test(v.symbol ?? "") ? "gold" : "index";
      (cats[`${cls} ${v.setupType ?? "?"}/${v.direction}`] ??= []).push(v.dollarPnl!);
    }
    for (const [cat, vals] of Object.entries(cats)) {
      if (vals.length < 50) continue;
      const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
      if (mean <= 0) continue;
      const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (vals.length - 1));
      const t = sd > 0 ? mean / (sd / Math.sqrt(vals.length)) : 0;
      if (t >= 2) L.push(`🚨 PROMOTION RADAR: blocked ${cat} is t=${t.toFixed(2)} over ${vals.length} resolved shadows (+$${(mean * vals.length).toFixed(0)} counterfactual) — review for a demo trial`);
    }
  } catch { /* radar is additive — never break the digest */ }

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
