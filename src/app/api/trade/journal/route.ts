import { foldJournal, journalView, setJournalNote } from "@/lib/trading-room-journal-store";
import { ledgerView, syncLedger } from "@/lib/trading-room-ledger";
import { replayImageUrl, replayView } from "@/lib/trading-room-replay";
import { sendNotification } from "@/lib/notifications";

// THE JOURNAL — the page's read (round trips + the 40-trade scoreboard) and its one write: Spencer's
// own setup tag and one-line why on a trade. `refold` re-runs the fills → trips fold on demand.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try { const [j, ledger] = await Promise.all([journalView(), ledgerView()]); return Response.json({ ...j, ledger }); }
  catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: { action?: string; id?: string; setupTag?: string | null; why?: string | null; grade?: string | null } = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    if (body.action === "refold") { await syncLedger().catch(() => {}); const r = await foldJournal(); return Response.json({ ok: true, ...r, ...(await journalView()), ledger: await ledgerView() }); }
    if (body.action === "note" && body.id) {
      const ok = await setJournalNote(body.id, { setupTag: body.setupTag, why: body.why, grade: body.grade });
      return Response.json({ ok, ...(await journalView()) });
    }
    // Post one trade's replay to Slack again, on demand (the meter posts it once when the trade closes).
    if (body.action === "slack" && body.id) {
      const v = await replayView(body.id);
      if (!v) return Response.json({ error: "no such trade" }, { status: 404 });
      const money = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(Math.round(x)).toLocaleString()}`;
      const text = `🎬 Replay · ${v.trip.symbol} ${v.trip.side} ×${v.trip.qty} · ${money(v.trip.netUsd)} net${v.trip.netR != null ? ` · ${v.trip.netR >= 0 ? "+" : "−"}${Math.abs(v.trip.netR).toFixed(1)}R` : ""} · ${new Date(v.trip.entryTs).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;
      const img = replayImageUrl(body.id);
      await sendNotification(text, "futures", img ? [{ type: "section", text: { type: "mrkdwn", text } }, { type: "image", image_url: img, alt_text: "trade replay" }] : undefined);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "action must be refold, note or slack (with id)" }, { status: 400 });
  } catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}
