import WebSocket from "ws";

type QuoteHandler = (data: {
  symbol: string;
  bp: number;
  ap: number;
  bs: number;
  as: number;
  t: string;
}) => void;

class AlpacaStreamManager {
  private ws: WebSocket | null = null;
  private subscriptions = new Set<string>();
  private handlers = new Set<QuoteHandler>();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private authenticated = false;

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const url = "wss://stream.data.alpaca.markets/v2/iex";
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.authenticate();
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const messages = JSON.parse(raw.toString());
        for (const msg of messages) {
          if (msg.T === "success" && msg.msg === "authenticated") {
            this.authenticated = true;
            if (this.subscriptions.size > 0) {
              this.sendSubscribe([...this.subscriptions]);
            }
          }
          if (msg.T === "q") {
            for (const handler of this.handlers) {
              handler({
                symbol: msg.S,
                bp: msg.bp,
                ap: msg.ap,
                bs: msg.bs,
                as: msg.as,
                t: msg.t,
              });
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on("close", () => {
      this.authenticated = false;
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      this.authenticated = false;
    });
  }

  private authenticate() {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        action: "auth",
        key: process.env.ALPACA_API_KEY,
        secret: process.env.ALPACA_API_SECRET,
      })
    );
  }

  private sendSubscribe(symbols: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        action: "subscribe",
        quotes: symbols,
      })
    );
  }

  private sendUnsubscribe(symbols: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        action: "unsubscribe",
        quotes: symbols,
      })
    );
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 3000);
  }

  subscribe(symbols: string[]) {
    const newSymbols = symbols.filter((s) => !this.subscriptions.has(s));
    for (const s of symbols) this.subscriptions.add(s);
    if (newSymbols.length > 0 && this.authenticated) {
      this.sendSubscribe(newSymbols);
    }
  }

  unsubscribe(symbols: string[]) {
    const removed = symbols.filter((s) => this.subscriptions.has(s));
    for (const s of symbols) this.subscriptions.delete(s);
    if (removed.length > 0 && this.authenticated) {
      this.sendUnsubscribe(removed);
    }
  }

  onQuote(handler: QuoteHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

const globalForStream = globalThis as unknown as {
  alpacaStream: AlpacaStreamManager;
};

export const alpacaStream =
  globalForStream.alpacaStream || new AlpacaStreamManager();

if (process.env.NODE_ENV !== "production")
  globalForStream.alpacaStream = alpacaStream;
