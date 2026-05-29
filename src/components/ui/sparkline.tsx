"use client";

/**
 * Inline SVG sparkline — compact P&L visualization.
 * Renders a line connecting points; positive bars green, negative red.
 */
export function Sparkline({
  data,
  width = 80,
  height = 24,
  color,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (!data || data.length < 2) {
    return <span className="text-[10px] text-muted-foreground/30 inline-block" style={{ width, height: height + 2 }}>—</span>;
  }
  const max = Math.max(...data, 0);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pad = 2;
  const xStep = (width - pad * 2) / (data.length - 1);

  const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
  const points = data.map((v, i) => `${pad + i * xStep},${y(v)}`).join(" ");

  // Zero line if zero is within range
  const zeroY = min < 0 && max > 0 ? y(0) : null;

  // Decide stroke color: if no explicit color, color by net direction (last vs first)
  const stroke = color ?? (data[data.length - 1] >= data[0] ? "rgb(52 211 153)" : "rgb(248 113 113)");

  return (
    <svg width={width} height={height} className="inline-block align-middle">
      {zeroY !== null && (
        <line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} stroke="rgb(156 163 175 / 0.2)" strokeDasharray="2 2" />
      )}
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
      {/* Last value dot */}
      <circle cx={pad + (data.length - 1) * xStep} cy={y(data[data.length - 1])} r="1.5" fill={stroke} />
    </svg>
  );
}
