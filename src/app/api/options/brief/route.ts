import { readOptionsBrief } from "@/lib/options-brief-store";

// The options desk brief as last rendered (research ingest / 17:32 collect). Read-only; the text is also in Brain/options-desk-brief.md.
export const dynamic = "force-dynamic";
export async function GET() { return Response.json({ brief: await readOptionsBrief() }); }
