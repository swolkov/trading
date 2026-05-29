import fs from "node:fs";
import path from "node:path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function EdgesPage() {
  const filePath = path.join(process.cwd(), "EDGE-HIERARCHY.md");
  let markdown = "";
  let error: string | null = null;
  try {
    markdown = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to read EDGE-HIERARCHY.md";
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Edge Hierarchy</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The honest map of what we&apos;ve tested, what&apos;s deployable, what&apos;s speculative,
          and what isn&apos;t worth our time. Tier moves on evidence, never on hope.
        </p>
      </div>

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-red-400">{error}</CardContent>
        </Card>
      )}

      {markdown && (
        <Card>
          <CardContent className="py-6">
            <article className="edge-markdown text-[13.5px] leading-relaxed text-foreground/90">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: (props) => <h1 className="text-2xl font-bold mt-6 mb-3 text-foreground" {...props} />,
                  h2: (props) => <h2 className="text-xl font-bold mt-6 mb-2 text-foreground border-b border-border pb-1.5" {...props} />,
                  h3: (props) => <h3 className="text-base font-semibold mt-4 mb-2 text-foreground" {...props} />,
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
      )}
    </div>
  );
}
