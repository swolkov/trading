const BASE_URL = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const DATA_URL = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";

function headers() {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET || "",
    "Content-Type": "application/json",
  };
}

async function alpacaFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca API error ${res.status}: ${body}`);
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
}

export async function getAccount(): Promise<Account> {
  return alpacaFetch(`${BASE_URL}/v2/account`);
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

export async function getPositions(): Promise<Position[]> {
  return alpacaFetch(`${BASE_URL}/v2/positions`);
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
  status: "open" | "closed" | "all" = "all"
): Promise<Order[]> {
  return alpacaFetch(
    `${BASE_URL}/v2/orders?status=${status}&limit=100&direction=desc`
  );
}

export interface PlaceOrderParams {
  symbol: string;
  qty: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  limit_price?: string;
  extended_hours?: boolean;
  stop_price?: string;
}

export async function placeOrder(params: PlaceOrderParams): Promise<Order> {
  return alpacaFetch(`${BASE_URL}/v2/orders`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function cancelOrder(orderId: string): Promise<void> {
  await fetch(`${BASE_URL}/v2/orders/${orderId}`, {
    method: "DELETE",
    headers: headers(),
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

export async function getBars(
  symbol: string,
  timeframe: string = "1Day",
  start?: string,
  end?: string
): Promise<Bar[]> {
  const params = new URLSearchParams({ timeframe, feed: "iex", limit: "500" });
  if (start) params.set("start", start);
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
  timeframe: string = "1D"
): Promise<PortfolioHistory> {
  return alpacaFetch(
    `${BASE_URL}/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}&intraday_reporting=market_hours&pnl_reset=per_day`
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
  activityType: string = "FILL"
): Promise<AccountActivity[]> {
  return alpacaFetch(
    `${BASE_URL}/v2/account/activities/${activityType}?direction=desc&page_size=100`
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
  };
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  };
  impliedVolatility?: number;
}

export async function getOptionsChain(
  underlyingSymbol: string,
  expiration?: string,
  type?: "call" | "put"
): Promise<OptionsContract[]> {
  const params = new URLSearchParams({
    underlying_symbols: underlyingSymbol,
    status: "active",
    limit: "1000",
  });
  if (expiration) params.set("expiration_date", expiration);
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
