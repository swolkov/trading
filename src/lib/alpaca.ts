import { getAlpacaConfig, type TradeType, type TradingMode } from "./trading-mode";

const DATA_URL = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";

// Dynamic base URL — switches between paper/live based on DB mode.
// DEFAULT IS ALWAYS PAPER. Live requires: password + env vars + explicit DB switch.
// Cache is keyed per mode key so view and trading modes resolve independently.
type AlpacaConfigResult = { baseUrl: string; apiKey: string; apiSecret: string; isLive: boolean };
const _configCache: Record<string, { config: AlpacaConfigResult; expires: number }> = {};

// Resolve Alpaca config. modeOverride lets API routes pass view mode
// (mirrors Tradovate's modeOverride pattern for dashboard display).
async function getConfig(modeOverride?: TradingMode) {
  const cacheKey = modeOverride || "trading";
  const cached = _configCache[cacheKey];
  if (cached && Date.now() < cached.expires) return cached.config;
  try {
    const config = await getAlpacaConfig("stocks", modeOverride);
    _configCache[cacheKey] = { config, expires: Date.now() + 60000 };
    return config;
  } catch {
    // If DB is unavailable, ALWAYS fall back to paper
    const config: AlpacaConfigResult = {
      baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
      apiKey: process.env.ALPACA_API_KEY || "",
      apiSecret: process.env.ALPACA_API_SECRET || "",
      isLive: false,
    };
    _configCache[cacheKey] = { config, expires: Date.now() + 60000 };
    return config;
  }
}

// All existing code references BASE_URL in template literals — this stays in sync with the mode.
let BASE_URL = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

// Check if currently in live mode (for display purposes)
export async function isLiveMode(): Promise<boolean> {
  const config = await getConfig();
  return config.isLive;
}

// Core fetch wrapper. modeOverride routes to paper/live Alpaca account
// (API routes pass getViewMode("stocks") for dashboard display).
async function alpacaFetch(url: string, options?: RequestInit, modeOverride?: TradingMode) {
  const config = await getConfig(modeOverride);
  BASE_URL = config.baseUrl;

  // Replace any stale BASE_URL in the URL if it was constructed before config loaded
  const resolvedUrl = url.replace(/https:\/\/(paper-api|api)\.alpaca\.markets/, config.baseUrl);

  const hdrs = {
    "APCA-API-KEY-ID": config.apiKey,
    "APCA-API-SECRET-KEY": config.apiSecret,
    "Content-Type": "application/json",
  };

  const res = await fetch(resolvedUrl, {
    ...options,
    headers: { ...hdrs, ...options?.headers },
    signal: AbortSignal.timeout(15000), // 15s timeout to prevent hanging
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca API error ${res.status}: ${body}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (options?.method === "DELETE") return; // DELETE returns no body
  if (!contentType.includes("json")) {
    throw new Error(`Alpaca returned non-JSON (${contentType}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// ---------- Account ----------

export interface Account {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  initial_margin: string;
  maintenance_margin: string;
  daytrade_count: number;
  pattern_day_trader: boolean;
  daytrading_buying_power: string;
  options_buying_power: string;
}

export async function getAccount(modeOverride?: TradingMode): Promise<Account> {
  return alpacaFetch(`${BASE_URL}/v2/account`, undefined, modeOverride);
}

// ---------- Positions ----------

export interface Position {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  avg_entry_price: string;
  qty: string;
  side: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export async function getPositions(modeOverride?: TradingMode): Promise<Position[]> {
  return alpacaFetch(`${BASE_URL}/v2/positions`, undefined, modeOverride);
}

// ---------- Orders ----------

export interface Order {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  symbol: string;
  qty: string;
  filled_qty: string;
  type: string;
  side: string;
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  filled_avg_price: string | null;
  status: string;
  order_class: string;
}

export async function getOrders(
  status: "open" | "closed" | "all" = "all",
  modeOverride?: TradingMode
): Promise<Order[]> {
  return alpacaFetch(
    `${BASE_URL}/v2/orders?status=${status}&limit=100&direction=desc`,
    undefined,
    modeOverride
  );
}

export interface PlaceOrderParams {
  symbol: string;
  qty?: string;        // whole/decimal share count — supply this OR notional, not both
  notional?: string;   // fractional dollar amount (e.g. "20.00") — enables fractional shares
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  limit_price?: string;
  extended_hours?: boolean;
  stop_price?: string;
}

export async function placeOrder(params: PlaceOrderParams, modeOverride?: TradingMode): Promise<Order> {
  // Alpaca rejects an order carrying both qty and notional. Prefer notional (fractional) when given.
  const body: Record<string, unknown> = { ...params };
  if (params.notional && Number(params.notional) > 0) {
    delete body.qty;
  } else {
    delete body.notional;
  }
  return alpacaFetch(`${BASE_URL}/v2/orders`, {
    method: "POST",
    body: JSON.stringify(body),
  }, modeOverride);
}

export async function cancelOrder(orderId: string): Promise<void> {
  await alpacaFetch(`${BASE_URL}/v2/orders/${orderId}`, {
    method: "DELETE",
  });
}

// ---------- Market Data ----------

export interface Quote {
  symbol: string;
  ap: number; // ask price
  as: number; // ask size
  bp: number; // bid price
  bs: number; // bid size
  t: string; // timestamp
}

export async function getQuote(symbol: string): Promise<Quote> {
  const data = await alpacaFetch(
    `${DATA_URL}/v2/stocks/${symbol}/quotes/latest?feed=iex`
  );
  return { symbol, ...data.quote };
}

export interface Bar {
  t: string; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

// Alpaca's bars API returns ONLY the current day's bars when no `start` is given.
// That starves every indicator/scanner (RSI/EMA/ATR need 15-55+ bars), so all
// setups silently fail. Default a sensible lookback per timeframe so callers that
// omit `start` still get enough history ending at the current bar (single page).
function defaultBarsStart(timeframe: string): string {
  const tf = timeframe.toLowerCase();
  let days: number;
  if (tf.includes("week")) days = 730;
  else if (tf.includes("day") || tf === "1d") days = 250;   // ~170 trading bars
  else if (tf.includes("hour") || /\dh$/.test(tf)) days = 10; // ~240 hourly bars
  else days = 3;                                              // minute frames
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function getBars(
  symbol: string,
  timeframe: string = "1Day",
  start?: string,
  end?: string
): Promise<Bar[]> {
  const params = new URLSearchParams({ timeframe, feed: "iex", limit: "500" });
  params.set("start", start || defaultBarsStart(timeframe));
  if (end) params.set("end", end);
  const data = await alpacaFetch(
    `${DATA_URL}/v2/stocks/${symbol}/bars?${params}`
  );
  return data.bars || [];
}

// ---------- Asset Search ----------

export interface Asset {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
}

export async function searchAssets(query: string): Promise<Asset[]> {
  const assets: Asset[] = await alpacaFetch(
    `${BASE_URL}/v2/assets?status=active&asset_class=us_equity`
  );
  const q = query.toUpperCase();
  return assets
    .filter(
      (a) =>
        a.tradable &&
        (a.symbol.includes(q) || a.name.toUpperCase().includes(q))
    )
    .slice(0, 20);
}

// ---------- Portfolio History ----------

export interface PortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: number[];
  base_value: number;
  timeframe: string;
}

export async function getPortfolioHistory(
  period: string = "1M",
  timeframe: string = "1D",
  modeOverride?: TradingMode
): Promise<PortfolioHistory> {
  return alpacaFetch(
    `${BASE_URL}/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}&intraday_reporting=market_hours&pnl_reset=per_day`,
    undefined,
    modeOverride
  );
}

// ---------- Account Activities ----------

export interface AccountActivity {
  id: string;
  activity_type: string;
  symbol: string;
  side: string;
  qty: string;
  price: string;
  cum_qty: string;
  leaves_qty: string;
  order_id: string;
  transaction_time: string;
  type: string;
  net_amount?: string;
}

export async function getAccountActivities(
  activityType: string = "FILL",
  modeOverride?: TradingMode
): Promise<AccountActivity[]> {
  return alpacaFetch(
    `${BASE_URL}/v2/account/activities/${activityType}?direction=desc&page_size=100`,
    undefined,
    modeOverride
  );
}

// ---------- Market Clock ----------

export interface MarketClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export async function getMarketClock(): Promise<MarketClock> {
  return alpacaFetch(`${BASE_URL}/v2/clock`);
}

// ---------- News ----------

export interface NewsArticle {
  id: number;
  headline: string;
  author: string;
  created_at: string;
  updated_at: string;
  summary: string;
  url: string;
  source: string;
  symbols: string[];
  images: { size: string; url: string }[];
}

export async function getNews(
  symbols?: string[],
  limit: number = 20
): Promise<NewsArticle[]> {
  const params = new URLSearchParams({ limit: String(limit), sort: "desc" });
  if (symbols && symbols.length > 0) {
    params.set("symbols", symbols.join(","));
  }
  const data = await alpacaFetch(`${DATA_URL}/v1beta1/news?${params}`);
  return data.news || [];
}

// ---------- Stock Snapshot ----------

export interface StockSnapshot {
  latestTrade: { p: number; s: number; t: string };
  latestQuote: { ap: number; as: number; bp: number; bs: number; t: string };
  minuteBar: { o: number; h: number; l: number; c: number; v: number; t: string };
  dailyBar: { o: number; h: number; l: number; c: number; v: number; t: string };
  prevDailyBar: { o: number; h: number; l: number; c: number; v: number; t: string };
}

export async function getSnapshot(
  symbol: string
): Promise<StockSnapshot> {
  return alpacaFetch(
    `${DATA_URL}/v2/stocks/${symbol}/snapshot?feed=iex`
  );
}

export async function getMultipleSnapshots(
  symbols: string[]
): Promise<Record<string, StockSnapshot>> {
  return alpacaFetch(
    `${DATA_URL}/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`
  );
}

// ---------- Most Active / Movers ----------

export interface MarketMover {
  symbol: string;
  percent_change: number;
  change: number;
  price: number;
  trade_count?: number;
  volume?: number;
}

export async function getMostActives(): Promise<MarketMover[]> {
  try {
    const data = await alpacaFetch(
      `${DATA_URL}/v1beta1/screener/stocks/most-actives?by=trades&top=20`
    );
    return data.most_actives || [];
  } catch {
    return [];
  }
}

export async function getTopMovers(
  type: "gainers" | "losers" = "gainers"
): Promise<MarketMover[]> {
  try {
    const data = await alpacaFetch(
      `${DATA_URL}/v1beta1/screener/stocks/movers?top=20`
    );
    return type === "gainers" ? data.gainers || [] : data.losers || [];
  } catch {
    return [];
  }
}

// ---------- Options ----------

export interface OptionsContract {
  id: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  expiration_date: string;
  root_symbol: string;
  underlying_symbol: string;
  underlying_asset_id: string;
  type: "call" | "put";
  style: string;
  strike_price: string;
  size: string;
  open_interest: string | null;
  close_price: string | null;
}

export interface OptionsSnapshot {
  latestQuote: {
    ap: number;
    as: number;
    bp: number;
    bs: number;
    t: string;
  };
  latestTrade?: {
    p: number;
    s: number;
    t: string;
    x: string;
    c: string[];
  };
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  };
  impliedVolatility?: number;
  // Alpaca returns daily bar data when available
  dailyBar?: {
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    t: string;
    vw: number;
  };
}

export async function getOptionsChain(
  underlyingSymbol: string,
  expiration?: string,
  type?: "call" | "put",
  expirationGte?: string,
  expirationLte?: string
): Promise<OptionsContract[]> {
  const params = new URLSearchParams({
    underlying_symbols: underlyingSymbol,
    status: "active",
    limit: "1000",
  });
  if (expiration) params.set("expiration_date", expiration);
  if (expirationGte) params.set("expiration_date_gte", expirationGte);
  if (expirationLte) params.set("expiration_date_lte", expirationLte);
  if (type) params.set("type", type);

  const data = await alpacaFetch(
    `${BASE_URL}/v2/options/contracts?${params}`
  );
  return data.option_contracts || [];
}

export async function getOptionsSnapshots(
  symbols: string[]
): Promise<Record<string, OptionsSnapshot>> {
  const data = await alpacaFetch(
    `${DATA_URL}/v1beta1/options/snapshots?symbols=${symbols.join(",")}&feed=indicative`
  );
  return data.snapshots || {};
}

export async function getOptionsExpirations(
  underlyingSymbol: string
): Promise<string[]> {
  const contracts = await getOptionsChain(underlyingSymbol);
  const expirations = [
    ...new Set(contracts.map((c) => c.expiration_date)),
  ].sort();
  return expirations;
}

// ---------- Crypto ----------

export const DEFAULT_CRYPTO_SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD", "DOGE/USD", "LINK/USD", "XRP/USD"];

export interface CryptoBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
  n: number;
}

export interface CryptoQuote {
  symbol: string;
  bp: number;
  bs: number;
  ap: number;
  as: number;
  t: string;
}

export interface CryptoSnapshot {
  latestTrade: { p: number; s: number; t: string; tks: string };
  latestQuote: { bp: number; bs: number; ap: number; as: number; t: string };
  minuteBar: CryptoBar;
  dailyBar: CryptoBar;
  prevDailyBar: CryptoBar;
}

export async function getCryptoQuote(symbol: string): Promise<CryptoQuote> {
  const encoded = encodeURIComponent(symbol);
  const data = await alpacaFetch(
    `${DATA_URL}/v1beta3/crypto/us/latest/quotes?symbols=${encoded}`
  );
  return { symbol, ...data.quotes?.[symbol] };
}

export async function getCryptoBars(
  symbol: string,
  timeframe: string = "1Day",
  start?: string,
  end?: string
): Promise<CryptoBar[]> {
  const encoded = encodeURIComponent(symbol);
  const params = new URLSearchParams({ timeframe, limit: "500" });
  params.set("start", start || defaultBarsStart(timeframe));
  if (end) params.set("end", end);
  const data = await alpacaFetch(
    `${DATA_URL}/v1beta3/crypto/us/bars?symbols=${encoded}&${params}`
  );
  return data.bars?.[symbol] || [];
}

export async function getCryptoSnapshot(symbol: string): Promise<CryptoSnapshot> {
  const encoded = encodeURIComponent(symbol);
  const data = await alpacaFetch(
    `${DATA_URL}/v1beta3/crypto/us/snapshots?symbols=${encoded}`
  );
  return data.snapshots?.[symbol];
}

export async function getCryptoSnapshots(
  symbols: string[]
): Promise<Record<string, CryptoSnapshot>> {
  const encoded = symbols.map(s => encodeURIComponent(s)).join(",");
  const data = await alpacaFetch(
    `${DATA_URL}/v1beta3/crypto/us/snapshots?symbols=${encoded}`
  );
  return data.snapshots || {};
}

export async function placeCryptoOrder(params: {
  symbol: string;
  qty?: string;
  notional?: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  limit_price?: string;
  stop_price?: string;
}, modeOverride?: TradingMode): Promise<Order> {
  return placeOrder({
    ...params,
    qty: params.qty || "0",
    time_in_force: "gtc", // crypto is 24/7
  }, modeOverride);
}

export async function getCryptoPositions(modeOverride?: TradingMode): Promise<Position[]> {
  const all = await getPositions(modeOverride);
  return all.filter(p => p.asset_class === "crypto");
}
