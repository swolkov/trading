import { foldJournal, journalView, setJournalNote } from "@/lib/trading-room-journal-store";
import { ledgerView, syncLedger } from "@/lib/trading-room-ledger";

// THE JOURNAL — the page's read (round trips + the 40-trade scoreboard) and its one write: Spencer's
// own setup tag and one-line why on a trade. `refold` re-runs the fills → trips fold on demand.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try { const [j, ledger] = await Promise.all([journalView(), ledgerView()]); return Response.json({ ...j, ledger }); }
  catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}

export async function POST(request: Request) {
  let body: { action?: string; id?: string; setupTag?: string | null; why?: string | null } = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    if (body.action === "refold") { await syncLedger().catch(() => {}); const r = await foldJournal(); return Response.json({ ok: true, ...r, ...(await journalView()), ledger: await ledgerView() }); }
    if (body.action === "note" && body.id) {
      const ok = await setJournalNote(body.id, { setupTag: body.setupTag, why: body.why });
      return Response.json({ ok, ...(await journalView()) });
    }
    return Response.json({ error: "action must be refold or note (with id)" }, { status: 400 });
  } catch (e) { return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
}
