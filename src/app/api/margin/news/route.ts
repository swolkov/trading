import { macroEventWindows } from "@/lib/macro-events";

// News + scheduled-event strip for the margin cockpit.
//
// Headlines: pulled live from public crypto RSS feeds (no API key, no vendor lock-in),
// cached 5 minutes. This is AWARENESS data — news-shock trading was tested and died
// out-of-sample (13th dead family), so nothing here feeds the executor.
//
// Events: from src/lib/macro-events.ts (shared with the margin-watch guardian).
export const dynamic = "force-dynamic";

interface Headline { title: string; link: string; source: string; publishedAt: string | null }

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

    // Within 24h of a high-impact event, the cockpit shows a caution banner — being
    // levered into an FOMC print is a choice one should at least make knowingly.
    const { upcoming, imminent } = macroEventWindows(new Date());

    return Response.json({ headlines, upcoming, imminent });
  } catch (error) {
    console.error("[/api/margin/news]", error);
    return Response.json({ headlines: [], upcoming: [], imminent: [], error: String(error) });
  }
}
