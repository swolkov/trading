import fs from "node:fs";
import path from "node:path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Layers, ArrowRight, FileText } from "lucide-react";

export const dynamic = "force-dynamic";

function extractHeadings(md: string): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = [];
  const lines = md.split("\n");
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode) continue;
    const m = line.match(/^(##{0,2})\s+(.+)$/);
    if (!m) continue;
    const level = m[1].length;
    if (level > 2) continue; // only show h1/h2 in TOC
    const text = m[2].trim();
    const id = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    headings.push({ id, text, level });
  }
  return headings;
}

export default function EdgesPage() {
  const filePath = path.join(process.cwd(), "EDGE-HIERARCHY.md");
  let markdown = "";
  let error: string | null = null;
  try {
    markdown = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to read EDGE-HIERARCHY.md";
  }

  const headings = markdown ? extractHeadings(markdown) : [];

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Edge Hierarchy</h1>
          <p className="text-sm text-muted-foreground mt-1">
            The honest map of what we&apos;ve tested, what&apos;s deployable, what&apos;s speculative,
            and what isn&apos;t worth our time. Tier moves on evidence, never on hope.
          </p>
        </div>
        <Link
          href="/admin/strategies"
          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors"
        >
          <Layers className="w-3.5 h-3.5" />
          Active strategies
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-red-400">{error}</CardContent>
        </Card>
      )}

      {/* Mobile TOC — collapsible card visible only on mobile, since the sticky sidebar is hidden there */}
      {markdown && headings.length > 0 && (
        <details className="lg:hidden">
          <summary className="cursor-pointer list-none">
            <Card className="border-dashed">
              <CardContent className="py-2.5">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <FileText className="w-3 h-3" />
                  On this page
                  <span className="ml-auto text-muted-foreground/50">{headings.length} sections</span>
                </div>
              </CardContent>
            </Card>
          </summary>
          <Card className="mt-2">
            <CardContent className="py-4">
              <nav className="space-y-0.5">
                {headings.map((h, i) => (
                  <a
                    key={`${h.id}-${i}`}
                    href={`#${h.id}`}
                    className={`block text-[12px] py-0.5 hover:text-foreground transition-colors ${
                      h.level === 1 ? "font-semibold text-foreground/80" : "text-muted-foreground pl-2"
                    }`}
                  >
                    {h.text}
                  </a>
                ))}
              </nav>
            </CardContent>
          </Card>
        </details>
      )}

      {markdown && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
          {/* Main markdown content */}
          <Card>
            <CardContent className="py-6">
              <article className="edge-markdown text-[13.5px] leading-relaxed text-foreground/90">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children, ...rest }) => {
                      const id = String(children).toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
                      return <h1 id={id} className="text-2xl font-bold mt-6 mb-3 text-foreground scroll-mt-20" {...rest}>{children}</h1>;
                    },
                    h2: ({ children, ...rest }) => {
                      const id = String(children).toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
                      return <h2 id={id} className="text-xl font-bold mt-6 mb-2 text-foreground border-b border-border pb-1.5 scroll-mt-20" {...rest}>{children}</h2>;
                    },
                    h3: ({ children, ...rest }) => {
                      const id = String(children).toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
                      return <h3 id={id} className="text-base font-semibold mt-4 mb-2 text-foreground scroll-mt-20" {...rest}>{children}</h3>;
                    },
                    p: (props) => <p className="my-2.5" {...props} />,
                    ul: (props) => <ul className="list-disc pl-5 my-2 space-y-1" {...props} />,
                    ol: (props) => <ol className="list-decimal pl-5 my-2 space-y-1" {...props} />,
                    li: (props) => <li className="text-foreground/90" {...props} />,
                    table: (props) => (
                      <div className="overflow-x-auto my-3">
                        <table className="w-full text-[12.5px] border-collapse" {...props} />
                      </div>
                    ),
                    thead: (props) => <thead className="bg-muted/40" {...props} />,
                    th: (props) => <th className="text-left font-semibold p-2 border border-border" {...props} />,
                    td: (props) => <td className="align-top p-2 border border-border text-foreground/85" {...props} />,
                    code: (props) => <code className="px-1 py-0.5 rounded bg-muted text-[12px] font-mono" {...props} />,
                    pre: (props) => <pre className="my-3 p-3 rounded-md bg-muted overflow-x-auto text-[12px]" {...props} />,
                    hr: () => <hr className="my-6 border-border" />,
                    em: (props) => <em className="italic text-foreground/80" {...props} />,
                    strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
                  }}
                >
                  {markdown}
                </ReactMarkdown>
              </article>
            </CardContent>
          </Card>

          {/* TOC sidebar (desktop only) */}
          <aside className="hidden lg:block">
            <div className="sticky top-4">
              <Card>
                <CardContent className="py-4">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                    <FileText className="w-3 h-3" />
                    On this page
                  </div>
                  <nav className="space-y-0.5">
                    {headings.map((h, i) => (
                      <a
                        key={`${h.id}-${i}`}
                        href={`#${h.id}`}
                        className={`block text-[12px] py-0.5 hover:text-foreground transition-colors ${
                          h.level === 1 ? "font-semibold text-foreground/80" : "text-muted-foreground pl-2"
                        }`}
                      >
                        {h.text}
                      </a>
                    ))}
                  </nav>
                </CardContent>
              </Card>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
