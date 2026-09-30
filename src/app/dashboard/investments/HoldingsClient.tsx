"use client";

import { Fragment, useState } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from "recharts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { Amount } from "@/components/Amount";
import { DataTable, Th, Td, Tr, Thead } from "@/components/DataTable";

type Ticker = {
  ticker: string;
  name: string;
  quantity: number;
  value: number;
  cost: number;
  accounts: Array<{ name: string; quantity: number; value: number }>;
};
type AccountPosition = {
  ticker: string;
  name: string;
  quantity: number;
  value: number;
  cost: number;
  gain: number | null;
  gainPct: number | null;
};
type AccountSection = {
  accountId: string;
  accountName: string;
  group: string;
  balance: number;
  positionsValue: number;
  positionsCost: number;
  positions: AccountPosition[];
};
type GroupRow = { group: string; value: number };
type Acct = {
  id: string;
  name: string;
  type: string;
  accountGroup: string;
  systemGroup: string;
  userOverride: string | null;
  currentBalance: number;
  currency: string | null;
};

const COLORS = [
  "hsl(207 100% 32%)",
  "hsl(155 60% 32%)",
  "hsl(28 80% 48%)",
  "hsl(345 70% 45%)",
  "hsl(265 50% 50%)",
  "hsl(195 70% 35%)",
  "hsl(80 50% 38%)",
  "hsl(330 55% 50%)",
];

export function HoldingsClient({
  totals,
  byTicker,
  byAccount,
  byGroup,
  accounts,
}: {
  totals: {
    marketValue: number;
    costBasis: number;
    positionsValue: number;
    unrealized: number | null;
    unrealizedPct: number | null;
  };
  byTicker: Ticker[];
  byAccount: AccountSection[];
  byGroup: GroupRow[];
  accounts: Acct[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<"by-account" | "combined">("by-account");
  const top = byTicker.slice(0, 10);
  const rest = byTicker.slice(10);
  const restValue = rest.reduce((s, t) => s + t.value, 0);

  const pieData = [
    ...top.map((t) => ({ name: t.ticker !== "—" ? t.ticker : t.name.slice(0, 16), value: t.value })),
    ...(restValue > 0 ? [{ name: "Others", value: restValue }] : []),
  ];
  const groupPie = byGroup.filter((g) => g.value > 0);

  return (
    <div className="space-y-6">
      {/* Headline */}
      <section className="grid grid-cols-12 gap-4">
        <Stat eyebrow="Market value · all" value={<Amount value={totals.marketValue} />} />
        <Stat eyebrow="Cost basis · positions" value={<Amount value={totals.costBasis} />} />
        <Stat
          eyebrow="Unrealized"
          value={
            totals.unrealized == null
              ? "—"
              : `${totals.unrealized >= 0 ? "+" : "−"}${formatCurrency(Math.abs(totals.unrealized))}`
          }
          sub={
            totals.unrealizedPct == null
              ? "(cost basis unavailable)"
              : `${totals.unrealizedPct >= 0 ? "+" : ""}${totals.unrealizedPct.toFixed(2)}%`
          }
          tone={totals.unrealized == null ? "default" : totals.unrealized >= 0 ? "success" : "error"}
        />
      </section>

      {/* Two pies side by side */}
      <section className="grid grid-cols-12 gap-6">
        <div className="card col-span-12 lg:col-span-6">
          <div className="eyebrow">Allocation by position</div>
          <h3 className="title-l mt-1">Top holdings</h3>
          <div className="mt-4 h-72">
            {pieData.length === 0 ? (
              <div className="grid h-full place-items-center body-m text-on-surface-variant">
                No positions reported yet.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={64}
                    outerRadius={104}
                    paddingAngle={1}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "hsl(220 4% 19%)",
                      border: 0,
                      borderRadius: 8,
                      fontSize: 13,
                      color: "hsl(240 11% 95%)",
                    }}
                    formatter={(v: number) => formatCurrency(v)}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
        <div className="card col-span-12 lg:col-span-6">
          <div className="eyebrow">By account type</div>
          <h3 className="title-l mt-1">Retirement vs taxable</h3>
          <div className="mt-4 h-72">
            {groupPie.length === 0 ? (
              <div className="grid h-full place-items-center body-m text-on-surface-variant">
                No investment accounts.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={groupPie}
                    dataKey="value"
                    nameKey="group"
                    cx="50%"
                    cy="50%"
                    innerRadius={64}
                    outerRadius={104}
                  >
                    {groupPie.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "hsl(220 4% 19%)",
                      border: 0,
                      borderRadius: 8,
                      fontSize: 13,
                      color: "hsl(240 11% 95%)",
                    }}
                    formatter={(v: number) => formatCurrency(v)}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* Positions — toggle between per-account (default) and combined */}
      <section className="card-elevated">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="title-l">Positions</h3>
            <p className="body-m mt-1 text-on-surface-variant">
              {view === "by-account"
                ? `${byAccount.length} accounts · ${byAccount.reduce((s, a) => s + a.positions.length, 0)} positions`
                : `${byTicker.length} unique tickers across all accounts`}
            </p>
          </div>
          <div className="inline-flex shrink-0 rounded-full bg-surface-container p-1 text-sm">
            <button
              onClick={() => setView("by-account")}
              className={`h-9 rounded-full px-4 transition-colors ${
                view === "by-account" ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              By account
            </button>
            <button
              onClick={() => setView("combined")}
              className={`h-9 rounded-full px-4 transition-colors ${
                view === "combined" ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              Combined
            </button>
          </div>
        </div>

        {view === "by-account" ? (
          <div className="mt-4 space-y-6">
            {byAccount.length === 0 && (
              <div className="body-m py-12 text-center text-on-surface-variant">
                No investment accounts reported.
              </div>
            )}
            {byAccount.map((acct) => {
              const acctGain = acct.positionsCost > 0 ? acct.positionsValue - acct.positionsCost : null;
              const acctGainPct =
                acct.positionsCost > 0
                  ? ((acct.positionsValue - acct.positionsCost) / acct.positionsCost) * 100
                  : null;
              return (
                <div key={acct.accountId} className="rounded-2xl bg-surface-low">
                  <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pt-4 pb-3">
                    <div>
                      <div className="title-m">{acct.accountName}</div>
                      <div className="body-s mt-0.5 text-on-surface-variant">
                        <span className="badge mr-2">{acct.group}</span>
                        {acct.positions.length} position{acct.positions.length === 1 ? "" : "s"} ·{" "}
                        <Amount value={acct.balance} /> balance
                      </div>
                    </div>
                    {acctGain != null && (
                      <div className={`title-s font-mono tabular-nums ${acctGain >= 0 ? "text-success" : "text-error"}`}>
                        {acctGain >= 0 ? "+" : "−"}
                        <Amount value={Math.abs(acctGain)} />
                        {acctGainPct != null && (
                          <span className="ml-1.5 body-s">
                            ({acctGainPct >= 0 ? "+" : ""}
                            {acctGainPct.toFixed(1)}%)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {acct.positions.length === 0 ? (
                    <div className="body-s px-5 pb-5 pt-2 text-on-surface-variant">
                      No positions reported for this account.
                    </div>
                  ) : (
                    <DataTable className="rounded-none rounded-b-2xl bg-transparent">
                      <Thead>
                        <Tr>
                          <Th>Ticker</Th>
                          <Th>Name</Th>
                          <Th align="right">Shares</Th>
                          <Th align="right">Value</Th>
                          <Th align="right">Cost</Th>
                          <Th align="right">Gain</Th>
                        </Tr>
                      </Thead>
                      <tbody>
                        {acct.positions.map((p, i) => (
                          <Tr key={`${acct.accountId}-${p.ticker}-${i}`}>
                            <Td mono className="text-primary">{p.ticker}</Td>
                            <Td className="text-on-surface-variant truncate max-w-[28ch]">{p.name}</Td>
                            <Td align="right" mono>
                              {p.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                            </Td>
                            <Td align="right" mono><Amount value={p.value} /></Td>
                            <Td align="right" mono className="text-on-surface-variant">
                              {p.cost > 0 ? <Amount value={p.cost} /> : "—"}
                            </Td>
                            <Td
                              align="right"
                              mono
                              className={p.gain == null ? "" : p.gain >= 0 ? "text-success" : "text-error"}
                            >
                              {p.gain == null
                                ? "—"
                                : `${p.gain >= 0 ? "+" : "−"}${formatCurrency(Math.abs(p.gain))}${p.gainPct != null ? ` · ${p.gainPct >= 0 ? "+" : ""}${p.gainPct.toFixed(1)}%` : ""}`}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </DataTable>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 -mx-6 -mb-6">
            <DataTable className="rounded-none rounded-b-2xl bg-transparent">
              <Thead>
                <Tr>
                  <Th></Th>
                  <Th>Ticker</Th>
                  <Th>Name</Th>
                  <Th align="right">Shares</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">Cost</Th>
                  <Th align="right">Gain</Th>
                </Tr>
              </Thead>
              <tbody>
                {byTicker.map((t) => {
                  const key = t.ticker !== "—" ? t.ticker : t.name;
                  const isOpen = open === key;
                  const gain = t.cost > 0 ? t.value - t.cost : null;
                  const gainPct = t.cost > 0 ? ((t.value - t.cost) / t.cost) * 100 : null;
                  return (
                    <Fragment key={key}>
                      <Tr className="cursor-pointer" onClick={() => setOpen(isOpen ? null : key)}>
                        <Td>
                          {t.accounts.length > 1 &&
                            (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                        </Td>
                        <Td mono className="text-primary">{t.ticker}</Td>
                        <Td className="text-on-surface-variant truncate max-w-[28ch]">{t.name}</Td>
                        <Td align="right" mono>
                          {t.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </Td>
                        <Td align="right" mono><Amount value={t.value} /></Td>
                        <Td align="right" mono className="text-on-surface-variant">
                          {t.cost > 0 ? <Amount value={t.cost} /> : "—"}
                        </Td>
                        <Td align="right" mono className={gain == null ? "" : gain >= 0 ? "text-success" : "text-error"}>
                          {gain == null
                            ? "—"
                            : `${gain >= 0 ? "+" : "−"}${formatCurrency(Math.abs(gain))}${gainPct != null ? ` · ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%` : ""}`}
                        </Td>
                      </Tr>
                      {isOpen &&
                        t.accounts.map((a, i) => (
                          <Tr key={`${key}-${i}`} className="bg-surface-container-low">
                            <Td></Td>
                            <Td></Td>
                            <Td colSpan={2} className="text-on-surface-variant">
                              at {a.name}
                            </Td>
                            <Td align="right" mono className="text-on-surface-variant">
                              {a.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} sh ·{" "}
                              <Amount value={a.value} />
                            </Td>
                            <Td></Td>
                            <Td></Td>
                          </Tr>
                        ))}
                    </Fragment>
                  );
                })}
                {byTicker.length === 0 && (
                  <tr>
                    <td colSpan={7} className="body-m px-4 py-16 text-center text-on-surface-variant">
                      No positions reported yet — your bridge may not return holdings for this account.
                    </td>
                  </tr>
                )}
              </tbody>
            </DataTable>
          </div>
        )}
      </section>

      {/* Accounts list */}
      <section className="card-elevated">
        <h3 className="title-l">Investment accounts</h3>
        <ul className="mt-4 divide-y divide-outline-variant">
          {accounts.map((a) => (
            <li key={a.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-3">
              <div>
                <div className="body-m text-on-surface">{a.name}</div>
                <div className="body-s text-on-surface-variant">{a.accountGroup}</div>
              </div>
              <span className="badge">{a.type}</span>
              <span className="title-s font-mono tabular-nums">
                <Amount value={a.currentBalance} currency={a.currency} />
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({
  eyebrow,
  value,
  sub,
  tone = "default",
}: {
  eyebrow: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "success" | "error";
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "error" ? "text-error" : "text-on-surface";
  return (
    <div className="card col-span-12 sm:col-span-4">
      <div className="eyebrow">{eyebrow}</div>
      <div className={`figure mt-2 text-[24px] sm:text-[28px] lg:text-[36px] ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="body-s mt-1.5 text-on-surface-variant">{sub}</div>}
    </div>
  );
}
