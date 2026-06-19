import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent } from "@/components/ui/card";
import { Sunrise, Globe, FileText, ImageOff } from "lucide-react";
import { vaultReadMultiple } from "@/lib/vault";

export const dynamic = "force-dynamic";

// ============ MORNING BRIEF (admin) ============
// Surfaces the daily DB-backed vault artifacts written by scripts/morning-brief.ts
// and the market-chronicle job:
//   - Brain/morning-brief.md   (daily brief, key levels, historical analogues)
//   - Brain/market-history.md  (market chronicle)
// The brief embeds SVG charts via Obsidian "![[charts/NQ-morning.svg]]" syntax. The
// SVGs are persisted in the DB vault at Brain/charts/<name>.svg (written by the daily
// research / morning-brief jobs), so we fetch each one and render it inline where the
// embed appears. Missing charts fall back to a labeled placeholder.

const CHART_EMBED_SRC = String.raw`!\[\[charts\/([^\]]+?)\.svg\]\]`;

// Unique sentinel we inject in place of a chart embed so the markdown renderer can swap
// it for the inlined SVG (or a placeholder) via a custom component. Wrapped in newlines
// so remark treats it as its own paragraph.
const CHART_SENTINEL = (name: string) => `\n\n%%CHART:${name}%%\n\n`;
const CHART_SENTINEL_RE = /^%%CHART:(.+?)%%$/;

// Strip YAML frontmatter (--- ... ---) the vault docs carry at the top.
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, "");
}

// Collect the chart names referenced by a doc's embeds, e.g. "NQ-morning".
function extractChartNames(md: string): string[] {
  const names = new Set<string>();
  const re = new RegExp(CHART_EMBED_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) names.add(m[1]);
  return [...names];
}

// Replace Obsidian chart embeds with sentinels we render via the custom `p` component.
function markChartEmbeds(md: string): string {
  return md.replace(new RegExp(CHART_EMBED_SRC, "g"), (_m, name) => CHART_SENTINEL(name));
}

function makeMarkdownComponents(charts: Record<string, string>) {
  // Pull the chart name out of a paragraph node's plain-text content, if it is a sentinel.
  // The sentinel is plain text, so the paragraph's children are a single string (or a
  // one-element array of that string); anything else is a normal paragraph.
  const sentinelName = (children: React.ReactNode): string | null => {
    const text = typeof children === "string"
      ? children
      : Array.isArray(children) && children.length === 1 && typeof children[0] === "string"
        ? children[0]
        : null;
    if (text == null) return null;
    const m = text.trim().match(CHART_SENTINEL_RE);
    return m ? m[1] : null;
  };
  return {
  h1: ({ children, ...rest }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1 className="text-2xl font-bold mt-6 mb-3 text-foreground" {...rest}>{children}</h1>
  ),
  h2: ({ children, ...rest }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2 className="text-lg font-bold mt-6 mb-2 text-foreground border-b border-border pb-1.5" {...rest}>{children}</h2>
  ),
  h3: ({ children, ...rest }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 className="text-base font-semibold mt-4 mb-2 text-foreground" {...rest}>{children}</h3>
  ),
  p: ({ children, ...rest }: React.ComponentPropsWithoutRef<"p">) => {
    const name = sentinelName(children);
    if (name) return <ChartEmbed name={name} svg={charts[name]} />;
    return <p className="my-2.5" {...rest}>{children}</p>;
  },
  ul: (props: React.ComponentPropsWithoutRef<"ul">) => <ul className="list-disc pl-5 my-2 space-y-1" {...props} />,
  ol: (props: React.ComponentPropsWithoutRef<"ol">) => <ol className="list-decimal pl-5 my-2 space-y-1" {...props} />,
  li: (props: React.ComponentPropsWithoutRef<"li">) => <li className="text-foreground/90" {...props} />,
  blockquote: (props: React.ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 my-3 text-foreground/80 bg-muted/20 py-1.5 rounded-r" {...props} />
  ),
  table: (props: React.ComponentPropsWithoutRef<"table">) => (
    <div className="overflow-x-auto my-3"><table className="w-full text-[12.5px] border-collapse" {...props} /></div>
  ),
  thead: (props: React.ComponentPropsWithoutRef<"thead">) => <thead className="bg-muted/40" {...props} />,
  th: (props: React.ComponentPropsWithoutRef<"th">) => <th className="text-left font-semibold p-2 border border-border" {...props} />,
  td: (props: React.ComponentPropsWithoutRef<"td">) => <td className="align-top p-2 border border-border text-foreground/85" {...props} />,
  code: (props: React.ComponentPropsWithoutRef<"code">) => <code className="px-1 py-0.5 rounded bg-muted text-[12px] font-mono" {...props} />,
  pre: (props: React.ComponentPropsWithoutRef<"pre">) => <pre className="my-3 p-3 rounded-md bg-muted overflow-x-auto text-[12px]" {...props} />,
  hr: () => <hr className="my-6 border-border" />,
  em: (props: React.ComponentPropsWithoutRef<"em">) => <em className="italic text-foreground/80" {...props} />,
  strong: (props: React.ComponentPropsWithoutRef<"strong">) => <strong className="font-semibold text-foreground" {...props} />,
  };
}

// Renders a self-generated chart SVG inline, or the placeholder note if it's missing.
// The SVGs are first-party, produced by src/lib/svg-chart.ts (no scripts, no user input),
// so inlining the markup is safe here.
function ChartEmbed({ name, svg }: { name: string; svg: string | undefined }) {
  if (!svg) {
    return (
      <div className="my-3 flex items-center gap-2 text-[11px] text-muted-foreground/60 px-2.5 py-1.5 rounded-md bg-muted/30 border border-dashed border-border">
        <ImageOff className="w-3.5 h-3.5 shrink-0" />
        Chart <span className="font-mono text-foreground/70">{name}</span> not available yet (Brain/charts/{name}.svg).
      </div>
    );
  }
  return (
    <div
      className="my-4 w-full overflow-x-auto rounded-md border border-border bg-card [&_svg]:max-w-full [&_svg]:h-auto"
      role="img"
      aria-label={`Chart: ${name}`}
      // eslint-disable-next-line react/no-danger -- first-party, self-generated SVG (svg-chart.ts), not user input
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function VaultMarkdown({ raw, charts }: { raw: string; charts: Record<string, string> }) {
  const md = markChartEmbeds(stripFrontmatter(raw));
  const components = makeMarkdownComponents(charts);
  return (
    <article className="text-[13.5px] leading-relaxed text-foreground/90">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {md}
      </ReactMarkdown>
    </article>
  );
}

function EmptyState({ doc }: { doc: string }) {
  return (
    <div className="text-sm text-muted-foreground py-8 text-center">
      <FileText className="w-5 h-5 mx-auto mb-2 opacity-40" />
      No <span className="font-mono text-foreground/70">{doc}</span> in the vault yet.
      <p className="text-[11px] text-muted-foreground/50 mt-1">It is written each morning by the brief / chronicle jobs.</p>
    </div>
  );
}

export default async function BriefPage() {
  let morningBrief: string | null = null;
  let marketHistory: string | null = null;
  let error: string | null = null;

  let charts: Record<string, string> = {};

  try {
    const docs = await vaultReadMultiple(["Brain/morning-brief.md", "Brain/market-history.md"]);
    morningBrief = docs["Brain/morning-brief.md"] ?? null;
    marketHistory = docs["Brain/market-history.md"] ?? null;

    // Collect every chart referenced across both docs, fetch the SVGs from the DB vault
    // (Brain/charts/<name>.svg), and map them by name for inline rendering.
    const chartNames = [
      ...extractChartNames(morningBrief ?? ""),
      ...extractChartNames(marketHistory ?? ""),
    ];
    const uniqueNames = [...new Set(chartNames)];
    if (uniqueNames.length > 0) {
      const chartPaths = uniqueNames.map((n) => `Brain/charts/${n}.svg`);
      const chartDocs = await vaultReadMultiple(chartPaths);
      charts = uniqueNames.reduce<Record<string, string>>((acc, name) => {
        const svg = chartDocs[`Brain/charts/${name}.svg`];
        if (svg) acc[name] = svg;
        return acc;
      }, {});
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to read the vault.";
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Morning Brief</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The desk&apos;s daily intelligence — regime, key levels, historical analogues, and the market chronicle.
          Generated each morning and pulled live from the vault.
        </p>
      </div>

      {error && (
        <Card><CardContent className="py-4 text-sm text-red-400">{error}</CardContent></Card>
      )}

      <Card>
        <CardContent className="py-6">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground mb-3">
            <Sunrise className="w-3.5 h-3.5 text-amber-400" />
            Daily Brief
          </div>
          {morningBrief ? <VaultMarkdown raw={morningBrief} charts={charts} /> : <EmptyState doc="Brain/morning-brief.md" />}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-6">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground mb-3">
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            Market Chronicle
          </div>
          {marketHistory ? <VaultMarkdown raw={marketHistory} charts={charts} /> : <EmptyState doc="Brain/market-history.md" />}
        </CardContent>
      </Card>
    </div>
  );
}
