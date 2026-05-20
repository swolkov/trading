// ============ TRADOVATE WEBSOCKET MARKET DATA ============
// Real-time streaming quotes via Tradovate WebSocket API.
// Requires CME market data subscription on the Tradovate account.
// Falls back gracefully — if WS fails, engine uses Yahoo polling.
//
// Protocol: Tradovate uses SockJS-compatible framing over WebSocket.
// Messages: "o" (open), "h" (heartbeat), "a[...]" (data array), "c[...]" (close)

import WebSocket from "ws";

export interface QuoteUpdate {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number;
}

export type QuoteCallback = (quote: QuoteUpdate) => void;

interface TradovateWSOptions {
  accessToken: string;
  symbols: string[];          // Contract names: ["MESM6", "MNQM6"]
  onQuote: QuoteCallback;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (err: string) => void;
  logger?: (msg: string) => void;
  useLive?: boolean;          // true = live MD server, false = demo MD server
}

const DEMO_WS_URL = "wss://md-demo.tradovateapi.com/v1/websocket";
const LIVE_WS_URL = "wss://md.tradovateapi.com/v1/websocket";

export class TradovateWebSocket {
  private ws: WebSocket | null = null;
  private options: TradovateWSOptions;
  private connected = false;
  private authorized = false;
  private requestId = 1;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeartbeat = 0;
  private symbolSubscriptions: Map<string, number> = new Map(); // symbol → requestId
  private destroyed = false;

  constructor(options: TradovateWSOptions) {
    this.options = options;
  }

  private log(msg: string) {
    (this.options.logger || console.log)(`[WS-MD] ${msg}`);
  }

  get isConnected(): boolean {
    return this.connected && this.authorized;
  }

  connect(): void {
    if (this.destroyed) return;
    const url = this.options.useLive ? LIVE_WS_URL : DEMO_WS_URL;
    this.log(`Connecting to ${this.options.useLive ? "LIVE" : "DEMO"} MD WebSocket...`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.log(`Failed to create WebSocket: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.log("WebSocket connected");
      this.connected = true;
      this.reconnectAttempts = 0;
      // Server sends "o" frame on open, then we authorize
    });

    this.ws.on("message", (data: Buffer) => {
      this.handleMessage(data.toString());
    });

    this.ws.on("error", (err) => {
      this.log(`WebSocket error: ${err.message}`);
      this.options.onError?.(err.message);
    });

    this.ws.on("close", (code, reason) => {
      this.log(`WebSocket closed: ${code} ${reason.toString()}`);
      this.connected = false;
      this.authorized = false;
      this.symbolSubscriptions.clear();
      this.options.onDisconnect?.();
      if (!this.destroyed) this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string): void {
    this.lastHeartbeat = Date.now();

    // SockJS framing
    if (raw === "o") {
      // Open frame — send authorization
      this.sendFrame("authorize", this.requestId++, this.options.accessToken);
      return;
    }

    if (raw === "h") {
      // Heartbeat — respond to keep alive
      return;
    }

    if (raw.startsWith("c[")) {
      // Close frame
      this.log("Server sent close frame");
      return;
    }

    if (!raw.startsWith("a[")) return;

    // Data frame — parse array of messages
    try {
      const messages = JSON.parse(raw.slice(1)); // Remove "a" prefix
      for (const msg of messages) {
        this.handleDataMessage(msg);
      }
    } catch {
      // Sometimes raw data isn't JSON — ignore
    }
  }

  private handleDataMessage(msg: { s: number; i: number; d?: Record<string, unknown> }): void {
    // Authorization response
    if (msg.i === 1 || (!this.authorized && msg.s === 200)) {
      if (msg.s === 200) {
        this.authorized = true;
        this.log("Authorized — subscribing to symbols");
        this.subscribeAll();
        this.options.onConnect?.();
        this.startHeartbeatMonitor();
      } else {
        this.log(`Authorization failed: ${JSON.stringify(msg)}`);
        this.options.onError?.("Authorization failed");
      }
      return;
    }

    // Subscription response or error
    if (msg.d && "errorText" in msg.d) {
      const errText = msg.d.errorText as string;
      const errCode = msg.d.errorCode as string;
      // Find which symbol this error is for
      const sym = [...this.symbolSubscriptions.entries()].find(([, id]) => id === msg.i)?.[0] || "?";
      this.log(`${sym}: ${errText} (${errCode})`);
      if (errCode === "UnknownSymbol") {
        this.log(`${sym}: CME market data subscription may not be enabled on your Tradovate account`);
      }
      return;
    }

    // Quote update — extract price data
    if (msg.d && "entries" in msg.d) {
      this.handleQuoteEntries(msg.i, msg.d.entries as Record<string, { price?: number; size?: number }>);
      return;
    }

    // Chart data response
    if (msg.d && "charts" in msg.d) {
      // Chart data — not used for real-time quotes but could be used for bar preload
      return;
    }
  }

  private handleQuoteEntries(requestId: number, entries: Record<string, { price?: number; size?: number }>): void {
    // Find the symbol for this requestId
    const symbol = [...this.symbolSubscriptions.entries()].find(([, id]) => id === requestId)?.[0];
    if (!symbol) return;

    // Extract the base symbol (MESM6 → MES)
    const baseSym = symbol.replace(/[A-Z]\d$/, ""); // Remove month+year code

    const trade = entries.Trade || entries.Last;
    const bid = entries.Bid;
    const offer = entries.Offer || entries.Ask;
    const totalVol = entries.TotalTradeVolume;

    if (trade?.price) {
      this.options.onQuote({
        symbol: baseSym,
        price: trade.price,
        bid: bid?.price || trade.price,
        ask: offer?.price || trade.price,
        volume: totalVol?.size || trade.size || 0,
        timestamp: Date.now(),
      });
    }
  }

  private subscribeAll(): void {
    for (const sym of this.options.symbols) {
      const id = this.requestId++;
      this.symbolSubscriptions.set(sym, id);
      this.sendFrame("md/subscribeQuote", id, JSON.stringify({ symbol: sym }));
      this.log(`Subscribed to ${sym} (request #${id})`);
    }
  }

  private sendFrame(endpoint: string, id: number, body: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Tradovate protocol: endpoint\nid\n\nbody
    this.ws.send(`${endpoint}\n${id}\n\n${body}`);
  }

  private startHeartbeatMonitor(): void {
    // If no message for 30s, connection is dead — reconnect
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > 30_000) {
        this.log("Heartbeat timeout (30s) — reconnecting");
        this.ws?.close();
      }
    }, 10_000);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.log(`Max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up. Yahoo fallback active.`);
      }
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 60_000);
    this.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  updateToken(newToken: string): void {
    this.options.accessToken = newToken;
    // If connected, re-authorize with new token
    if (this.connected) {
      this.authorized = false;
      this.sendFrame("authorize", this.requestId++, newToken);
    }
  }

  updateSymbols(symbols: string[]): void {
    this.options.symbols = symbols;
    if (this.authorized) {
      // Unsubscribe old, subscribe new
      for (const [sym, id] of this.symbolSubscriptions) {
        this.sendFrame("md/unsubscribeQuote", this.requestId++, JSON.stringify({ symbol: sym }));
      }
      this.symbolSubscriptions.clear();
      this.subscribeAll();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
    this.ws = null;
  }
}
