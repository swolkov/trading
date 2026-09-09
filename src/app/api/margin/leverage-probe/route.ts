import { probeLeverage } from "@/lib/kraken-leverage-probe";

// OWNER-ONLY, VALIDATE-ONLY. Asks Kraken which leverages it will actually accept on the US
// retail venue, because no public source can tell us: the public AssetPairs endpoint describes
// the INTERNATIONAL product and advertises BTC at 10× where Spencer's own fills ran 20×.
//
// It exists as a route rather than a script because the Kraken keys are set only in the Vercel
// environment — running the equivalent script locally fails on missing credentials, and the
// alternative (moving keys around) is worse than adding a read-only endpoint. Everything
// outside route-access's public list is owner-gated by the proxy and fails closed, so this
// inherits that.
//
// PLACES NOTHING: every call is AddOrder with validate=true, which runs Kraken's own
// server-side checks and returns without creating an order. It is a GET with no side effects
// beyond the private-call budget it spends, so it is safe to re-run.
//
// ⚠️ Never schedule this. Private calls share the rate/nonce budget the guardian and executor
// depend on — the collisions PR #95 was written to stop.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    const { rows, drift, note } = await probeLeverage();
    return Response.json({
      ok: true,
      placedOrders: 0,
      note,
      drift,
      rows,
      // A copy-pasteable summary line per coin, so the result can be acted on without
      // re-deriving it from the JSON.
      summary: rows.map((r) => `${r.coin}: table ${r.table}× · Kraken accepted ${r.maxAccepted || "none"}× · ${r.verdict}${r.detail && r.verdict !== "matches" ? ` — ${r.detail}` : ""}`),
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
}
