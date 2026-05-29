"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { SymbolSearch } from "@/components/trading/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, pnlColor } from "@/lib/utils";

interface AnalysisResult {
  score: number;
  signal: string;
  summary: string;
  thesis: string;
  risks: string[];
  catalysts: string[];
  priceTarget: number | null;
  confidence: number;
  keyMetrics: Record<string, string>;
  tradeIdea?: {
    action: string;
    entryPrice: number | null;
    targetPrice: number | null;
    stopLoss: number | null;
    reasoning: string;
    timeframe: string;
    riskReward: number | null;
  };
}

interface Report {
  id: number;
  symbol: string;
  name: string;
  sector: string;
  score: number;
  signal: string;
  summary: string;
  thesis: string;
  risks: string;
  catalysts: string;
  priceTarget: number | null;
  currentPrice: number | null;
  confidence: number;
  keyMetrics: string;
  createdAt: string;
}

interface TradeIdea {
  id: number;
  symbol: string;
  action: string;
  entryPrice: number | null;
  targetPrice: number | null;
  stopLoss: number | null;
  reasoning: string;
  timeframe: string;
  riskReward: number | null;
  status: string;
  createdAt: string;
}

interface ChatMsg {
  role: string;
  content: string;
}

function signalColor(signal: string) {
  if (signal.includes("buy")) return "text-emerald-500";
  if (signal.includes("sell")) return "text-red-500";
  return "text-amber-500";
}

function signalBadge(signal: string) {
  const colors: Record<string, string> = {
    strong_buy: "bg-emerald-600",
    buy: "bg-emerald-500",
    hold: "bg-amber-500",
    sell: "bg-red-500",
    strong_sell: "bg-red-600",
  };
  return (
    <Badge className={colors[signal] || "bg-muted"}>
      {signal.replace("_", " ").toUpperCase()}
    </Badge>
  );
}

function ScoreGauge({ score }: { score: number }) {
  const color =
    score > 50 ? "text-emerald-500" : score > 0 ? "text-emerald-400" :
    score > -20 ? "text-amber-500" : score > -50 ? "text-red-400" : "text-red-500";
  return (
    <div className="flex items-center gap-2">
      <span className={`text-4xl font-bold ${color}`}>
        {score > 0 ? "+" : ""}
        {score}
      </span>
      <span className="text-sm text-muted-foreground">/100</span>
    </div>
  );
}

function GradeCard({ label, grade }: { label: string; grade: string }) {
  const colors: Record<string, string> = {
    A: "text-emerald-500 border-emerald-500/30",
    B: "text-emerald-400 border-emerald-400/30",
    C: "text-amber-500 border-amber-500/30",
    D: "text-red-400 border-red-400/30",
    F: "text-red-500 border-red-500/30",
  };
  return (
    <div className={`border rounded-md p-2 text-center ${colors[grade] || ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold">{grade}</p>
    </div>
  );
}

export default function AIAnalystPage() {
  const [symbol, setSymbol] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [reports, setReports] = useState<Report[]>([]);
  const [ideas, setIdeas] = useState<TradeIdea[]>([]);
  const [scanning, setScanning] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const loadReports = useCallback(async () => {
    const res = await fetch("/api/ai/reports");
    const data = await res.json();
    if (Array.isArray(data)) setReports(data);
  }, []);

  const loadIdeas = useCallback(async () => {
    const res = await fetch("/api/ai/ideas");
    const data = await res.json();
    if (Array.isArray(data)) setIdeas(data);
  }, []);

  const loadChatHistory = useCallback(async () => {
    const res = await fetch("/api/ai/history");
    const data = await res.json();
    if (Array.isArray(data))
      setChatMessages(data.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })));
  }, []);

  useEffect(() => {
    loadReports();
    loadIdeas();
    loadChatHistory();
  }, [loadReports, loadIdeas, loadChatHistory]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  async function runAnalysis() {
    if (!symbol) return;
    setAnalyzing(true);
    setAnalysis(null);
    setAnalysisError("");
    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();
      if (data.error) {
        setAnalysisError(data.error);
      } else {
        setAnalysis(data);
        loadReports();
        loadIdeas();
      }
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed");
    }
    setAnalyzing(false);
  }

  async function runScan() {
    setScanning(true);
    try {
      await fetch("/api/ai/scan", { method: "POST" });
      loadReports();
      loadIdeas();
    } catch {
      // ignore
    }
    setScanning(false);
  }

  async function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setChatLoading(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          history: chatMessages.slice(-10),
        }),
      });
      const data = await res.json();
      if (data.response) {
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }
    } catch {
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I encountered an error. Please try again." },
      ]);
    }
    setChatLoading(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div><h1 className="text-xl font-bold tracking-tight">Claude Console</h1><p className="text-[11px] text-muted-foreground/50">AI-assisted research, idea generation, and trade analysis</p></div>
          <p className="text-sm text-muted-foreground">
            Deep research powered by Claude. Analyze any stock, scan the market, get trade ideas.
          </p>
        </div>
        <Button onClick={runScan} disabled={scanning} variant="outline">
          {scanning ? "Scanning market..." : "Scan Market for Opportunities"}
        </Button>
      </div>

      <Tabs defaultValue="analyze">
        <TabsList>
          <TabsTrigger value="analyze">Analyze Stock</TabsTrigger>
          <TabsTrigger value="chat">Chat with Analyst</TabsTrigger>
          <TabsTrigger value="library">Research Library ({reports.length})</TabsTrigger>
          <TabsTrigger value="ideas">Trade Ideas ({ideas.length})</TabsTrigger>
        </TabsList>

        {/* Analyze Tab */}
        <TabsContent value="analyze" className="space-y-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex gap-2 items-end">
                <div className="w-72">
                  <SymbolSearch onSelect={setSymbol} value={symbol} />
                </div>
                <Button
                  onClick={runAnalysis}
                  disabled={!symbol || analyzing}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  {analyzing ? "Analyzing..." : "Run Deep Analysis"}
                </Button>
              </div>
              {analyzing && (
                <p className="text-sm text-muted-foreground mt-3">
                  Gathering fundamentals, technicals, news, and running AI analysis... This takes 10-20 seconds.
                </p>
              )}
              {analysisError && (
                <p className="text-sm text-red-500 mt-3">Error: {analysisError}</p>
              )}
            </CardContent>
          </Card>

          {analysis && (
            <>
              {/* Score + Signal */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">
                      AI Score
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ScoreGauge score={analysis.score} />
                    <div className="flex items-center gap-2 mt-2">
                      {signalBadge(analysis.signal)}
                      <span className="text-xs text-muted-foreground">
                        {analysis.confidence}% confidence
                      </span>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">
                      Price Target
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {analysis.priceTarget ? (
                      <>
                        <div className="text-3xl font-bold">
                          {formatCurrency(analysis.priceTarget)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          12-month fair value estimate
                        </p>
                      </>
                    ) : (
                      <div className="text-muted-foreground">N/A</div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">
                      Grades
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-2">
                      <GradeCard label="Value" grade={analysis.keyMetrics.valuationGrade || "?"} />
                      <GradeCard label="Growth" grade={analysis.keyMetrics.growthGrade || "?"} />
                      <GradeCard label="Profit" grade={analysis.keyMetrics.profitabilityGrade || "?"} />
                      <GradeCard label="Health" grade={analysis.keyMetrics.financialHealthGrade || "?"} />
                      <GradeCard label="Technical" grade={analysis.keyMetrics.technicalGrade || "?"} />
                      <GradeCard label="Overall" grade={analysis.keyMetrics.overallGrade || "?"} />
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Summary */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Executive Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">{analysis.summary}</p>
                </CardContent>
              </Card>

              {/* Trade Idea */}
              {analysis.tradeIdea && analysis.tradeIdea.action !== "hold" && (
                <Card className="border-emerald-500/30">
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      Trade Idea
                      <Badge className="bg-emerald-600">
                        {analysis.tradeIdea.action.toUpperCase()}
                      </Badge>
                      <Badge variant="outline">
                        {analysis.tradeIdea.timeframe.replace("_", " ")}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-4 gap-4 mb-3">
                      <div>
                        <p className="text-xs text-muted-foreground">Entry</p>
                        <p className="font-semibold">
                          {analysis.tradeIdea.entryPrice
                            ? formatCurrency(analysis.tradeIdea.entryPrice)
                            : "Market"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Target</p>
                        <p className="font-semibold text-emerald-500">
                          {analysis.tradeIdea.targetPrice
                            ? formatCurrency(analysis.tradeIdea.targetPrice)
                            : "N/A"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Stop Loss</p>
                        <p className="font-semibold text-red-500">
                          {analysis.tradeIdea.stopLoss
                            ? formatCurrency(analysis.tradeIdea.stopLoss)
                            : "N/A"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Risk/Reward</p>
                        <p className="font-semibold">
                          {analysis.tradeIdea.riskReward
                            ? `1:${analysis.tradeIdea.riskReward.toFixed(1)}`
                            : "N/A"}
                        </p>
                      </div>
                    </div>
                    <p className="text-sm">{analysis.tradeIdea.reasoning}</p>
                  </CardContent>
                </Card>
              )}

              {/* Full Thesis */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Full Analysis</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {analysis.thesis}
                  </p>
                </CardContent>
              </Card>

              {/* Risks + Catalysts */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm text-red-500">Risks</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {analysis.risks.map((risk, i) => (
                        <li key={i} className="text-sm flex gap-2">
                          <span className="text-red-500 shrink-0">!</span>
                          {risk}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm text-emerald-500">
                      Catalysts
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {analysis.catalysts.map((cat, i) => (
                        <li key={i} className="text-sm flex gap-2">
                          <span className="text-emerald-500 shrink-0">+</span>
                          {cat}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* Chat Tab */}
        <TabsContent value="chat">
          <Card className="flex flex-col h-[600px]">
            <CardHeader className="pb-2 shrink-0">
              <CardTitle className="text-sm flex items-center justify-between">
                Trading Analyst Chat
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await fetch("/api/ai/history", { method: "DELETE" });
                    setChatMessages([]);
                  }}
                >
                  Clear Chat
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto space-y-3 min-h-0">
              {chatMessages.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-8">
                  <p className="font-medium mb-2">Ask me anything about trading:</p>
                  <div className="space-y-1 text-xs">
                    <p>&quot;What stocks should I look at today?&quot;</p>
                    <p>&quot;Is AAPL overvalued right now?&quot;</p>
                    <p>&quot;Build me a diversified portfolio with $100k&quot;</p>
                    <p>&quot;What options strategy for TSLA earnings?&quot;</p>
                    <p>&quot;Explain my best trade ideas&quot;</p>
                  </div>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${
                    msg.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    <pre className="whitespace-pre-wrap font-sans">
                      {msg.content}
                    </pre>
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground">
                    Thinking...
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </CardContent>
            <div className="p-4 border-t shrink-0">
              <form onSubmit={sendChat} className="flex gap-2">
                <Input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask about any stock, strategy, or market..."
                  disabled={chatLoading}
                />
                <Button type="submit" disabled={chatLoading || !chatInput.trim()}>
                  Send
                </Button>
              </form>
            </div>
          </Card>
        </TabsContent>

        {/* Library Tab */}
        <TabsContent value="library" className="space-y-4">
          {reports.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No research reports yet. Analyze a stock or run a market scan to build your library.
              </CardContent>
            </Card>
          ) : (
            reports.map((report) => {
              let risks: string[] = [];
              let catalysts: string[] = [];
              let metrics: Record<string, string> = {};
              try { risks = JSON.parse(report.risks); } catch {}
              try { catalysts = JSON.parse(report.catalysts); } catch {}
              try { metrics = JSON.parse(report.keyMetrics); } catch {}

              return (
                <Card key={report.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CardTitle className="text-base">
                          {report.symbol}
                        </CardTitle>
                        <span className="text-sm text-muted-foreground">
                          {report.name}
                        </span>
                        {signalBadge(report.signal)}
                        <span className={`text-sm font-bold ${report.score > 0 ? "text-emerald-500" : report.score < 0 ? "text-red-500" : "text-amber-500"}`}>
                          {report.score > 0 ? "+" : ""}{report.score}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {report.priceTarget && (
                          <span>
                            Target: {formatCurrency(report.priceTarget)}
                          </span>
                        )}
                        <span>
                          {new Date(report.createdAt).toLocaleDateString()}
                        </span>
                        <Link
                          href={`/research/${report.symbol}`}
                          className="text-primary hover:underline"
                        >
                          Full Data
                        </Link>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm mb-3">{report.summary}</p>
                    {metrics.overallGrade && (
                      <div className="flex gap-4 text-xs mb-3">
                        <span>Overall: <strong>{metrics.overallGrade}</strong></span>
                        <span>Value: <strong>{metrics.valuationGrade}</strong></span>
                        <span>Growth: <strong>{metrics.growthGrade}</strong></span>
                        <span>Health: <strong>{metrics.financialHealthGrade}</strong></span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {catalysts.length > 0 && (
                        <div>
                          <span className="text-emerald-500 font-medium">Catalysts: </span>
                          {catalysts.join(" | ")}
                        </div>
                      )}
                      {risks.length > 0 && (
                        <div>
                          <span className="text-red-500 font-medium">Risks: </span>
                          {risks.join(" | ")}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        {/* Trade Ideas Tab */}
        <TabsContent value="ideas" className="space-y-4">
          {ideas.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No trade ideas yet. Run analyses to generate ideas.
              </CardContent>
            </Card>
          ) : (
            ideas.map((idea) => (
              <Card key={idea.id} className="border-l-4 border-l-emerald-500">
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-lg">{idea.symbol}</span>
                      <Badge
                        className={
                          idea.action.includes("buy") || idea.action.includes("call")
                            ? "bg-emerald-600"
                            : idea.action.includes("sell") || idea.action.includes("put")
                            ? "bg-red-600"
                            : "bg-amber-500"
                        }
                      >
                        {idea.action.replace("_", " ").toUpperCase()}
                      </Badge>
                      <Badge variant="outline">
                        {idea.timeframe.replace("_", " ")}
                      </Badge>
                      <Badge
                        variant={idea.status === "active" ? "default" : "secondary"}
                      >
                        {idea.status}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(idea.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-4 mb-2 text-sm">
                    <div>
                      <span className="text-xs text-muted-foreground">Entry</span>
                      <p className="font-medium">
                        {idea.entryPrice ? formatCurrency(idea.entryPrice) : "Market"}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">Target</span>
                      <p className="font-medium text-emerald-500">
                        {idea.targetPrice ? formatCurrency(idea.targetPrice) : "N/A"}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">Stop Loss</span>
                      <p className="font-medium text-red-500">
                        {idea.stopLoss ? formatCurrency(idea.stopLoss) : "N/A"}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground">R/R</span>
                      <p className="font-medium">
                        {idea.riskReward ? `1:${idea.riskReward.toFixed(1)}` : "N/A"}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">{idea.reasoning}</p>
                  <div className="flex gap-2 mt-3">
                    <Link
                      href={`/trade?symbol=${idea.symbol}`}
                      className="text-xs text-emerald-500 hover:underline"
                    >
                      Execute Trade
                    </Link>
                    <Separator orientation="vertical" className="h-4" />
                    <Link
                      href={`/research/${idea.symbol}`}
                      className="text-xs text-primary hover:underline"
                    >
                      View Research
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
