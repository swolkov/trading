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
// The brief embeds SVG charts via Obsidian "![[charts/NQ-morning.svg]]" syntax, but
// those SVGs live only in the local Obsidian vault (not the DB), so we render the
// markdown text cleanly and replace each embed with a labeled placeholder.

const CHART_EMBED_SRC = String.raw`!\[\[charts\/([^\]]+?)\.svg\]\]`;

// Strip YAML frontmatter (--- ... ---) the vault docs carry at the top.
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, "");
}

// Does this doc contain any Obsidian chart embeds?
function hasChartEmbeds(md: string): boolean {
  return new RegExp(CHART_EMBED_SRC).test(md);
}

// Replace Obsidian chart embeds with a marker we can render as a placeholder card.
function markChartEmbeds(md: string): string {
  return md.replace(new RegExp(CHART_EMBED_SRC, "g"), (_m, name) => `\n\n> 📈 **Chart: ${name}** — view in the Obsidian vault (Brain/charts/${name}.svg)\n\n`);
}

const markdownComponents = {
  h1: ({ children, ...rest }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1 className="text-2xl font-bold mt-6 mb-3 text-foreground" {...rest}>{children}</h1>
  ),
  h2: ({ children, ...rest }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2 className="text-lg font-bold mt-6 mb-2 text-foreground border-b border-border pb-1.5" {...rest}>{children}</h2>
  ),
  h3: ({ children, ...rest }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 className="text-base font-semibold mt-4 mb-2 text-foreground" {...rest}>{children}</h3>
  ),
  p: (props: React.ComponentPropsWithoutRef<"p">) => <p className="my-2.5" {...props} />,
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

function VaultMarkdown({ raw }: { raw: string }) {
  const hadCharts = hasChartEmbeds(raw);
  const md = markChartEmbeds(stripFrontmatter(raw));
  return (
    <>
      {hadCharts && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60 mb-3 px-2.5 py-1.5 rounded-md bg-muted/30 border border-dashed border-border">
          <ImageOff className="w-3.5 h-3.5 shrink-0" />
          Brief charts are SVGs stored in the local Obsidian vault and are shown there, not in this view.
        </div>
      )}
      <article className="text-[13.5px] leading-relaxed text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {md}
        </ReactMarkdown>
      </article>
    </>
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

  try {
    const docs = await vaultReadMultiple(["Brain/morning-brief.md", "Brain/market-history.md"]);
    morningBrief = docs["Brain/morning-brief.md"] ?? null;
    marketHistory = docs["Brain/market-history.md"] ?? null;
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
          {morningBrief ? <VaultMarkdown raw={morningBrief} /> : <EmptyState doc="Brain/morning-brief.md" />}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-6">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground mb-3">
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            Market Chronicle
          </div>
          {marketHistory ? <VaultMarkdown raw={marketHistory} /> : <EmptyState doc="Brain/market-history.md" />}
        </CardContent>
      </Card>
    </div>
  );
}
