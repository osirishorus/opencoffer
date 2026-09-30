"use client";

import { useId } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from "recharts";
import {
  FINANCE_CHART_COLORS,
  FINANCE_PIE_COLORS,
  collapseSmallSlices,
  type ChartFreshness,
  type ChartSpec,
} from "@/lib/finance/display";

export type { ChartSpec };

function fmt(v: number, format?: "currency" | "number") {
  if (format === "currency") {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 10_000) return `$${(v / 1000).toFixed(0)}k`;
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
    return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return v.toLocaleString();
}

/** Shorten YYYY-MM-DD → MMM-D for compact x-axis ticks. */
function fmtTick(v: unknown): string {
  if (typeof v !== "string") return String(v ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  const m2 = /^(\d{4})-(\d{2})$/.exec(v);
  if (m2) {
    const d = new Date(Number(m2[1]), Number(m2[2]) - 1, 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
  return v;
}
function fmtFull(v: number, format?: "currency" | "number") {
  if (format === "currency") return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return v.toLocaleString();
}

const TOOLTIP_STYLE = {
  background: "hsl(var(--md-surface-container-high))",
  border: "1px solid hsl(var(--md-on-surface) / 0.08)",
  borderRadius: 12,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "hsl(var(--md-on-surface))",
  padding: "10px 14px",
  boxShadow: "0 18px 50px rgba(0,0,0,0.38)",
};
const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "hsl(var(--md-on-surface-variant))",
};

function seriesLabel(spec: ChartSpec, key: string): string {
  return spec.seriesLabels?.[key] ?? key;
}

function seriesColor(key: string, index: number) {
  const k = key.toLowerCase();
  if (k.includes("income") || k.includes("asset") || k.includes("saving")) {
    return FINANCE_CHART_COLORS.income;
  }
  if (k.includes("outflow") || k.includes("debt") || k.includes("liabilit")) {
    return FINANCE_CHART_COLORS.outflow;
  }
  if (k.includes("spent") || k.includes("consumption")) {
    return FINANCE_CHART_COLORS.outflow;
  }
  if (k.includes("net") || k.includes("balance")) {
    return FINANCE_CHART_COLORS.net;
  }
  return FINANCE_PIE_COLORS[index % FINANCE_PIE_COLORS.length];
}

function formatSync(value: string | null) {
  if (!value) return "Not synced yet";
  return `Synced ${new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function ChartMetadata({ freshness }: { freshness?: ChartFreshness }) {
  if (!freshness) return null;
  const pieces = [
    formatSync(freshness.lastSyncedAt),
    freshness.dateWindow,
    `${freshness.categoryStatus.remaining} category remaining`,
    freshness.exclusions && freshness.exclusions.length > 0
      ? `Excludes ${freshness.exclusions.join(", ")}`
      : null,
  ].filter((piece): piece is string => typeof piece === "string" && piece.length > 0);
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 body-s text-on-surface-variant">
      {pieces.map((piece) => (
        <span key={piece}>{piece}</span>
      ))}
    </div>
  );
}

export function ChatChart({
  spec,
  bare = false,
  height = 288,
}: {
  spec: ChartSpec;
  /** When true: no card wrapper or duplicated title — caller owns the chrome. */
  bare?: boolean;
  height?: number;
}) {
  // Per-instance gradient ID so multiple charts on one page don't share SVG defs.
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gid = (suffix: string) => `${reactId}-${suffix}`;

  if (bare) {
    return (
      <div className="w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(spec, gid)}
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="card mt-3 overflow-hidden p-5">
      <div className="eyebrow mb-1 text-on-surface-variant">{spec.title}</div>
      {spec.subtitle && <div className="title-s text-on-surface">{spec.subtitle}</div>}
      {spec.description && <p className="body-s mt-1 text-on-surface-variant">{spec.description}</p>}
      <ChartMetadata freshness={spec.freshness} />
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(spec, gid)}
        </ResponsiveContainer>
      </div>
      {spec.footnote && <p className="body-s mt-2 text-on-surface-variant">{spec.footnote}</p>}
    </div>
  );
}

function renderChart(spec: ChartSpec, gid: (s: string) => string) {
  if (spec.type === "pie") {
    const data = spec.collapseSmallSlices ? collapseSmallSlices(spec.data) : spec.data;
    const total = data.reduce((s, d) => s + d.value, 0);
    return (
      <PieChart margin={{ top: 4, right: 4, bottom: 24, left: 4 }}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="44%"
          outerRadius={88}
          innerRadius={54}
          paddingAngle={1.5}
          isAnimationActive={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={FINANCE_PIE_COLORS[i % FINANCE_PIE_COLORS.length]} stroke="hsl(var(--md-surface))" strokeWidth={2} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(v: number, name: string) =>
            [
              `${fmtFull(v, spec.format)}${total > 0 ? ` · ${((v / total) * 100).toFixed(0)}%` : ""}`,
              name,
            ]
          }
        />
        <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" verticalAlign="bottom" height={44} />
      </PieChart>
    );
  }

  const isMulti = !!spec.yKey2;

  if (spec.type === "bar") {
    return (
      <BarChart data={spec.data} margin={{ top: 12, right: 12, left: 0, bottom: 4 }} barCategoryGap="28%">
        <CartesianGrid stroke={FINANCE_CHART_COLORS.grid} vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey={spec.xKey}
          stroke={FINANCE_CHART_COLORS.tick}
          tick={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
          tickFormatter={fmtTick}
          tickMargin={10}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={48}
        />
        <YAxis
          stroke={FINANCE_CHART_COLORS.tick}
          tick={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
          tickFormatter={(v) => fmt(v, spec.format)}
          axisLine={false}
          tickLine={false}
          width={54}
        />
        <Tooltip
          cursor={{ fill: "hsl(var(--md-primary) / 0.08)" }}
          contentStyle={TOOLTIP_STYLE}
          formatter={(v: number) => fmtFull(v, spec.format)}
        />
        {isMulti && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" />}
        <Bar
          dataKey={spec.yKey}
          name={seriesLabel(spec, spec.yKey)}
          fill={seriesColor(spec.yKey, 0)}
          radius={[6, 6, 0, 0]}
          isAnimationActive={false}
        />
        {spec.yKey2 && (
          <Bar
            dataKey={spec.yKey2}
            name={seriesLabel(spec, spec.yKey2)}
            fill={seriesColor(spec.yKey2, 1)}
            radius={[6, 6, 0, 0]}
            isAnimationActive={false}
          />
        )}
      </BarChart>
    );
  }

  if (spec.type === "line") {
    return (
      <LineChart data={spec.data} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={FINANCE_CHART_COLORS.grid} vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey={spec.xKey}
          stroke={FINANCE_CHART_COLORS.tick}
          tick={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
          tickFormatter={fmtTick}
          tickMargin={10}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={48}
        />
        <YAxis
          stroke={FINANCE_CHART_COLORS.tick}
          tick={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
          tickFormatter={(v) => fmt(v, spec.format)}
          axisLine={false}
          tickLine={false}
          width={56}
          domain={["dataMin", "dataMax"]}
          padding={{ top: 12, bottom: 12 }}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => fmtFull(v, spec.format)} />
        {isMulti && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" />}
        <Line
          type="monotone"
          dataKey={spec.yKey}
          name={seriesLabel(spec, spec.yKey)}
          stroke={seriesColor(spec.yKey, 0)}
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 5 }}
          isAnimationActive={false}
        />
        {spec.yKey2 && (
          <Line
            type="monotone"
            dataKey={spec.yKey2}
            name={seriesLabel(spec, spec.yKey2)}
            stroke={seriesColor(spec.yKey2, 1)}
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        )}
      </LineChart>
    );
  }

  // area
  return (
    <AreaChart data={spec.data} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
      <defs>
        <linearGradient id={gid("area1")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={seriesColor(spec.yKey, 0)} stopOpacity={0.28} />
          <stop offset="100%" stopColor={seriesColor(spec.yKey, 0)} stopOpacity={0.04} />
        </linearGradient>
        {isMulti && (
          <linearGradient id={gid("area2")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={seriesColor(spec.yKey2 ?? "", 1)} stopOpacity={0.28} />
            <stop offset="100%" stopColor={seriesColor(spec.yKey2 ?? "", 1)} stopOpacity={0.04} />
          </linearGradient>
        )}
      </defs>
      <CartesianGrid stroke={FINANCE_CHART_COLORS.grid} vertical={false} strokeDasharray="2 4" />
      <XAxis
        dataKey={spec.xKey}
        stroke={FINANCE_CHART_COLORS.tick}
        tick={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
        tickFormatter={fmtTick}
        tickMargin={10}
        axisLine={false}
        tickLine={false}
        interval="preserveStartEnd"
        minTickGap={48}
      />
      <YAxis
        stroke={FINANCE_CHART_COLORS.tick}
        tick={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
        tickFormatter={(v) => fmt(v, spec.format)}
        axisLine={false}
        tickLine={false}
        width={56}
        domain={["dataMin", "dataMax"]}
        padding={{ top: 12, bottom: 12 }}
      />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => fmtFull(v, spec.format)} />
      {isMulti && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" />}
      <Area type="monotone" dataKey={spec.yKey} name={seriesLabel(spec, spec.yKey)} stroke={seriesColor(spec.yKey, 0)} strokeWidth={2.5} fill={`url(#${gid("area1")})`} />
      {spec.yKey2 && (
        <Area type="monotone" dataKey={spec.yKey2} name={seriesLabel(spec, spec.yKey2)} stroke={seriesColor(spec.yKey2, 1)} strokeWidth={2.5} fill={`url(#${gid("area2")})`} />
      )}
    </AreaChart>
  );
}
