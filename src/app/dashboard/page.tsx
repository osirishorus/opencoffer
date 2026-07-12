import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { findTool } from "@/lib/finance/tools";
import { formatCurrency, formatDate } from "@/lib/utils";
import { AppBar } from "@/components/AppBar";
import { ArrowUpRight, Bot, Plus, Repeat, TrendingUp, PiggyBank } from "lucide-react";
import { SpendingDrilldown } from "./SpendingDrilldown";
import { InsightsCard } from "@/components/InsightsCard";

async function callTool<T>(name: string, args: Record<string, unknown>, userId: string) {
  const t = findTool(name)!;
  const parsed = t.schema.parse(args);
  return (await t.execute(parsed, { userId })) as T;
}

export default async function Dashboard() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const [netWorth, recurring, spending, savingsDestinations, flow, accounts, recent] = await Promise.all([
    callTool<{ assets: number; liabilities: number; netWorth: number; accountCount: number; realAssetCount: number }>(
      "get_net_worth", {}, userId,
    ),
    callTool<Array<{ merchant: string; months: number; typicalAmount: number; lastDate: Date; totalCharges: number }>>(
      "get_recurring_merchants", { days: 365 }, userId,
    ),
    // Consumption-only spending — retirement + investments excluded.
    callTool<Array<{ period: string; category: string; total: number; count: number }>>(
      "get_spending_by_category", { days: 180, groupBy: "month", kind: "consumption" }, userId,
    ),
    // Destination-aware savings flow. This fixes category-only "where savings goes"
    // views by using cash retained plus destination account groups.
    callTool<{ _chart: { data: Array<{ name: string; value: number }> } }>(
      "chart_savings_destinations", { days: 90 }, userId,
    ),
    // Income vs consumption vs savings for the savings-rate card.
    callTool<Array<{ period: string; consumption: number; savings: number; income: number; net: number; savingsRate: number | null }>>(
      "get_consumption_vs_savings", { days: 90, groupBy: "month" }, userId,
    ),
    callTool<Array<{ id: string; name: string; source: string; type: string; subtype: string | null; currentBalance: number; mask: string | null; currency: string | null }>>(
      "get_accounts", {}, userId,
    ),
    callTool<{ transactions: Array<{ id: string; date: Date | string; amount: number; name: string; merchant: string | null; category: string | null; pending: boolean; currency: string | null }> }>(
      "get_recent_transactions", { days: 30, accountId: null, category: null, limit: 8 }, userId,
    ).then((r) => r.transactions),
  ]);

  if (accounts.length === 0 && netWorth.realAssetCount === 0) {
    return (
      <>
        <AppBar title="Overview" />
        <EmptyState />
      </>
    );
  }

  const months = new Map<string, number>();
  for (const r of spending) months.set(r.period, (months.get(r.period) ?? 0) + r.total);
  const chartData = [...months.entries()].sort().slice(-6).map(([month, total]) => ({
    month, total: Math.round(total * 100) / 100,
  }));

  const monthlyRecurringTotal = recurring.reduce((s, r) => s + r.typicalAmount, 0);
  const top = topCategories(spending, 6);
  const today = new Date();

  // 90-day savings rate from the consumption-vs-savings tool.
  const flow90 = flow.reduce(
    (acc, r) => ({
      income: acc.income + r.income,
      consumption: acc.consumption + r.consumption,
      savings: acc.savings + r.savings,
    }),
    { income: 0, consumption: 0, savings: 0 },
  );
  const savingsRows = savingsDestinations._chart.data.filter((row) => row.value > 0);
  const totalSaved = Math.round(savingsRows.reduce((sum, row) => sum + row.value, 0) * 100) / 100;
  const savingsRate =
    flow90.income > 0
      ? Math.round((totalSaved / flow90.income) * 1000) / 10
      : null;

  return (
    <>
      <AppBar
        title="OpenCoffer"
        subtitle={today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        actions={
          <>
            <Link href="/chat" className="btn btn-outlined hidden sm:inline-flex">
              Open chat
            </Link>
            <Link
              href="/settings/connections"
              className="btn btn-filled px-4 sm:px-6"
              aria-label="Add institution"
            >
              <Plus size={18} strokeWidth={2.25} />
              <span className="hidden sm:inline">Add institution</span>
              <span className="sm:hidden">Add</span>
            </Link>
          </>
        }
      />

      <div className="mx-auto max-w-6xl space-y-6 p-4 pb-28 md:space-y-8 md:p-8 md:pb-8">
        <section className="mfade mfade-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="overline">Portfolio overview</div>
            <h1 className="coffer-serif mt-2 text-3xl leading-tight text-on-surface md:text-4xl">
              OpenCoffer
            </h1>
          </div>
          <div className="coffer-glass inline-flex items-center gap-2 rounded-full px-3 py-2 body-s text-on-surface-variant">
            <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_14px_hsl(var(--md-success)/0.75)]" />
            Live data
          </div>
        </section>

        <section className="grid grid-cols-12 gap-4 md:gap-6">
          <div className="card-elevated coffer-card-hover relative col-span-12 min-h-[246px] overflow-hidden p-6 md:p-8 lg:col-span-8">
            <NetWorthBackdrop />
            <div className="relative z-10">
              <div className="body-m text-on-surface-variant">Net Worth</div>
              <div className="figure mt-2 text-[48px] leading-none text-on-surface sm:text-[64px] md:text-[88px]">
                {formatCurrency(netWorth.netWorth)}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-on-surface-variant md:mt-6">
                <Stat label="Assets" value={formatCurrency(netWorth.assets)} tone="success" />
                <Stat label="Debt" value={formatCurrency(netWorth.liabilities)} tone="error" />
                <Stat label="Accounts" value={String(accounts.length)} tone="default" />
                <Link href="/settings/connections" className="btn-text">
                  Manage <ArrowUpRight size={16} strokeWidth={2} />
                </Link>
              </div>
            </div>
          </div>

          <div className="col-span-12 lg:col-span-4">
            <div className="card-elevated coffer-card-hover h-full p-0 [&>section]:h-full [&>section]:rounded-[20px] [&>section]:border-0 [&>section]:bg-transparent [&>section]:shadow-none">
              <InsightsCard limit={2} />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-12 gap-4 md:gap-6">
          <div className="col-span-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1">
            <SavingsBreakdownCard
              rate={savingsRate}
              total={totalSaved}
              rows={savingsRows}
            />
            <MiniCard
              Icon={TrendingUp}
              tone="default"
              label="Income · 90d"
              value={formatCurrency(flow90.income)}
              sub={`spent ${formatCurrency(flow90.consumption)}, saved ${formatCurrency(totalSaved)}`}
            />
            <MiniCard
              Icon={Repeat}
              tone="default"
              label="Recurring spend (detected)"
              value={formatCurrency(monthlyRecurringTotal)}
              sub={`${recurring.length} merchants seen 2+ months`}
            />
          </div>

          <div className="card mfade mfade-2 coffer-card-hover col-span-12 lg:col-span-8">
            <div className="flex items-end justify-between">
              <div>
                <div className="overline">Consumption by month — trailing six</div>
                <h2 className="coffer-serif mt-1 text-2xl">Where it went</h2>
              </div>
              <span className="body-s text-on-surface-variant">click a bar to drill in</span>
            </div>
            <div className="mt-6">
              <SpendingDrilldown data={chartData} />
            </div>
          </div>
        </section>

        <section className="grid grid-cols-12 gap-4 md:gap-6">
          <div className="card mfade mfade-3 coffer-card-hover col-span-12 lg:col-span-4">
            <div className="overline">Top categories — 180 d</div>
            <h2 className="coffer-serif mt-1 text-2xl">Breakdown</h2>
            <ul className="mt-4">
              {top.map((c, i) => (
                <li
                  key={c.category}
                  className={`flex items-center justify-between py-3 ${i < top.length - 1 ? "border-b border-outline-variant" : ""}`}
                >
                  <span className="body-m text-on-surface">{c.category}</span>
                  <span className="title-s font-mono tabular-nums text-on-surface-variant">
                    {formatCurrency(c.total)}
                  </span>
                </li>
              ))}
              {top.length === 0 && (
                <li className="body-m py-6 text-center text-on-surface-variant">No spending data yet.</li>
              )}
            </ul>
          </div>

          <div className="card mfade mfade-3 coffer-card-hover col-span-12 lg:col-span-4">
            <div className="flex items-center gap-2">
              <Bot size={18} className="text-primary" />
              <div>
                <div className="overline">Recent activity</div>
                <h2 className="coffer-serif mt-1 text-2xl">Activity</h2>
              </div>
            </div>
            <TransactionTimeline rows={recent} />
          </div>

          <div className="card mfade mfade-3 coffer-card-hover col-span-12 lg:col-span-4">
            <div className="overline">Detected — last 12 mo</div>
            <h2 className="coffer-serif mt-1 text-2xl">Recurring</h2>
            <ul className="mt-4 divide-y divide-outline-variant">
              {recurring.slice(0, 6).map((r, i) => (
                <li key={i} className="grid grid-cols-[1fr_auto] items-center gap-4 py-3">
                  <div className="min-w-0">
                    <div className="body-m truncate text-on-surface">{r.merchant}</div>
                    <div className="body-s text-on-surface-variant">
                      {r.months} months · {r.totalCharges} charges
                      <span className="ml-2">· last {formatDate(r.lastDate)}</span>
                    </div>
                  </div>
                  <div className="title-s font-mono tabular-nums text-error">
                    −{formatCurrency(r.typicalAmount)}
                  </div>
                </li>
              ))}
              {recurring.length === 0 && (
                <li className="body-m py-6 text-center text-on-surface-variant">
                  No recurring merchants yet — needs 2+ months of history.
                </li>
              )}
            </ul>
          </div>

          <div className="card mfade mfade-4 coffer-card-hover col-span-12 lg:col-span-8">
            <div className="overline">Balances</div>
            <h2 className="coffer-serif mt-1 text-2xl">Account summary</h2>
            <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {accounts.slice(0, 8).map((a) => (
                <li key={a.id} className="rounded-2xl border border-outline-variant bg-surface-container px-4 py-3">
                  <div className="min-w-0">
                    <div className="body-m truncate text-on-surface">
                      {a.name}
                      {a.source === "manual" && <span className="badge ml-2">Manual</span>}
                      {a.mask && (
                        <span className="ml-2 font-mono text-xs text-on-surface-variant">··{a.mask}</span>
                      )}
                    </div>
                    <div className="body-s text-on-surface-variant">
                      {a.type}
                      {a.subtype ? ` · ${a.subtype}` : ""}
                    </div>
                  </div>
                  <div
                    className={`figure mt-3 text-[28px] ${a.type === "credit" || a.type === "loan" ? "text-error" : "text-on-surface"}`}
                  >
                    {formatCurrency(a.currentBalance, a.currency ?? "USD")}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <div className="flex items-center justify-between pt-2 pb-4">
          <span className="body-s text-on-surface-variant">Data: SimpleFIN + manual accounts · queried on each load</span>
          <Link href="/chat" className="btn btn-text">
            Ask the chat about any of this
            <ArrowUpRight size={16} strokeWidth={2} />
          </Link>
        </div>
      </div>
    </>
  );
}

function NetWorthBackdrop() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 h-52 w-full opacity-35"
      viewBox="0 0 100 42"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="net-worth-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--md-primary))" stopOpacity="0.58" />
          <stop offset="100%" stopColor="hsl(var(--md-primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 42 L0 24 L16 28 L32 18 L48 22 L64 11 L82 16 L100 8 L100 42 Z" fill="url(#net-worth-fill)" />
      <path d="M0 24 L16 28 L32 18 L48 22 L64 11 L82 16 L100 8" fill="none" stroke="hsl(var(--md-primary))" strokeWidth="0.7" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-2xl p-6 md:p-12">
      <div className="card-elevated mfade mfade-1 p-8 text-center md:p-12">
        <h1 className="coffer-serif text-4xl">Welcome</h1>
        <p className="body-l mt-4 text-on-surface-variant">
          Connect a bank, credit card or brokerage and the account history fills itself in. None of your
          data leaves this machine unless you connect an external model or MCP client.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/settings/connections" className="btn btn-filled">
            Connect institution
          </Link>
          <Link href="/settings/llm" className="btn btn-outlined">
            Add a model
          </Link>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "default" | "success" | "error";
}) {
  const toneClass = tone === "success" ? "text-success" : tone === "error" ? "text-error" : "text-on-surface";
  return (
    <div>
      <div className="body-s text-on-surface-variant">{label}</div>
      <div className={`title-m font-mono tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function MiniCard({
  Icon,
  label,
  value,
  sub,
  tone,
}: {
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  value: string;
  sub: string;
  tone: "default" | "error" | "success";
}) {
  const iconTone =
    tone === "error"
      ? "bg-error-container text-error"
      : tone === "success"
        ? "bg-success-container text-on-success-container"
        : "bg-secondary-container text-on-secondary-container";
  return (
    <div className="card-elevated coffer-card-hover p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="overline">{label}</div>
          <div className="figure mt-2 text-[28px]">{value}</div>
          <div className="body-s mt-2 text-on-surface-variant">{sub}</div>
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-full ${iconTone}`}>
          <Icon size={18} strokeWidth={2} />
        </div>
      </div>
    </div>
  );
}

function SavingsBreakdownCard({
  rate,
  total,
  rows,
}: {
  rate: number | null;
  total: number;
  rows: Array<{ name: string; value: number }>;
}) {
  const displayRows = rows.length > 0 ? rows.slice(0, 5) : [{ name: "No savings destinations", value: 0 }];
  const maxV = Math.max(1, ...displayRows.map((r) => Math.abs(r.value)));
  return (
    <div className="card-elevated coffer-card-hover p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="overline">Saving · 90d</div>
          <div className="figure mt-2 text-[28px]">
            {rate == null ? "—" : `${rate}%`}
          </div>
          <div className="body-s mt-1 text-on-surface-variant">
            {formatCurrency(total)} moved into savings
          </div>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success-container text-on-success-container">
          <PiggyBank size={18} strokeWidth={2} />
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {displayRows.map((r, index) => {
          const pct = total !== 0 ? Math.round((r.value / total) * 100) : 0;
          const bar = `${Math.max(2, Math.round((Math.abs(r.value) / maxV) * 100))}%`;
          const barColor = index === 0 ? "bg-primary" : index === 1 ? "bg-success" : "bg-outline";
          return (
            <li key={r.name}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="body-s text-on-surface-variant">{r.name}</span>
                <span className="body-s font-mono tabular-nums text-on-surface">
                  {formatCurrency(r.value)}
                  {total > 0 && (
                    <span className="ml-1.5 text-on-surface-variant">· {pct}%</span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-on-surface/[0.06]">
                <div className={`h-full rounded-full ${barColor}`} style={{ width: bar }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TransactionTimeline({
  rows,
}: {
  rows: Array<{
    id: string;
    date: Date | string;
    amount: number;
    name: string;
    merchant: string | null;
    category: string | null;
    pending: boolean;
    currency: string | null;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <div className="body-m mt-6 text-on-surface-variant">
        No transactions in the last 30 days.
      </div>
    );
  }
  return (
    <ol className="relative mt-5 space-y-4 border-l border-outline-variant pl-4">
      {rows.slice(0, 5).map((row, index) => {
        const isIncome = row.amount > 0;
        const dot = isIncome ? "bg-success" : index === 0 ? "bg-primary" : "bg-surface-container border border-outline-variant";
        return (
          <li key={row.id} className="relative">
            <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-surface-low ${dot}`} />
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="min-w-0">
                <div className="body-m truncate text-on-surface">{row.merchant ?? row.name}</div>
                <div className="body-s mt-0.5 truncate text-on-surface-variant">
                  {row.category ?? "Uncategorized"} · {formatDate(row.date)}
                </div>
              </div>
              <div className={`title-s font-mono tabular-nums ${isIncome ? "text-success" : "text-on-surface"}`}>
                {formatCurrency(row.amount, row.currency)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function topCategories(rows: Array<{ category: string; total: number }>, n: number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + r.total);
  return [...m.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}
