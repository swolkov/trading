// ============ DEPENDENCY-FREE SVG CHART GENERATOR ============
// Renders candlestick price charts as self-contained SVG strings — no canvas, no browser,
// no npm deps. Runs anywhere (cron, script, server). Used by the daily Morning Brief to draw
// the instruments the engine trades (NQ/ES/GC) with key levels marked. SVG renders in Obsidian,
// the dashboard, Slack, and email.

export interface Candle { date: string; o: number; h: number; l: number; c: number; v?: number; }
export interface Level { label: string; price: number; color?: string; }

interface ChartOpts {
  title: string;
  candles: Candle[];
  levels?: Level[];
  width?: number;
  height?: number;
  subtitle?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render an OHLC candlestick chart to a standalone SVG string. */
export function candlestickSVG(opts: ChartOpts): string {
  const W = opts.width ?? 900, H = opts.height ?? 360;
  const padL = 8, padR = 64, padT = 38, padB = 24; // right gutter for price axis, top for title
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const cs = opts.candles;
  if (!cs.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"></svg>`;

  const levels = opts.levels ?? [];
  const hi = Math.max(...cs.map(c => c.h), ...levels.map(l => l.price));
  const lo = Math.min(...cs.map(c => c.l), ...levels.map(l => l.price));
  const pad = (hi - lo) * 0.06 || 1;
  const yMax = hi + pad, yMin = lo - pad;
  const y = (p: number) => padT + plotH * (1 - (p - yMin) / (yMax - yMin));
  const n = cs.length;
  const slot = plotW / n;
  const cw = Math.max(1, Math.min(slot * 0.66, 10));
  const x = (i: number) => padL + slot * (i + 0.5);

  const up = "#16a34a", down = "#dc2626", grid = "#1f2937", txt = "#9ca3af", bg = "#0b0f17";
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,Menlo,monospace">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
  parts.push(`<text x="${padL}" y="20" fill="#e5e7eb" font-size="14" font-weight="600">${esc(opts.title)}</text>`);
  if (opts.subtitle) parts.push(`<text x="${padL}" y="34" fill="${txt}" font-size="10.5">${esc(opts.subtitle)}</text>`);

  // horizontal gridlines + price axis (5 ticks)
  for (let g = 0; g <= 4; g++) {
    const p = yMin + (yMax - yMin) * (g / 4); const yy = y(p);
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${grid}" stroke-width="0.5"/>`);
    parts.push(`<text x="${padL + plotW + 4}" y="${(yy + 3).toFixed(1)}" fill="${txt}" font-size="10">${p.toFixed(p > 1000 ? 0 : 2)}</text>`);
  }

  // candles
  for (let i = 0; i < n; i++) {
    const c = cs[i]; const xi = x(i); const col = c.c >= c.o ? up : down;
    parts.push(`<line x1="${xi.toFixed(1)}" y1="${y(c.h).toFixed(1)}" x2="${xi.toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    const yo = y(c.o), yc = y(c.c); const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
    parts.push(`<rect x="${(xi - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"/>`);
  }

  // key level lines (dashed) + labels
  for (const lv of levels) {
    if (lv.price < yMin || lv.price > yMax) continue;
    const yy = y(lv.price); const col = lv.color ?? "#f59e0b";
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="0.9" stroke-dasharray="4 3" opacity="0.85"/>`);
    parts.push(`<text x="${padL + 3}" y="${(yy - 2.5).toFixed(1)}" fill="${col}" font-size="9.5">${esc(lv.label)} ${lv.price.toFixed(lv.price > 1000 ? 0 : 2)}</text>`);
  }

  // x-axis date labels (first, middle, last)
  for (const i of [0, Math.floor(n / 2), n - 1]) {
    parts.push(`<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="${txt}" font-size="9.5" text-anchor="middle">${esc(cs[i].date.slice(2))}</text>`);
  }
  parts.push(`</svg>`);
  return parts.join("");
}
