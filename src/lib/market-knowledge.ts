// ============ MARKET KNOWLEDGE BASE ============
// Decades of proven market patterns, historical wisdom, and statistical edges
// This gets loaded into every AI analysis to give it "veteran trader" knowledge

export function getMarketKnowledgeBase(): string {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
  const dayOfMonth = now.getDate();

  return `
## MARKET KNOWLEDGE BASE — Apply This Wisdom to Every Analysis

### 1. MARKET CYCLE PATTERNS (Wyckoff Method)
Markets move in 4 phases. Identify which phase the stock is in:
- ACCUMULATION: Smart money buying after a decline. Low volume, tight range. Signs: higher lows forming, volume increasing on up days. Action: BUY calls (early entry).
- MARKUP: Trending up with increasing volume. Moving averages aligned bullish. Action: BUY calls, ride the trend, trail stops.
- DISTRIBUTION: Smart money selling. High volume but price stalling. Signs: lower highs forming, bearish divergences. Action: SELL calls, BUY puts for reversal.
- MARKDOWN: Trending down. Volume increasing on down days. Action: BUY puts, avoid calls.

### 2. SECTOR ROTATION (Economic Cycle)
Money rotates between sectors based on the economic cycle:
- EARLY RECOVERY: Financials, Consumer Discretionary, Industrials, Real Estate lead
- MID CYCLE: Technology, Communication Services, Materials outperform
- LATE CYCLE: Energy, Healthcare, Consumer Staples, Utilities are defensive
- RECESSION: Cash, Treasuries, Utilities, Healthcare hold up best
Consider where we are in the cycle when picking sectors.

### 3. SEASONAL PATTERNS (Statistically Proven)
Current month: ${month}
${month === 1 ? "JANUARY EFFECT: Small caps tend to outperform in January. Historically bullish month." : ""}
${month === 5 ? "SELL IN MAY: Historical tendency for weaker summer returns (May-October). Consider reducing exposure." : ""}
${month >= 5 && month <= 10 ? "SUMMER DOLDRUMS: May through October historically weaker. Be more selective, tighter stops." : ""}
${month >= 11 || month <= 4 ? "BEST 6 MONTHS: November through April historically strongest period for stocks." : ""}
${month === 12 ? "SANTA RALLY: Last 5 trading days of December + first 2 of January tend to be bullish. Tax-loss selling may create opportunities." : ""}
${month === 10 ? "OCTOBER EFFECT: Historically volatile month (1929, 1987, 2008 crashes happened in October). Be cautious but also look for oversold bounces." : ""}
- Options expiration week (3rd Friday of each month): Increased volatility, stocks tend to pin to max pain strike.
- Earnings season (Jan, Apr, Jul, Oct): Higher implied volatility. Buy options AFTER earnings, not before (avoid IV crush).
${dayOfWeek === 1 ? "MONDAY: Historically weakest day. 'Monday Effect' — markets tend to continue Friday's direction or reverse." : ""}
${dayOfWeek === 5 ? "FRIDAY: Options expiring today. Watch for gamma squeeze near popular strikes. Position squaring before weekend." : ""}

### 4. OPTIONS-SPECIFIC PATTERNS
- IV CRUSH: Implied volatility drops 30-60% after earnings. NEVER buy options right before earnings unless using a straddle.
- THETA DECAY CURVE: Time decay accelerates in the last 2 weeks before expiration. Buy with 30-45 DTE, sell with 14-21 DTE.
- PUT-CALL RATIO: When extreme (>1.2 = very bearish sentiment, <0.6 = very bullish). Extreme readings often signal reversals (contrarian indicator).
- MAX PAIN: Stocks tend to gravitate toward the strike with highest open interest by expiration. Check max pain before choosing strikes.
- VOLATILITY SMILE: OTM puts are typically more expensive than OTM calls (skew). This means downside protection is expensive — consider put spreads instead of naked puts.
- GAMMA EXPOSURE: Near expiration, stocks with large open interest at nearby strikes experience "gamma squeezes" — large, fast moves as market makers hedge.

### 5. TECHNICAL ANALYSIS WISDOM
- TREND IS YOUR FRIEND: 70% of stocks follow the broader market. Don't fight the trend.
- SUPPORT/RESISTANCE: Stocks that bounce off a level 3+ times create strong support/resistance. These are high-probability options entries.
- VOLUME CONFIRMS: Price moves on high volume are real. Price moves on low volume are suspect.
- RSI DIVERGENCE: If price makes new high but RSI doesn't — bearish divergence (reversal likely). If price makes new low but RSI doesn't — bullish divergence.
- 200-DAY SMA: Institutional investors watch this closely. Stocks above 200-SMA are in long-term uptrends. Stocks below are in downtrends.
- GOLDEN CROSS (50-SMA crossing above 200-SMA): Strong bullish signal. DEATH CROSS (opposite): Strong bearish signal.
- BREAKOUT ON VOLUME: When a stock breaks above resistance on 2x+ average volume, it's a high-probability continuation. Buy calls immediately.
- GAP AND GO: Stocks that gap up 3%+ at open and hold above the gap in the first 30 minutes tend to continue higher. Buy calls.
- GAP AND FADE: Stocks that gap up but fall below the opening price within 30 minutes often fill the gap. Buy puts.

### 6. RISK MANAGEMENT RULES FROM LEGENDARY TRADERS
- "Cut your losses short, let your winners run" — Jesse Livermore
- Never risk more than 2% of portfolio on a single trade
- The first loss is the cheapest loss — don't average down on losing options (theta will kill you)
- If you don't know why you're in a trade, get out
- Don't trade when you don't have an edge (choppy, no-trend markets)
- Position size based on conviction: highest conviction = 2% risk, moderate = 1%, speculative = 0.5%
- NEVER move your stop loss further away from your entry — only move it closer (trailing)

### 7. MARKET PSYCHOLOGY & SENTIMENT
- FEAR AND GREED: Markets are driven by these two emotions. When VIX > 30, fear is extreme (buy opportunity). When VIX < 15, complacency (be cautious).
- CAPITULATION: The final stage of a selloff where everyone gives up. Volume spikes, price drops fast, then reverses sharply. This is THE best time to buy calls.
- FOMO (Fear of Missing Out): When everyone is buying and excitement is extreme, the top is near. Don't chase.
- SMART MONEY vs DUMB MONEY: Insiders (CEO/CFO buying) = smart money. Retail traders piling in = dumb money. Follow the insiders.

### 8. EARNINGS PATTERNS
- PRE-EARNINGS DRIFT: Stocks tend to drift in the direction of the eventual earnings surprise in the 2-3 weeks before reporting.
- POST-EARNINGS DRIFT: If a stock gaps up on earnings beat, it tends to continue higher for 2-4 weeks (momentum). Same for gaps down.
- WHISPER NUMBERS: The actual expectation is often higher than the official estimate. A stock can "beat" estimates but still fall if it misses the whisper number.
- GUIDANCE > EARNINGS: The market cares more about forward guidance than the actual earnings number. A beat with lowered guidance = bearish.

### 9. FED & MACRO PATTERNS
- "Don't fight the Fed" — When the Fed is cutting rates, stocks tend to rise. When hiking, be cautious.
- CPI PRINTS: Higher than expected = bearish (more rate hikes). Lower = bullish.
- FOMC MEETINGS: Markets are volatile around Fed meetings. The announcement often causes a fake move in one direction, then reverses. Wait 30 minutes after announcement before trading.
- YIELD CURVE: Inverted yield curve (2-year > 10-year) has predicted every recession. Watch this.
- JOBS REPORT: Strong jobs = hawkish Fed = bearish for growth stocks. Weak jobs = dovish Fed = bullish for growth.

### 10. OPTIONS STRATEGY SELECTION GUIDE
Use this to pick the right strategy for each situation:
- Strong bullish + low IV → BUY CALLS (simple, high leverage)
- Moderate bullish + high IV → BULL CALL SPREAD (reduces cost)
- Strong bearish + low IV → BUY PUTS
- Moderate bearish + high IV → BEAR PUT SPREAD
- Big event coming (earnings, FDA) → STRADDLE (bet on big move either way)
- Stock in a range, high IV → SELL PREMIUM (iron condor, covered calls)
- Long-term conviction + want safety → LEAPS (deep ITM, 6-12 month)
- Quick scalp + clear direction → 0DTE ATM (maximum gamma, highest risk)

APPLY ALL OF THIS KNOWLEDGE when making your recommendation. Don't just look at the numbers — think about WHERE we are in the market cycle, WHAT seasonal patterns apply, and HOW the current macro environment affects this trade.
`;
}
