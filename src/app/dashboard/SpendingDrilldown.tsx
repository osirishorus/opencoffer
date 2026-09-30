"use client";

import { useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { X } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Amount } from "@/components/Amount";

type Datum = { month: string; total: number };

type DrillItem = {
  category: string;
  total: number;
  count: number;
};
type DrillTx = {
  id: string;
  date: string;
  amount: number;
  name: string;
  merchant: string | null;
  category: string | null;
  account: string | null;
};

export function SpendingDrilldown({ data }: { data: Datum[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{ cats: DrillItem[]; tx: DrillTx[] } | null>(null);

  const onClick = async (month: string) => {
    if (open === month) {
      setOpen(null);
      setDetail(null);
      return;
    }
    setOpen(month);
    setLoading(true);
    const r = await fetch(`/api/dashboard/spending-detail?month=${encodeURIComponent(month)}`);
    if (r.ok) setDetail(await r.json());
    setLoading(false);
  };

  const max = Math.max(...data.map((d) => d.total), 1);

  return (
    <div className="space-y-4">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 12, right: 8, left: 0, bottom: 0 }}
            barCategoryGap="36%"
            onClick={(state) => {
              const label = state?.activeLabel;
              if (typeof label === "string") onClick(label);
            }}
          >
            <CartesianGrid stroke="hsl(0 0% 100% / 0.08)" vertical={false} strokeDasharray="2 4" />
            <XAxis
              dataKey="month"
              stroke="hsl(var(--md-on-surface-variant))"
              tick={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
              tickMargin={10}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="hsl(var(--md-on-surface-variant))"
              tick={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
              tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
              axisLine={false}
              tickLine={false}
              width={42}
            />
            <Tooltip
              cursor={{ fill: "hsl(var(--md-primary) / 0.08)" }}
              contentStyle={{
                background: "hsl(var(--md-surface-container-high))",
                border: "1px solid hsl(var(--md-on-surface) / 0.08)",
                borderRadius: 12,
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                color: "hsl(var(--md-on-surface))",
                padding: "10px 14px",
                boxShadow: "0 18px 50px rgba(0,0,0,0.38)",
              }}
              labelStyle={{
                color: "hsl(var(--md-on-surface-variant))",
                fontSize: 11,
                fontWeight: 500,
                marginBottom: 4,
              }}
              formatter={(v: number) => [`${formatCurrency(v)}`, "consumption"]}
            />
            <Bar dataKey="total" radius={[8, 8, 0, 0]} cursor="pointer">
              {data.map((d, i) => (
                <Cell
                  key={i}
                  fill={
                    open === d.month
                      ? "hsl(var(--md-primary))"
                      : d.total === max
                        ? "hsl(var(--md-primary))"
                        : "hsl(var(--md-primary) / 0.58)"
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {open && (
        <div className="rounded-2xl bg-surface-container p-4 mfade mfade-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Drill-in</div>
              <h3 className="title-m mt-1">{prettyMonth(open)} — top categories + transactions</h3>
            </div>
            <button
              onClick={() => {
                setOpen(null);
                setDetail(null);
              }}
              className="btn-icon"
            >
              <X size={16} />
            </button>
          </div>
          {loading && <div className="body-m mt-4 text-on-surface-variant">Loading…</div>}
          {detail && (
            <div className="mt-4 grid gap-6 md:grid-cols-2">
              <div>
                <div className="eyebrow mb-2">By category</div>
                <ul className="divide-y divide-outline-variant">
                  {detail.cats.map((c) => (
                    <li
                      key={c.category}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <span className="body-m truncate">{c.category}</span>
                      <span className="title-s font-mono tabular-nums">
                        <Amount value={c.total} />
                      </span>
                    </li>
                  ))}
                  {detail.cats.length === 0 && (
                    <li className="body-m py-3 text-on-surface-variant">No spending.</li>
                  )}
                </ul>
              </div>
              <div>
                <div className="eyebrow mb-2">Largest transactions</div>
                <ul className="divide-y divide-outline-variant">
                  {detail.tx.map((t) => (
                    <li key={t.id} className="grid grid-cols-[1fr_auto] gap-3 py-2">
                      <div className="min-w-0">
                        <div className="body-m truncate">{t.merchant ?? t.name}</div>
                        <div className="body-s text-on-surface-variant">
                          {formatDate(t.date)} · {t.category ?? "—"}
                        </div>
                      </div>
                      <div className="title-s font-mono tabular-nums text-error">
                        −<Amount value={Math.abs(t.amount)} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function prettyMonth(yyyymm: string) {
  const [y, m] = yyyymm.split("-").map(Number);
  if (!y || !m) return yyyymm;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
