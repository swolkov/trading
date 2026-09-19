import { readFile } from "node:fs/promises";
import path from "node:path";

// Serves pine/trading-room-levels.pine so the Trading Room's "copy the Pine script" button always
// hands over the version that matches this deploy. Included in the function bundle via
// next.config.ts outputFileTracingIncludes.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const text = await readFile(path.join(process.cwd(), "pine", "trading-room-levels.pine"), "utf8");
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return new Response(`// pine script unavailable on this deploy: ${String(e).slice(0, 120)}`, { status: 500, headers: { "content-type": "text/plain" } });
  }
}
