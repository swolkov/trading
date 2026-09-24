import { gradeSecret, saveGrade } from "@/lib/trade-grades";
import { GRADE_LABEL, GRADE_TTL_MS, gradeSignatureOk, isGrade, parseGradeKey, type Grade } from "@/lib/trade-grades-rules";

// THE GRADE TAP — public path (he taps it from Slack on his phone, no session), gated by an HMAC of the entry key
// under the room's own secret. It only records his A/B/C for one entry. Only a real tap saves: GET (and HEAD, which
// Next answers from GET) never writes — the page it returns POSTs the grade back with one line of script, which link
// previewers and link checkers don't run. A wrong or missing signature is a 404; links stop working 30 min after entry.
export const dynamic = "force-dynamic";

const page = (title: string, body: string, status = 200, script = "") =>
  new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<body style="font:18px -apple-system,system-ui,sans-serif;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;min-height:90vh;margin:0">
<div id="m" style="text-align:center;padding:24px">${body}</div>${script}</body>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

type Checked = { ok: true; k: string; g: Grade; symbol: string; side: 1 | -1; openedMs: number } | { ok: false; res: Response };
function check(u: URL, nowMs: number): Checked {
  const k = u.searchParams.get("k")?.trim() ?? "", g = u.searchParams.get("g")?.trim() ?? "", sig = u.searchParams.get("sig")?.trim() ?? "";
  const secret = gradeSecret();
  const key = k.length <= 40 ? parseGradeKey(k) : null;
  if (!secret || !key || !isGrade(g) || !gradeSignatureOk(k, sig, secret)) return { ok: false, res: new Response("not found", { status: 404 }) };
  if (nowMs - key.openedMs > GRADE_TTL_MS) return { ok: false, res: page("Too late", "This grade link has expired — grades are taken at entry (within 30 minutes), so they stay your read, not hindsight.", 410) };
  return { ok: true, k, g, ...key };
}
const when = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const color = (g: Grade) => (g === "A" ? "#3fb950" : g === "B" ? "#d29922" : "#f85149");

export function HEAD() { return new Response(null, { status: 204 }); }

export async function GET(req: Request) {
  const c = check(new URL(req.url), Date.now());
  if (!c.ok) return c.res;
  // Nothing is written here. The browser posts it back; the text is all server-made (validated key, A/B/C, time).
  const label = `${c.symbol} ${c.side === 1 ? "long" : "short"} at ${when(c.openedMs)} ET`;
  return page(`Grade ${c.g}`, `<div style="font-size:64px;font-weight:700;color:${color(c.g)}">${c.g}</div><div style="margin-top:8px">${GRADE_LABEL[c.g]} — ${label}</div><div style="margin-top:16px;opacity:.6;font-size:15px">Saving…</div>`, 200,
    `<script>fetch(location.href,{method:"POST"}).then(function(r){return r.ok}).catch(function(){return false}).then(function(ok){document.querySelector("#m div:last-child").textContent=ok?"Saved. Tap another grade in Slack to change it.":"Couldn't save — tap the link again."})</script>`);
}

export async function POST(req: Request) {
  const c = check(new URL(req.url), Date.now());
  if (!c.ok) return c.res;
  try {
    const saved = await saveGrade(c.k, c.g);
    return saved ? Response.json({ saved: c.g }) : new Response("not found", { status: 404 });
  } catch {
    return Response.json({ error: "not saved" }, { status: 500 });
  }
}
