// News + scheduled-event strip for the margin cockpit.
//
// Headlines: pulled live from public crypto RSS feeds (no API key, no vendor lock-in),
// cached 5 minutes. This is AWARENESS data — news-shock trading was tested and died
// out-of-sample (13th dead family), so nothing here feeds the executor.
//
// Events: high-impact US macro dates (FOMC decisions, CPI releases). Kept as a static
// table because the schedule is published quarters ahead; the daily research routine
// refreshes the vault copy and this table gets updated when it drifts. Marked "approx"
// where the exact date wasn't verified against the primary source.
export const dynamic = "force-dynamic";

interface Headline { title: string; link: string; source: string; publishedAt: string | null }
interface MacroEvent { date: string; time: string; name: string; approx: boolean }

// Remaining 2026 high-impact events (ET dates). Refresh when the Fed/BLS publish 2027.
const MACRO_EVENTS: MacroEvent[] = [
  { date: "2026-09-11", time: "08:30 ET", name: "CPI (Aug)", approx: true },
  { date: "2026-09-16", time: "14:00 ET", name: "FOMC rate decision", approx: true },
  { date: "2026-10-13", time: "08:30 ET", name: "CPI (Sep)", approx: true },
  { date: "2026-10-28", time: "14:00 ET", name: "FOMC rate decision", approx: true },
  { date: "2026-11-12", time: "08:30 ET", name: "CPI (Oct)", approx: true },
  { date: "2026-12-10", time: "08:30 ET", name: "CPI (Nov)", approx: true },
  { date: "2026-12-09", time: "14:00 ET", name: "FOMC rate decision", approx: true },
];

const FEEDS: { url: string; source: string }[] = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
];

let cache: { at: number; headlines: Headline[] } | null = null;

function parseRss(xml: string, source: string): Headline[] {
  const items: Headline[] = [];
  const itemBlocks = xml.split(/<item[\s>]/).slice(1);
  for (const block of itemBlocks.slice(0, 15)) {
    const pick = (tag: string): string | null => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      if (!m) return null;
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").replace(/<[^>]+>/g, "").trim();
    };
    const title = pick("title");
    const link = pick("link");
    const pub = pick("pubDate");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      source,
      publishedAt: pub ? new Date(pub).toISOString() : null,
    });
  }
  return items;
}

export async function GET() {
  try {
    let headlines: Headline[];
    if (cache && Date.now() - cache.at < 5 * 60 * 1000) {
      headlines = cache.headlines;
    } else {
      const results = await Promise.allSettled(
        FEEDS.map(async (f) => {
          const r = await fetch(f.url, {
            signal: AbortSignal.timeout(8000),
            headers: { "user-agent": "Mozilla/5.0 (news strip)" },
          });
          return parseRss(await r.text(), f.source);
        }),
      );
      headlines = results
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
        .slice(0, 20);
      if (headlines.length) cache = { at: Date.now(), headlines };
    }

    const now = new Date();
    const soon = new Date(now.getTime() + 14 * 24 * 3600_000);
    const upcoming = MACRO_EVENTS
      .filter((e) => new Date(e.date + "T23:59:59Z") >= now && new Date(e.date) <= soon)
      .sort((a, b) => a.date.localeCompare(b.date));
    // Within 24h of a high-impact event, the cockpit shows a caution banner — being
    // levered into an FOMC print is a choice one should at least make knowingly.
    const imminent = upcoming.filter((e) => {
      const dt = new Date(e.date + "T17:00:00Z").getTime() - now.getTime();
      return dt > -12 * 3600_000 && dt < 36 * 3600_000;
    });

    return Response.json({ headlines, upcoming, imminent });
  } catch (error) {
    console.error("[/api/margin/news]", error);
    return Response.json({ headlines: [], upcoming: [], imminent: [], error: String(error) });
  }
}
