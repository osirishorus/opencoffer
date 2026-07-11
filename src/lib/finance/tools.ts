import { z } from "zod";
import { and, desc, eq, gte, lte, sql, ilike, or, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { householdUserIds } from "@/lib/household";
import {
  connections,
  financialAccounts,
  transactions,
  holdings,
  securities,
  budgets,
  netWorthSnapshots,
  alerts as alertsTable,
  aiInsights,
  assistantMemories,
} from "@/lib/db/schema";
import {
  INCOME_CATEGORIES,
  SAVINGS_CATEGORIES,
  TRANSFER_CATEGORY,
  buildSavingsDestinationSlices,
  dateWindowLabel,
  describeExclusions,
  exclusionsForSpendingKind,
  labelForSpendingKind,
  type ChartFreshness,
  type ChartSpec,
  type SpendingKind,
} from "@/lib/finance/display";
import { categorizeUncategorized, recategorizeAll } from "@/lib/finance/categorize";
import { listRealAssetsForUser } from "@/lib/real-assets/data";

const ACCOUNT_GROUPS = ["cash", "credit", "retirement", "brokerage", "hsa", "loan", "other"] as const;
type AccountGroup = (typeof ACCOUNT_GROUPS)[number];
/** Effective group = user override (if set) > system-assigned. */
function effectiveGroup(a: { accountGroup: string; userAccountGroup: string | null }): string {
  return a.userAccountGroup ?? a.accountGroup;
}

const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toIsoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function effectiveCategorySQL() {
  return sql<string>`coalesce(${transactions.overrideCategory}, ${transactions.aiCategory}, ${transactions.category}, 'Uncategorized')`;
}

function effectiveIsTransferSQL() {
  return sql<boolean>`coalesce(${transactions.overrideIsTransfer}, ${transactions.isTransfer}, false)`;
}

/**
 * SQL fragment that classifies every transaction into a high-level kind:
 *
 *   consumption — actual living-expense spending (food, rent, subs, bills, …)
 *   savings     — money you moved into wealth (401k, brokerage, HSA, taxable invest)
 *   income      — payroll, dividends, refunds, Zelle-from-someone
 *   transfer    — internal moves (CC payments, account-to-account)
 *
 * Used to keep "spending" answers from being polluted by retirement
 * contributions and other non-consumption outflows.
 */
// Static lists inlined into SQL — they're hard-coded category names, not
// user input, so a string concat is safe and simpler than parameterizing.
export function outflowKindSQL() {
  return sql<string>`(
    case
      when ${effectiveIsTransferSQL()} = true
        or ${effectiveCategorySQL()} = ${TRANSFER_CATEGORY}
        then 'transfer'
      when ${effectiveCategorySQL()} in (${sql.join(SAVINGS_CATEGORIES.map((c) => sql`${c}`), sql`, `)})
        then 'savings'
      when ${effectiveCategorySQL()} in (${sql.join(INCOME_CATEGORIES.map((c) => sql`${c}`), sql`, `)})
        then 'income'
      else 'consumption'
    end
  )`;
}

/** Categorical filter used by spending tools.
 *  Default "consumption" → only real living-expense outflows. */
export function spendKindWhere(kind: SpendingKind) {
  if (kind === "consumption") {
    return sql`${outflowKindSQL()} = 'consumption'`;
  }
  if (kind === "savings") {
    return sql`${outflowKindSQL()} = 'savings'`;
  }
  // "all" — include consumption + savings + transfer-internals; still exclude income
  return sql`${outflowKindSQL()} <> 'income'`;
}

async function chartFreshness(
  userId: string,
  opts: { days?: number; kind?: SpendingKind; exclusions?: string[] } = {},
): Promise<ChartFreshness> {
  const ids = await householdUserIds(userId);
  const [syncRow, categoryRow] = await Promise.all([
    db
      .select({
        lastSyncedAt: sql<Date | null>`max(${connections.lastSyncedAt})`,
      })
      .from(connections)
      .where(inArray(connections.userId, ids)),
    db
      .select({
        total: sql<number>`count(*)::int`,
        classified: sql<number>`count(*) filter (where ${transactions.aiClassifiedAt} is not null)::int`,
        manualOverrides: sql<number>`count(*) filter (where ${transactions.overrideCategory} is not null)::int`,
        remaining: sql<number>`count(*) filter (where ${transactions.aiClassifiedAt} is null and ${transactions.overrideCategory} is null)::int`,
      })
      .from(transactions)
      .where(inArray(transactions.userId, ids)),
  ]);

  return {
    lastSyncedAt: toIsoDate(syncRow[0]?.lastSyncedAt),
    categoryStatus: {
      total: categoryRow[0]?.total ?? 0,
      classified: categoryRow[0]?.classified ?? 0,
      manualOverrides: categoryRow[0]?.manualOverrides ?? 0,
      remaining: categoryRow[0]?.remaining ?? 0,
    },
    dateWindow: opts.days ? dateWindowLabel(opts.days) : undefined,
    exclusions: opts.exclusions ?? (opts.kind ? exclusionsForSpendingKind(opts.kind) : undefined),
  };
}

export type FinanceTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: TSchema;
  execute: (args: z.infer<TSchema>, ctx: { userId: string }) => Promise<unknown>;
};

const getAccounts: FinanceTool = {
  name: "get_accounts",
  description:
    "List the user's financial accounts with balances, including SimpleFIN-synced and manual accounts. Each account has `source`, `type` (depository/credit/investment/loan) and `group` (cash/credit/retirement/brokerage/hsa/loan/other). Use `group` for analysis — e.g. 'cash' = spendable checking+savings, 'retirement' = 401k/IRA/HSA-like, 'brokerage' = taxable investments.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const rows = await db
      .select()
      .from(financialAccounts)
      .where(inArray(financialAccounts.userId, ids));
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      officialName: a.officialName,
      mask: a.mask,
      source: a.source,
      type: a.type,
      subtype: a.subtype,
      group: effectiveGroup(a),
      systemGroup: a.accountGroup,
      userGroupOverride: a.userAccountGroup,
      currentBalance: num(a.currentBalance),
      availableBalance: num(a.availableBalance),
      currency: a.isoCurrencyCode,
    }));
  },
};

const getRecentTransactions: FinanceTool = {
  name: "get_recent_transactions",
  description:
    "Return recent transactions for the user, optionally filtered by account, category, or a day window. Pass null for accountId/category to skip filter. Use days=30, limit=200 as sensible defaults.",
  schema: z
    .object({
      days: z.number().int().min(1).max(365),
      accountId: z.string().uuid().nullable(),
      category: z.string().nullable(),
      limit: z.number().int().min(1).max(500),
    })
    .strict(),
  execute: async ({ days, accountId, category, limit }, { userId }) => {
    const ids = await householdUserIds(userId);
    const conds = [inArray(transactions.userId, ids), gte(transactions.date, daysAgo(days))];
    if (accountId) conds.push(eq(transactions.accountId, accountId));
    if (category) {
      // Match against the same visible category precedence used in charts,
      // plus raw subcategory text for narrower merchant-style queries.
      conds.push(
        sql`(${effectiveCategorySQL()} ilike ${`%${category}%`}
             or coalesce(${transactions.category},'') ilike ${`%${category}%`}
             or coalesce(${transactions.overrideSubcategory},'') ilike ${`%${category}%`}
             or coalesce(${transactions.aiSubcategory},'') ilike ${`%${category}%`})`,
      );
    }
    const rows = await db
      .select({ t: transactions, accountName: financialAccounts.name })
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(and(...conds))
      .orderBy(desc(transactions.date))
      .limit(limit);
    return rows.map(({ t, accountName }) => ({
      id: t.id,
      date: t.date,
      amount: num(t.amount),
      name: t.name,
      merchant: t.overrideMerchant ?? t.merchantName,
      account: accountName,
      accountId: t.accountId,
      category: t.overrideCategory ?? t.aiCategory ?? t.category,
      subcategory: t.overrideSubcategory ?? t.aiSubcategory ?? t.subcategory,
      isTransfer: t.overrideIsTransfer ?? t.isTransfer,
      isRecurring: t.isRecurring,
      cadence: t.recurrenceCadence,
      notes: t.userNotes,
      pending: t.pending,
      currency: t.isoCurrencyCode,
    }));
  },
};

const searchTransactions: FinanceTool = {
  name: "search_transactions",
  description:
    "Full-text search over transactions by merchant or description, with optional date (YYYY-MM-DD) and amount filters. Pass null to skip a filter. Use limit=100 as a sensible default.",
  schema: z
    .object({
      query: z.string().min(1),
      from: z.string().nullable(),
      to: z.string().nullable(),
      minAmount: z.number().nullable(),
      maxAmount: z.number().nullable(),
      limit: z.number().int().min(1).max(500),
    })
    .strict(),
  execute: async ({ query, from, to, minAmount, maxAmount, limit }, { userId }) => {
    const ids = await householdUserIds(userId);
    const conds = [
      inArray(transactions.userId, ids),
      or(ilike(transactions.name, `%${query}%`), ilike(transactions.merchantName, `%${query}%`))!,
    ];
    if (from) conds.push(gte(transactions.date, new Date(from)));
    if (to) conds.push(lte(transactions.date, new Date(to)));
    if (minAmount != null) conds.push(gte(transactions.amount, String(minAmount)));
    if (maxAmount != null) conds.push(lte(transactions.amount, String(maxAmount)));
    const rows = await db
      .select({ t: transactions, accountName: financialAccounts.name })
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(and(...conds))
      .orderBy(desc(transactions.date))
      .limit(limit);
    return rows.map(({ t, accountName }) => ({
      id: t.id,
      date: t.date,
      amount: num(t.amount),
      name: t.name,
      merchant: t.merchantName,
      account: accountName,
      accountId: t.accountId,
      category: t.category,
    }));
  },
};

const getSpendingByCategory: FinanceTool = {
  name: "get_spending_by_category",
  description:
    "Aggregate spending (outflows) by category. Defaults to CONSUMPTION only — real living expenses, excluding savings/investments/retirement contributions. Pass kind='savings' for 401k/brokerage deposits, kind='all' to include everything except income. Totals returned as positive numbers. groupBy: month | week | total.",
  schema: z
    .object({
      days: z.number().int().min(1).max(730),
      groupBy: z.enum(["total", "month", "week"]),
      kind: z.enum(["consumption", "savings", "all"]),
    })
    .strict(),
  execute: async ({ days, groupBy, kind }, { userId }) => {
    const ids = await householdUserIds(userId);
    // SimpleFIN convention: negative amount = outflow. Negate for friendly totals.
    const baseWhere = and(
      inArray(transactions.userId, ids),
      gte(transactions.date, daysAgo(days)),
      sql`${transactions.amount} < 0`,
      eq(transactions.pending, false),
      spendKindWhere(kind),
    );
    const effectiveCategory = effectiveCategorySQL();
    if (groupBy === "total") {
      const rows = await db
        .select({
          category: effectiveCategory,
          total: sql<string>`(-1 * sum(${transactions.amount}))::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(transactions)
        .where(baseWhere)
        .groupBy(effectiveCategory)
        .orderBy(sql`sum(${transactions.amount}) asc`);
      return rows.map((r) => ({
        period: "total",
        category: r.category,
        total: num(r.total),
        count: r.count,
      }));
    }
    const period =
      groupBy === "month"
        ? sql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM')`
        : sql<string>`to_char(date_trunc('week', ${transactions.date}), 'IYYY-IW')`;
    const rows = await db
      .select({
        period,
        category: effectiveCategory,
        total: sql<string>`(-1 * sum(${transactions.amount}))::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(transactions)
      .where(baseWhere)
      .groupBy(period, effectiveCategory)
      .orderBy(period, sql`sum(${transactions.amount}) asc`);
    return rows.map((r) => ({
      period: r.period,
      category: r.category,
      total: num(r.total),
      count: r.count,
    }));
  },
};

const getHoldings: FinanceTool = {
  name: "get_holdings",
  description: "Return investment holdings with current institution value and cost basis.",
  schema: z.object({ accountId: z.string().uuid().nullable() }).strict(),
  execute: async ({ accountId }, { userId }) => {
    const ids = await householdUserIds(userId);
    const conds = [inArray(holdings.userId, ids)];
    if (accountId) conds.push(eq(holdings.accountId, accountId));
    const rows = await db
      .select({
        accountId: holdings.accountId,
        quantity: holdings.quantity,
        costBasis: holdings.costBasis,
        institutionPrice: holdings.institutionPrice,
        institutionValue: holdings.institutionValue,
        ticker: securities.tickerSymbol,
        secName: securities.name,
        secType: securities.type,
      })
      .from(holdings)
      .leftJoin(securities, eq(securities.id, holdings.securityId))
      .where(and(...conds));
    return rows.map((h) => ({
      accountId: h.accountId,
      ticker: h.ticker,
      name: h.secName,
      type: h.secType,
      quantity: num(h.quantity),
      costBasis: num(h.costBasis),
      price: num(h.institutionPrice),
      value: num(h.institutionValue),
    }));
  },
};

const getRecurringMerchants: FinanceTool = {
  name: "get_recurring_merchants",
  description:
    "Heuristically detect recurring outflow merchants (subscriptions, rent, utilities) by finding merchants that appear in 2+ different months with similar amounts. Useful for 'what are my subscriptions'.",
  schema: z.object({ days: z.number().int().min(30).max(730) }).strict(),
  execute: async ({ days }, { userId }) => {
    const ids = await householdUserIds(userId);
    // Find merchants where at least 2 distinct months have a charge, and the
    // most-common amount accounts for >=50% of all charges.
    const rows = await db
      .select({
        merchant: transactions.merchantName,
        name: transactions.name,
        month: sql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM')`,
        amount: transactions.amount,
        date: transactions.date,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, daysAgo(days)),
          sql`${transactions.amount} < 0`,
          eq(transactions.pending, false),
          spendKindWhere("consumption"),
        ),
      );

    type Bucket = { months: Set<string>; amounts: number[]; lastDate: Date; sample: string };
    const byMerchant = new Map<string, Bucket>();
    for (const r of rows) {
      const key = (r.merchant ?? r.name).toLowerCase().trim();
      if (!key) continue;
      const b =
        byMerchant.get(key) ??
        { months: new Set<string>(), amounts: [], lastDate: r.date, sample: r.merchant ?? r.name };
      b.months.add(r.month);
      b.amounts.push(Math.abs(Number(r.amount)));
      if (r.date > b.lastDate) b.lastDate = r.date;
      byMerchant.set(key, b);
    }

    const results: Array<{
      merchant: string;
      months: number;
      typicalAmount: number;
      lastDate: Date;
      totalCharges: number;
    }> = [];
    for (const b of byMerchant.values()) {
      if (b.months.size < 2) continue;
      // Median
      const sorted = [...b.amounts].sort((a, c) => a - c);
      const med = sorted[Math.floor(sorted.length / 2)];
      results.push({
        merchant: b.sample,
        months: b.months.size,
        typicalAmount: Math.round(med * 100) / 100,
        lastDate: b.lastDate,
        totalCharges: b.amounts.length,
      });
    }
    return results.sort((a, c) => c.months - a.months || c.totalCharges - a.totalCharges);
  },
};

const getNetWorth: FinanceTool = {
  name: "get_net_worth",
  description:
    "Compute net worth by summing depository + investment account balances plus real assets, then subtracting credit + loan balances.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const [rows, realAssetRows] = await Promise.all([
      db
        .select()
        .from(financialAccounts)
        .where(inArray(financialAccounts.userId, ids)),
      listRealAssetsForUser(userId),
    ]);
    const assetsTypes = new Set(["depository", "investment"]);
    const liabilityTypes = new Set(["credit", "loan"]);
    let assets = 0;
    let liabilities = 0;
    for (const a of rows) {
      const bal = num(a.currentBalance);
      if (assetsTypes.has(a.type)) assets += bal;
      // Credit/loan balances are stored as negative numbers (you owe them).
      // Convert to positive "amount owed" for the user-facing liabilities figure.
      else if (liabilityTypes.has(a.type)) liabilities += Math.abs(bal);
    }
    for (const asset of realAssetRows) {
      if (asset.status === "active" && asset.currentValue) assets += asset.currentValue.value;
    }
    return {
      assets,
      liabilities,
      netWorth: assets - liabilities,
      accountCount: rows.length,
      realAssetCount: realAssetRows.filter((asset) => asset.status === "active" && asset.currentValue).length,
      asOf: new Date(),
    };
  },
};

const getTopMerchants: FinanceTool = {
  name: "get_top_merchants",
  description:
    "Top merchants by total spent (or received). direction='outflow' = consumption spending (retirement/investments excluded by default). direction='inflow' = real income. Pass kind='all' to include savings/transfers on the outflow side.",
  schema: z
    .object({
      days: z.number().int().min(1).max(730),
      direction: z.enum(["outflow", "inflow"]),
      limit: z.number().int().min(1).max(100),
      kind: z.enum(["consumption", "savings", "all"]),
    })
    .strict(),
  execute: async ({ days, direction, limit, kind }, { userId }) => {
    const ids = await householdUserIds(userId);
    const signCond =
      direction === "outflow"
        ? sql`${transactions.amount} < 0`
        : sql`${transactions.amount} > 0`;
    const kindCond = direction === "outflow" ? spendKindWhere(kind) : sql`true`;
    const rows = await db
      .select({
        merchant: sql<string>`coalesce(${transactions.merchantName}, ${transactions.name})`,
        count: sql<number>`count(*)::int`,
        total: sql<string>`(abs(sum(${transactions.amount})))::text`,
        avg: sql<string>`(abs(avg(${transactions.amount})))::text`,
        firstDate: sql<Date>`min(${transactions.date})`,
        lastDate: sql<Date>`max(${transactions.date})`,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, daysAgo(days)),
          signCond,
          eq(transactions.pending, false),
          kindCond,
        ),
      )
      .groupBy(sql`coalesce(${transactions.merchantName}, ${transactions.name})`)
      .orderBy(sql`abs(sum(${transactions.amount})) desc`)
      .limit(limit);
    return rows.map((r) => ({
      merchant: r.merchant,
      transactions: r.count,
      total: num(r.total),
      average: num(r.avg),
      firstDate: r.firstDate,
      lastDate: r.lastDate,
    }));
  },
};

const getLargestTransactions: FinanceTool = {
  name: "get_largest_transactions",
  description:
    "The N largest individual transactions in a window, signed (negative = outflow). Useful for 'what was my biggest expense this month'.",
  schema: z
    .object({
      days: z.number().int().min(1).max(730),
      direction: z.enum(["outflow", "inflow", "both"]),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  execute: async ({ days, direction, limit }, { userId }) => {
    const ids = await householdUserIds(userId);
    const conds = [
      inArray(transactions.userId, ids),
      gte(transactions.date, daysAgo(days)),
      eq(transactions.pending, false),
          eq(transactions.isTransfer, false),
    ];
    if (direction === "outflow") conds.push(sql`${transactions.amount} < 0`);
    if (direction === "inflow") conds.push(sql`${transactions.amount} > 0`);
    const rows = await db
      .select({ t: transactions, accountName: financialAccounts.name })
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(and(...conds))
      .orderBy(sql`abs(${transactions.amount}) desc`)
      .limit(limit);
    return rows.map(({ t, accountName }) => ({
      date: t.date,
      amount: num(t.amount),
      name: t.name,
      merchant: t.merchantName,
      account: accountName,
      category: t.category,
    }));
  },
};

const getCashFlow: FinanceTool = {
  name: "get_cash_flow",
  description:
    "Period-by-period inflows, outflows, and net cash flow. Useful for 'am I saving money', 'how much do I bring in vs spend per month'. groupBy: week | month.",
  schema: z
    .object({
      days: z.number().int().min(7).max(730),
      groupBy: z.enum(["week", "month"]),
    })
    .strict(),
  execute: async ({ days, groupBy }, { userId }) => {
    const ids = await householdUserIds(userId);
    const period =
      groupBy === "month"
        ? sql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM')`
        : sql<string>`to_char(date_trunc('week', ${transactions.date}), 'IYYY-IW')`;
    const rows = await db
      .select({
        period,
        inflow: sql<string>`coalesce(sum(case when ${transactions.amount} > 0 then ${transactions.amount} end), 0)::text`,
        outflow: sql<string>`coalesce(abs(sum(case when ${transactions.amount} < 0 then ${transactions.amount} end)), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, daysAgo(days)),
          eq(transactions.pending, false),
          eq(transactions.isTransfer, false),
        ),
      )
      .groupBy(period)
      .orderBy(period);
    return rows.map((r) => {
      const inflow = num(r.inflow);
      const outflow = num(r.outflow);
      return {
        period: r.period,
        inflow,
        outflow,
        net: inflow - outflow,
        transactions: r.count,
      };
    });
  },
};

const comparePeriods: FinanceTool = {
  name: "compare_periods",
  description:
    "Compare spending between two date windows (e.g. this month vs last). Returns category-level deltas. Each period is specified as 'days back' window — periodA is the older window, periodB is the newer.",
  schema: z
    .object({
      periodADaysAgo: z.number().int().min(7).max(730),
      periodBDaysAgo: z.number().int().min(0).max(730),
      windowDays: z.number().int().min(1).max(180),
    })
    .strict(),
  execute: async ({ periodADaysAgo, periodBDaysAgo, windowDays }, { userId }) => {
    const ids = await householdUserIds(userId);
    async function bucket(daysBack: number) {
      const end = new Date(Date.now() - daysBack * 86400_000);
      const start = new Date(end.getTime() - windowDays * 86400_000);
      const effectiveCategory = effectiveCategorySQL();
      const rows = await db
        .select({
          category: effectiveCategory,
          total: sql<string>`abs(sum(${transactions.amount}))::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(transactions)
        .where(
          and(
            inArray(transactions.userId, ids),
            gte(transactions.date, start),
            lte(transactions.date, end),
            sql`${transactions.amount} < 0`,
            eq(transactions.pending, false),
            spendKindWhere("consumption"),
          ),
        )
        .groupBy(effectiveCategory);
      return { start, end, rows };
    }
    const a = await bucket(periodADaysAgo);
    const b = await bucket(periodBDaysAgo);
    const byCat = new Map<string, { a: number; b: number; aCount: number; bCount: number }>();
    for (const r of a.rows) {
      const k = r.category ?? "Uncategorized";
      byCat.set(k, { a: num(r.total), b: 0, aCount: r.count, bCount: 0 });
    }
    for (const r of b.rows) {
      const k = r.category ?? "Uncategorized";
      const e = byCat.get(k) ?? { a: 0, b: 0, aCount: 0, bCount: 0 };
      e.b = num(r.total);
      e.bCount = r.count;
      byCat.set(k, e);
    }
    const breakdown = [...byCat.entries()]
      .map(([category, v]) => ({
        category,
        periodA: v.a,
        periodB: v.b,
        delta: v.b - v.a,
        pctChange: v.a > 0 ? Math.round(((v.b - v.a) / v.a) * 1000) / 10 : null,
      }))
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    const totalA = breakdown.reduce((s, r) => s + r.periodA, 0);
    const totalB = breakdown.reduce((s, r) => s + r.periodB, 0);
    return {
      periodA: { window: [a.start, a.end], total: totalA },
      periodB: { window: [b.start, b.end], total: totalB },
      totalDelta: totalB - totalA,
      breakdown,
    };
  },
};

const getPortfolioSummary: FinanceTool = {
  name: "get_portfolio_summary",
  description:
    "Aggregate investment-account holdings. Returns total invested value, breakdown by account, and (if holdings are populated) top positions across all accounts. Useful for 'what's my portfolio worth' / 'biggest holdings'.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const accts = await db
      .select()
      .from(financialAccounts)
      .where(and(inArray(financialAccounts.userId, ids), eq(financialAccounts.type, "investment")));

    const positions = await db
      .select({
        ticker: securities.tickerSymbol,
        name: securities.name,
        quantity: holdings.quantity,
        value: holdings.institutionValue,
        costBasis: holdings.costBasis,
        accountId: holdings.accountId,
      })
      .from(holdings)
      .leftJoin(securities, eq(securities.id, holdings.securityId))
      .where(inArray(holdings.userId, ids));

    const byAccount = accts.map((a) => ({
      account: a.name,
      type: a.subtype ?? a.type,
      balance: num(a.currentBalance),
      currency: a.isoCurrencyCode,
    }));
    const totalValue = accts.reduce((s, a) => s + num(a.currentBalance), 0);

    // Aggregate same ticker across accounts.
    const byTicker = new Map<string, { ticker: string; name: string | null; quantity: number; value: number; costBasis: number }>();
    for (const p of positions) {
      const k = p.ticker ?? p.name ?? "Unknown";
      const e =
        byTicker.get(k) ?? { ticker: p.ticker ?? "—", name: p.name, quantity: 0, value: 0, costBasis: 0 };
      e.quantity += num(p.quantity);
      e.value += num(p.value);
      e.costBasis += num(p.costBasis);
      byTicker.set(k, e);
    }
    const topPositions = [...byTicker.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, 20)
      .map((p) => ({
        ticker: p.ticker,
        name: p.name,
        quantity: p.quantity,
        value: p.value,
        costBasis: p.costBasis,
        unrealizedGain: p.costBasis > 0 ? p.value - p.costBasis : null,
      }));

    return {
      totalValue,
      accountCount: accts.length,
      positionsCount: positions.length,
      byAccount,
      topPositions,
    };
  },
};

const getConsumptionVsSavings: FinanceTool = {
  name: "get_consumption_vs_savings",
  description:
    "Break down outflows into consumption (real spending) vs savings/investing (retirement, brokerage, HSA contributions) per period. Also surfaces income for context. Returns the savings rate (savings / income). Useful for 'am I saving enough' and 'how much of my paycheck am I keeping'.",
  schema: z
    .object({
      days: z.number().int().min(7).max(730),
      groupBy: z.enum(["week", "month", "total"]),
    })
    .strict(),
  execute: async ({ days, groupBy }, { userId }) => {
    const ids = await householdUserIds(userId);
    const periodExpr =
      groupBy === "month"
        ? sql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM')`
        : groupBy === "week"
          ? sql<string>`to_char(date_trunc('week', ${transactions.date}), 'IYYY-IW')`
          : sql<string>`'total'`;

    const kind = outflowKindSQL();
    const selection = {
      period: periodExpr,
      consumption: sql<string>`coalesce(abs(sum(case when ${transactions.amount} < 0 and ${kind} = 'consumption' then ${transactions.amount} else 0 end)), 0)::text`,
      savings: sql<string>`coalesce(abs(sum(case when ${transactions.amount} < 0 and ${kind} = 'savings' then ${transactions.amount} else 0 end)), 0)::text`,
      income: sql<string>`coalesce(sum(case when ${transactions.amount} > 0 and ${kind} = 'income' then ${transactions.amount} else 0 end), 0)::text`,
    };
    const baseQuery = db
      .select({
        ...selection,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, daysAgo(days)),
          eq(transactions.pending, false),
        ),
      );

    const rows =
      groupBy === "total"
        ? await baseQuery
        : await baseQuery.groupBy(periodExpr).orderBy(periodExpr);

    return rows
      .map((r) => {
        const consumption = num(r.consumption);
        const savings = num(r.savings);
        const income = num(r.income);
        return {
          period: r.period ?? "total",
          consumption,
          savings,
          income,
          net: income - consumption - savings,
          savingsRate:
            income > 0 ? Math.round((savings / income) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => a.period.localeCompare(b.period));
  },
};

const chartConsumptionVsSavings: FinanceTool = {
  name: "chart_consumption_vs_savings",
  description:
    "Stacked-style bar chart of consumption vs savings per period. Use for 'show me how I'm saving over time' / 'am I living within my means'.",
  schema: z
    .object({
      days: z.number().int().min(14).max(730),
      groupBy: z.enum(["week", "month"]),
    })
    .strict(),
  execute: async ({ days, groupBy }, { userId }) => {
    const r = (await getConsumptionVsSavings.execute({ days, groupBy }, { userId })) as Array<{
      period: string;
      consumption: number;
      savings: number;
      income: number;
    }>;
    return chartResult(
      { data: r },
      {
        type: "bar",
        title: `Consumption vs savings per ${groupBy}`,
        subtitle: dateWindowLabel(days),
        description: "Compares living expenses with retirement and investment outflows.",
        footnote: "Savings rate is computed from deterministic cash-flow categories.",
        freshness: await chartFreshness(userId, { days, exclusions: ["transfers"] }),
        seriesLabels: {
          consumption: "Consumption",
          savings: "Savings",
        },
        emptyReason: `No outflow history in ${dateWindowLabel(days).toLowerCase()}.`,
        data: r,
        xKey: "period",
        yKey: "consumption",
        yKey2: "savings",
        format: "currency",
      },
    );
  },
};

/* ------------------------------ chart tools ------------------------------ */

function chartResult<T extends object>(payload: T, chart: ChartSpec) {
  return { ...payload, _chart: chart };
}

const chartSpendingTrend: FinanceTool = {
  name: "chart_spending_trend",
  description:
    "Render a chart of consumption (real spending) per period — defaults to consumption only, EXCLUDING retirement contributions and brokerage deposits. Pass kind='all' to include savings outflows, kind='savings' for just savings. groupBy: week | month.",
  schema: z
    .object({
      days: z.number().int().min(14).max(730),
      groupBy: z.enum(["week", "month"]),
      kind: z.enum(["consumption", "savings", "all"]),
    })
    .strict(),
  execute: async ({ days, groupBy, kind }, { userId }) => {
    const ids = await householdUserIds(userId);
    const period =
      groupBy === "month"
        ? sql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM')`
        : sql<string>`to_char(date_trunc('week', ${transactions.date}), 'IYYY-IW')`;
    const rows = await db
      .select({
        period,
        total: sql<string>`(-1 * sum(${transactions.amount}))::text`,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, daysAgo(days)),
          sql`${transactions.amount} < 0`,
          eq(transactions.pending, false),
          spendKindWhere(kind),
        ),
      )
      .groupBy(period)
      .orderBy(period);
    const data = rows.map((r) => ({ period: r.period, spent: num(r.total) }));
    const label = labelForSpendingKind(kind);
    return chartResult(
      { data },
      {
        type: "bar",
        title: `${label} per ${groupBy}`,
        subtitle: dateWindowLabel(days),
        description: describeExclusions(kind),
        freshness: await chartFreshness(userId, { days, kind }),
        seriesLabels: { spent: label },
        emptyReason: `No ${label.toLowerCase()} transactions in ${dateWindowLabel(days).toLowerCase()} after applying the exclusions.`,
        data,
        xKey: "period",
        yKey: "spent",
        format: "currency",
      },
    );
  },
};

const chartCategoryBreakdown: FinanceTool = {
  name: "chart_category_breakdown",
  description:
    "Pie chart of CONSUMPTION spending by category (real living expenses) — retirement contributions and investment deposits are excluded. Pass kind='savings' for the savings/investing pie, or kind='all' to see everything that left the user's accounts.",
  schema: z
    .object({
      days: z.number().int().min(7).max(730),
      kind: z.enum(["consumption", "savings", "all"]),
    })
    .strict(),
  execute: async ({ days, kind }, { userId }) => {
    const ids = await householdUserIds(userId);
    const effectiveCategory = effectiveCategorySQL();
    const rows = await db
      .select({
        category: effectiveCategory,
        total: sql<string>`(-1 * sum(${transactions.amount}))::text`,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, daysAgo(days)),
          sql`${transactions.amount} < 0`,
          eq(transactions.pending, false),
          spendKindWhere(kind),
        ),
      )
      .groupBy(effectiveCategory)
      .orderBy(sql`sum(${transactions.amount}) asc`);
    const data = rows
      .map((r) => ({ name: r.category, value: num(r.total) }))
      .filter((r) => r.value > 0);
    return chartResult(
      { data },
      {
        type: "pie",
        title: `${labelForSpendingKind(kind)} by category`,
        subtitle: dateWindowLabel(days),
        description: describeExclusions(kind),
        freshness: await chartFreshness(userId, { days, kind }),
        emptyReason: `No ${labelForSpendingKind(kind).toLowerCase()} categories in ${dateWindowLabel(days).toLowerCase()} after applying the exclusions.`,
        collapseSmallSlices: true,
        data,
        format: "currency",
      },
    );
  },
};

const chartSavingsDestinations: FinanceTool = {
  name: "chart_savings_destinations",
  description:
    "Pie chart of where saved money went over a window: cash retained from income plus savings/investing outflows grouped by destination account group. Better than category breakdown for 'where does my savings go'.",
  schema: z.object({ days: z.number().int().min(14).max(730) }).strict(),
  execute: async ({ days }, { userId }) => {
    const ids = await householdUserIds(userId);
    const flow = (await getConsumptionVsSavings.execute({ days, groupBy: "total" }, { userId })) as Array<{
      income: number;
      consumption: number;
      savings: number;
    }>;
    const totals = flow[0] ?? { income: 0, consumption: 0, savings: 0 };
    const rows = await db
      .select({
        accountGroup: financialAccounts.accountGroup,
        userAccountGroup: financialAccounts.userAccountGroup,
        total: sql<string>`(-1 * sum(${transactions.amount}))::text`,
      })
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, daysAgo(days)),
          sql`${transactions.amount} < 0`,
          eq(transactions.pending, false),
          spendKindWhere("savings"),
        ),
      )
      .groupBy(financialAccounts.accountGroup, financialAccounts.userAccountGroup)
      .orderBy(sql`sum(${transactions.amount}) asc`);
    const data = buildSavingsDestinationSlices({
      income: totals.income,
      consumption: totals.consumption,
      savingsOutflows: rows.map((row) => ({
        accountGroup: row.accountGroup,
        userAccountGroup: row.userAccountGroup,
        value: num(row.total),
      })),
    });
    return chartResult(
      { data },
      {
        type: "pie",
        title: "Savings destinations",
        subtitle: dateWindowLabel(days),
        description: "Cash retained plus retirement, brokerage, HSA, and other savings outflows.",
        freshness: await chartFreshness(userId, {
          days,
          exclusions: ["transfers", "income used for expenses"],
        }),
        emptyReason: `No retained cash or savings outflows found in ${dateWindowLabel(days).toLowerCase()}.`,
        collapseSmallSlices: true,
        data,
        format: "currency",
      },
    );
  },
};

const chartCashFlow: FinanceTool = {
  name: "chart_cash_flow",
  description:
    "Render a paired bar chart of inflow vs outflow per period. Use for 'income vs expenses over time'.",
  schema: z
    .object({
      days: z.number().int().min(14).max(730),
      groupBy: z.enum(["week", "month"]),
    })
    .strict(),
  execute: async ({ days, groupBy }, { userId }) => {
    const flow = (await findTool("get_cash_flow")!.execute({ days, groupBy }, { userId })) as Array<{
      period: string;
      inflow: number;
      outflow: number;
      net: number;
    }>;
    return chartResult(
      { data: flow },
      {
        type: "bar",
        title: `Cash flow per ${groupBy}`,
        subtitle: dateWindowLabel(days),
        description: "Income compared with non-transfer outflows.",
        freshness: await chartFreshness(userId, { days, exclusions: ["transfers"] }),
        seriesLabels: { inflow: "Income", outflow: "Outflow" },
        emptyReason: `No income or outflow transactions in ${dateWindowLabel(days).toLowerCase()} after excluding transfers.`,
        data: flow,
        xKey: "period",
        yKey: "inflow",
        yKey2: "outflow",
        format: "currency",
      },
    );
  },
};

const chartRecurringMerchants: FinanceTool = {
  name: "chart_recurring_merchants",
  description:
    "Render a bar chart of detected recurring consumption merchants by typical charge. Use for 'recurring spend', 'subscriptions chart', or 'what repeats each month'.",
  schema: z
    .object({
      days: z.number().int().min(30).max(730),
      limit: z.number().int().min(3).max(12),
    })
    .strict(),
  execute: async ({ days, limit }, { userId }) => {
    const recurring = (await getRecurringMerchants.execute({ days }, { userId })) as Array<{
      merchant: string;
      months: number;
      typicalAmount: number;
    }>;
    const data = recurring
      .sort((a, b) => b.typicalAmount - a.typicalAmount)
      .slice(0, limit)
      .map((row) => ({
        merchant: row.merchant.length > 22 ? `${row.merchant.slice(0, 19)}...` : row.merchant,
        typicalAmount: row.typicalAmount,
        months: row.months,
      }));
    return chartResult(
      { data },
      {
        type: "bar",
        title: "Recurring spend",
        subtitle: dateWindowLabel(days),
        description: "Detected merchants with similar consumption charges across multiple months.",
        freshness: await chartFreshness(userId, { days, kind: "consumption" }),
        seriesLabels: { typicalAmount: "Typical charge" },
        emptyReason: `No recurring consumption merchants found in ${dateWindowLabel(days).toLowerCase()}. This needs at least two months of similar charges.`,
        data,
        xKey: "merchant",
        yKey: "typicalAmount",
        format: "currency",
      },
    );
  },
};

const chartTopMerchants: FinanceTool = {
  name: "chart_top_merchants",
  description:
    "Bar chart of top merchants by consumption spending over a window. Use for 'top merchants', 'where am I spending most', or merchant-level graphs.",
  schema: z.object({ days: z.number().int().min(7).max(730), limit: z.number().int().min(3).max(15) }).strict(),
  execute: async ({ days, limit }, { userId }) => {
    const rows = (await getTopMerchants.execute(
      { days, direction: "outflow", limit, kind: "consumption" },
      { userId },
    )) as Array<{ merchant: string; total: number }>;
    const data = rows.map((row) => ({
      merchant: row.merchant.length > 24 ? `${row.merchant.slice(0, 21)}...` : row.merchant,
      total: row.total,
    }));
    return chartResult(
      { data },
      {
        type: "bar",
        title: "Top merchants",
        subtitle: dateWindowLabel(days),
        description: describeExclusions("consumption"),
        freshness: await chartFreshness(userId, { days, kind: "consumption" }),
        seriesLabels: { total: "Spent" },
        emptyReason: `No merchant spending found in ${dateWindowLabel(days).toLowerCase()} after applying the exclusions.`,
        data,
        xKey: "merchant",
        yKey: "total",
        format: "currency",
      },
    );
  },
};

const chartBudgetStatus: FinanceTool = {
  name: "chart_budget_status",
  description:
    "Bar chart of this month's budget progress by category. Use for 'budget chart', 'what budgets are near/over', or category budget status.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const rows = (await checkBudgetStatus.execute({}, { userId })) as Array<{
      category: string;
      budget: number;
      spent: number;
      pct: number | null;
      status: string;
    }>;
    const data = rows
      .map((row) => ({
        category: row.category,
        spent: row.spent,
        budget: row.budget,
        pct: row.pct ?? 0,
        status: row.status,
      }))
      .sort((a, b) => b.pct - a.pct);
    return chartResult(
      { data },
      {
        type: "bar",
        title: "Budget progress",
        subtitle: "This month",
        description: "Consumption spending compared with category caps.",
        freshness: await chartFreshness(userId, { kind: "consumption" }),
        seriesLabels: { spent: "Spent", budget: "Budget" },
        emptyReason: "No budgets are configured yet.",
        data,
        xKey: "category",
        yKey: "spent",
        yKey2: "budget",
        format: "currency",
      },
    );
  },
};

const chartBalancesByType: FinanceTool = {
  name: "chart_balances_by_type",
  description:
    "Render a bar chart of account balances grouped by account type (depository/investment/credit/loan). Use for 'show me my balances broken out by kind of account'.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const rows = await db
      .select()
      .from(financialAccounts)
      .where(inArray(financialAccounts.userId, ids));
    const byType = new Map<string, number>();
    for (const a of rows) byType.set(a.type, (byType.get(a.type) ?? 0) + num(a.currentBalance));
    const data = [...byType.entries()].map(([type, balance]) => ({ type, balance }));
    return chartResult(
      { data },
      {
        type: "bar",
        title: "Balances by account type",
        description: "Current balances grouped by raw provider account type.",
        freshness: await chartFreshness(userId),
        seriesLabels: { balance: "Balance" },
        emptyReason: "No synced account balances are available yet.",
        data,
        xKey: "type",
        yKey: "balance",
        format: "currency",
      },
    );
  },
};

const getBalancesByGroup: FinanceTool = {
  name: "get_balances_by_group",
  description:
    "Total balance per account group (cash / credit / retirement / brokerage / hsa / loan / other / home / vehicle / land / other assets). Use this to understand 'how much cash do I have available', 'how much is locked in retirement', or how real assets contribute to net worth. Returns absolute values; credit/loan are owed (debt).",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const [rows, realAssetRows] = await Promise.all([
      db
        .select()
        .from(financialAccounts)
        .where(inArray(financialAccounts.userId, ids)),
      listRealAssetsForUser(userId),
    ]);
    const byGroup = new Map<string, { balance: number; accounts: number }>();
    for (const a of rows) {
      const g = effectiveGroup(a);
      const e = byGroup.get(g) ?? { balance: 0, accounts: 0 };
      e.balance += num(a.currentBalance);
      e.accounts += 1;
      byGroup.set(g, e);
    }
    for (const asset of realAssetRows) {
      if (asset.status !== "active" || !asset.currentValue) continue;
      const g = asset.kind === "other" ? "other assets" : asset.kind;
      const e = byGroup.get(g) ?? { balance: 0, accounts: 0 };
      e.balance += asset.currentValue.value;
      e.accounts += 1;
      byGroup.set(g, e);
    }
    return [...byGroup.entries()].map(([group, v]) => ({
      group,
      balance: v.balance,
      accounts: v.accounts,
    }));
  },
};

const chartBalancesByGroup: FinanceTool = {
  name: "chart_balances_by_group",
  description:
    "Render a bar chart of balances by account group. More useful than chart_balances_by_type when the user wants to see retirement vs brokerage vs cash separately.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const data = (await getBalancesByGroup.execute({}, { userId })) as Array<{
      group: string;
      balance: number;
    }>;
    return chartResult(
      { data },
      {
        type: "bar",
        title: "Balances by group",
        description: "Current balances grouped by finance role, honoring account overrides.",
        freshness: await chartFreshness(userId),
        seriesLabels: { balance: "Balance" },
        emptyReason: "No synced account balances are available yet.",
        data,
        xKey: "group",
        yKey: "balance",
        format: "currency",
      },
    );
  },
};

/* ------------------------------ budgets ------------------------------ */

const getBudgets: FinanceTool = {
  name: "get_budgets",
  description: "List the user's monthly budgets (category + monthly cap).",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const rows = await db.select().from(budgets).where(inArray(budgets.userId, ids));
    return rows.map((b) => ({
      id: b.id,
      category: b.category,
      monthly: num(b.monthlyAmount),
      currency: b.isoCurrencyCode,
    }));
  },
};

const checkBudgetStatus: FinanceTool = {
  name: "check_budget_status",
  description:
    "For each budget, compare this month's spending to the cap. Returns category, budget, spent, remaining, pct, status (under | near | over). Use whenever the user asks 'am I over budget', 'how am I doing on …'.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const bs = await db.select().from(budgets).where(inArray(budgets.userId, ids));
    const spendByCat = await db
      .select({
        category: effectiveCategorySQL(),
        spent: sql<string>`abs(sum(${transactions.amount}))::text`,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, monthStart),
          sql`${transactions.amount} < 0`,
          eq(transactions.pending, false),
          spendKindWhere("consumption"),
        ),
      )
      .groupBy(effectiveCategorySQL());
    const spendMap = new Map(spendByCat.map((r) => [r.category, num(r.spent)]));
    return bs.map((b) => {
      const cap = num(b.monthlyAmount);
      const spent = spendMap.get(b.category) ?? 0;
      const pct = cap > 0 ? Math.round((spent / cap) * 1000) / 10 : null;
      const status = pct == null ? "n/a" : pct >= 100 ? "over" : pct >= 80 ? "near" : "under";
      return {
        category: b.category,
        budget: cap,
        spent,
        remaining: cap - spent,
        pct,
        status,
      };
    });
  },
};

/* ------------------------------ net worth history ------------------------------ */

const chartNetWorthHistory: FinanceTool = {
  name: "chart_net_worth_history",
  description:
    "Render a line chart of net worth over time from the daily snapshots. Use when the user asks 'how has my net worth changed', 'am I richer than X months ago', or 'show me my net worth trend'.",
  schema: z.object({ days: z.number().int().min(7).max(1825) }).strict(),
  execute: async ({ days }, { userId }) => {
    const ids = await householdUserIds(userId);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const rows = await db
      .select({
        // Force a text result; SQL DATE through node-postgres can confuse Drizzle.
        date: sql<string>`to_char(${netWorthSnapshots.snapshotDate}, 'YYYY-MM-DD')`,
        net: netWorthSnapshots.netWorth,
        assets: netWorthSnapshots.assets,
        liabilities: netWorthSnapshots.liabilities,
      })
      .from(netWorthSnapshots)
      .where(and(inArray(netWorthSnapshots.userId, ids), gte(netWorthSnapshots.snapshotDate, cutoff)))
      .orderBy(netWorthSnapshots.snapshotDate);
    const data = rows.map((r) => ({
      date: r.date,
      net: num(r.net),
      assets: num(r.assets),
      liabilities: num(r.liabilities),
    }));
    return chartResult(
      { data },
      {
        type: "line",
        title: "Net worth",
        subtitle: dateWindowLabel(days),
        description: "Daily snapshots of assets minus debts.",
        freshness: await chartFreshness(userId, { days, exclusions: [] }),
        seriesLabels: { net: "Net worth" },
        emptyReason: "No net-worth snapshots yet. Sync accounts and run the snapshot backfill to populate this chart.",
        data,
        xKey: "date",
        yKey: "net",
        format: "currency",
      },
    );
  },
};

/* ------------------------------ predictive cash flow ------------------------------ */

const projectCashFlow: FinanceTool = {
  name: "project_cash_flow",
  description:
    "Project the next N days of inflows and outflows based on recurring transactions and current balance. Useful for 'will I have enough cash for rent', 'what's my projected balance'.",
  schema: z
    .object({
      days: z.number().int().min(7).max(180),
      accountId: z.string().uuid().nullable(),
    })
    .strict(),
  execute: async ({ days, accountId }, { userId }) => {
    const ids = await householdUserIds(userId);
    // Recurring rows in last 120d → predict each will repeat at its cadence.
    const since = new Date(Date.now() - 120 * 86400_000);
    const rows = await db
      .select({
        id: transactions.id,
        amount: transactions.amount,
        date: transactions.date,
        cadence: transactions.recurrenceCadence,
        merchant: transactions.merchantName,
        name: transactions.name,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.userId, ids),
          gte(transactions.date, since),
          eq(transactions.isRecurring, true),
          eq(transactions.isTransfer, false),
        ),
      );
    const now = new Date();
    const cutoff = new Date(Date.now() + days * 86400_000);
    type Forecast = { date: Date; amount: number; merchant: string };
    const events: Forecast[] = [];
    const byKey = new Map<string, { last: Date; amount: number; cadence: string; merchant: string }>();
    for (const r of rows) {
      const k = (r.merchant ?? r.name).toLowerCase().slice(0, 64);
      const cur = byKey.get(k);
      if (!cur || r.date > cur.last) {
        byKey.set(k, {
          last: r.date,
          amount: Number(r.amount),
          cadence: r.cadence ?? "monthly",
          merchant: r.merchant ?? r.name,
        });
      }
    }
    for (const v of byKey.values()) {
      const stepDays =
        v.cadence === "weekly" ? 7
          : v.cadence === "biweekly" ? 14
          : v.cadence === "quarterly" ? 91
          : v.cadence === "annual" ? 365
          : 30;
      let next = new Date(v.last.getTime() + stepDays * 86400_000);
      while (next <= cutoff) {
        if (next >= now) events.push({ date: next, amount: v.amount, merchant: v.merchant });
        next = new Date(next.getTime() + stepDays * 86400_000);
      }
    }
    events.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Current spendable balance.
    const accts = await db
      .select()
      .from(financialAccounts)
      .where(
        accountId
          ? and(inArray(financialAccounts.userId, ids), eq(financialAccounts.id, accountId))
          : and(inArray(financialAccounts.userId, ids), eq(financialAccounts.type, "depository")),
      );
    const startBalance = accts.reduce((s, a) => s + num(a.currentBalance), 0);
    let running = startBalance;
    const series = events.map((e) => {
      running += e.amount;
      return {
        date: e.date.toISOString().slice(0, 10),
        merchant: e.merchant,
        amount: e.amount,
        projectedBalance: Math.round(running * 100) / 100,
      };
    });
    return {
      startBalance,
      projectedEndBalance: running,
      events: series,
      windowDays: days,
    };
  },
};

/* ------------------------------ alerts (read-only surface) ------------------------------ */

const getAlerts: FinanceTool = {
  name: "get_alerts",
  description:
    "Read recent alerts (large transactions, budget overruns, low balances). Useful for 'anything worth my attention'.",
  schema: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  execute: async ({ limit }, { userId }) => {
    const ids = await householdUserIds(userId);
    const rows = await db
      .select()
      .from(alertsTable)
      .where(inArray(alertsTable.userId, ids))
      .orderBy(desc(alertsTable.createdAt))
      .limit(limit);
    return rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      body: a.body,
      created: a.createdAt,
      read: a.readAt != null,
    }));
  },
};

/* ------------------------------ category mutations (write tools) ------------------------------ */

const setTransactionCategory: FinanceTool = {
  name: "set_transaction_category",
  description:
    "Set or change the category on a single transaction. The user can introduce ANY new category name — it doesn't have to be in the standard list. Use after the user asks to fix a categorization (e.g. 'mark that as travel'). Pass null to clear the override and fall back to the AI guess.",
  schema: z
    .object({
      transactionId: z.string().uuid(),
      category: z.string().min(1).max(64).nullable(),
      subcategory: z.string().max(64).nullable(),
    })
    .strict(),
  execute: async ({ transactionId, category, subcategory }, { userId }) => {
    const ids = await householdUserIds(userId);
    const r = await db
      .update(transactions)
      .set({
        overrideCategory: category,
        overrideSubcategory: subcategory,
      })
      .where(and(inArray(transactions.userId, ids), eq(transactions.id, transactionId)))
      .returning({ id: transactions.id });
    return { ok: r.length > 0, updated: r.length, category };
  },
};

const bulkSetCategoryByMerchant: FinanceTool = {
  name: "bulk_set_category_by_merchant",
  description:
    "Re-categorize every transaction whose merchant or description matches a substring. Useful for 'put all my Spotify charges under Music' or 'tag everything from Whole Foods as Groceries'. Returns how many rows were updated.",
  schema: z
    .object({
      matchSubstring: z.string().min(2).max(120),
      category: z.string().min(1).max(64),
      subcategory: z.string().max(64).nullable(),
    })
    .strict(),
  execute: async ({ matchSubstring, category, subcategory }, { userId }) => {
    const ids = await householdUserIds(userId);
    const r = await db
      .update(transactions)
      .set({ overrideCategory: category, overrideSubcategory: subcategory })
      .where(
        and(
          inArray(transactions.userId, ids),
          sql`(coalesce(${transactions.merchantName},'') ilike ${`%${matchSubstring}%`}
               or coalesce(${transactions.name},'') ilike ${`%${matchSubstring}%`})`,
        ),
      )
      .returning({ id: transactions.id });
    return { ok: r.length > 0, updated: r.length, category, matchSubstring };
  },
};

const runCategorization: FinanceTool = {
  name: "run_categorization",
  description:
    "Write tool: run the AI categorizer for the user's transactions. Use mode='uncategorized' to classify only rows without AI/manual category; use mode='all' only when the user explicitly asks to recategorize everything because it overwrites AI categories while preserving manual overrides.",
  schema: z
    .object({
      mode: z.enum(["uncategorized", "all"]),
      limit: z.number().int().min(1).max(1000),
    })
    .strict(),
  execute: async ({ mode, limit }, { userId }) => {
    const report =
      mode === "all"
        ? await recategorizeAll(userId, { limit })
        : await categorizeUncategorized(userId, { limit });
    return { ok: true, mode, ...report };
  },
};

const getInsights: FinanceTool = {
  name: "get_insights",
  description:
    "Read the latest AI-generated insights for the user (auto-suggested savings tips, anomalies, budget warnings). These are produced in the background after every sync. Useful for 'what should I be paying attention to' / 'any suggestions'.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const rows = await db
      .select()
      .from(aiInsights)
      .where(and(inArray(aiInsights.userId, ids), sql`${aiInsights.dismissedAt} is null`))
      .orderBy(desc(aiInsights.generatedAt))
      .limit(20);
    return rows.map((r) => ({
      kind: r.kind,
      severity: r.severity,
      title: r.title,
      body: r.body,
      generated: r.generatedAt,
    }));
  },
};

/* ------------------------------ account group override ------------------------------ */

const setAccountGroup: FinanceTool = {
  name: "set_account_group",
  description:
    "Reclassify an account into a different group for ALL subsequent analysis (balances, net-worth-by-group, charts). Useful when the user holds something at a brokerage but conceptually treats it like cash/savings — e.g. 'treat my Fidelity brokerage as cash going forward'. Allowed groups: cash | credit | retirement | brokerage | hsa | loan | other. Pass `clear` to remove the override and fall back to the system-assigned group. The change is persistent across conversations.",
  schema: z
    .object({
      accountId: z.string().uuid(),
      group: z.enum([...ACCOUNT_GROUPS, "clear"]),
    })
    .strict(),
  execute: async ({ accountId, group }, { userId }) => {
    const ids = await householdUserIds(userId);
    const value = group === "clear" ? null : (group as AccountGroup);
    const r = await db
      .update(financialAccounts)
      .set({ userAccountGroup: value })
      .where(and(inArray(financialAccounts.userId, ids), eq(financialAccounts.id, accountId)))
      .returning({
        id: financialAccounts.id,
        name: financialAccounts.name,
        systemGroup: financialAccounts.accountGroup,
        userOverride: financialAccounts.userAccountGroup,
      });
    if (r.length === 0) return { ok: false, error: "account not found" };
    return {
      ok: true,
      account: r[0].name,
      systemGroup: r[0].systemGroup,
      userOverride: r[0].userOverride,
      effectiveGroup: r[0].userOverride ?? r[0].systemGroup,
    };
  },
};

/* ------------------------------ long-term memory ------------------------------ */

const remember: FinanceTool = {
  name: "remember",
  description:
    "Save a long-term note about the user that you can recall in future conversations. Use for: preferences ('treats Fidelity as cash'), goals ('saving for house in 5 years'), facts they want you to know ('partner's name is Sam'), or context that should persist. Pass an optional stable `key` to upsert (e.g. 'fidelity-as-cash', 'savings-goal'); without a key, a new memory is created. Keep `content` concise — one or two sentences.",
  schema: z
    .object({
      content: z.string().min(2).max(2000),
      key: z.string().min(1).max(80).nullable(),
      pinned: z.boolean(),
    })
    .strict(),
  execute: async ({ content, key, pinned }, { userId }) => {
    if (key) {
      const existing = await db
        .select()
        .from(assistantMemories)
        .where(and(eq(assistantMemories.userId, userId), eq(assistantMemories.key, key)))
        .limit(1);
      if (existing[0]) {
        await db
          .update(assistantMemories)
          .set({ content, pinned })
          .where(eq(assistantMemories.id, existing[0].id));
        return { ok: true, id: existing[0].id, key, action: "updated" };
      }
    }
    const [m] = await db
      .insert(assistantMemories)
      .values({ userId, content, key, pinned })
      .returning({ id: assistantMemories.id });
    return { ok: true, id: m.id, key, action: "created" };
  },
};

const recall: FinanceTool = {
  name: "recall",
  description:
    "Search the user's long-term memories. Pass a `query` substring to filter by content; pass null to list all (newest first, pinned first). Call this when the user references something they might have told you before, or when you want to personalize an answer.",
  schema: z
    .object({
      query: z.string().nullable(),
      limit: z.number().int().min(1).max(50),
    })
    .strict(),
  execute: async ({ query, limit }, { userId }) => {
    const conds = [eq(assistantMemories.userId, userId)];
    if (query && query.trim()) {
      conds.push(
        or(
          ilike(assistantMemories.content, `%${query}%`),
          ilike(assistantMemories.key, `%${query}%`),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(assistantMemories)
      .where(and(...conds))
      .orderBy(desc(assistantMemories.pinned), desc(assistantMemories.createdAt))
      .limit(limit);
    // Best-effort touch of accessedAt; ignored on error.
    if (rows.length > 0) {
      await db
        .update(assistantMemories)
        .set({ accessedAt: new Date() })
        .where(inArray(assistantMemories.id, rows.map((r) => r.id)))
        .catch(() => {});
    }
    return rows.map((m) => ({
      id: m.id,
      key: m.key,
      content: m.content,
      pinned: m.pinned,
      created: m.createdAt,
    }));
  },
};

const forget: FinanceTool = {
  name: "forget",
  description:
    "Delete a saved memory by id or by key. Use when the user asks you to forget something, or to remove a stale fact. Provide exactly one of `id` or `key`.",
  schema: z
    .object({
      id: z.string().uuid().nullable(),
      key: z.string().min(1).max(80).nullable(),
    })
    .strict(),
  execute: async ({ id, key }, { userId }) => {
    if (!id && !key) return { ok: false, error: "id or key required" };
    const conds = [eq(assistantMemories.userId, userId)];
    if (id) conds.push(eq(assistantMemories.id, id));
    else if (key) conds.push(eq(assistantMemories.key, key));
    const r = await db
      .delete(assistantMemories)
      .where(and(...conds))
      .returning({ id: assistantMemories.id });
    return { ok: r.length > 0, deleted: r.length };
  },
};

const listCategories: FinanceTool = {
  name: "list_categories",
  description:
    "List every category currently in use for the user's transactions (merging AI guesses, user overrides, and raw aggregator categories) with row counts. Use when the user asks 'what categories do I have' or before bulk-renaming.",
  schema: z.object({}).strict(),
  execute: async (_args, { userId }) => {
    const ids = await householdUserIds(userId);
    const rows = await db
      .select({
        category: sql<string>`coalesce(${transactions.overrideCategory}, ${transactions.aiCategory}, ${transactions.category}, 'Uncategorized')`,
        count: sql<number>`count(*)::int`,
        overrides: sql<number>`count(${transactions.overrideCategory})::int`,
      })
      .from(transactions)
      .where(inArray(transactions.userId, ids))
      .groupBy(
        sql`coalesce(${transactions.overrideCategory}, ${transactions.aiCategory}, ${transactions.category}, 'Uncategorized')`,
      )
      .orderBy(sql`count(*) desc`);
    return rows;
  },
};

export const financeTools: FinanceTool[] = [
  getAccounts,
  getRecentTransactions,
  searchTransactions,
  getSpendingByCategory,
  getHoldings,
  getRecurringMerchants,
  getNetWorth,
  getTopMerchants,
  getLargestTransactions,
  getCashFlow,
  comparePeriods,
  getPortfolioSummary,
  getBalancesByGroup,
  chartSpendingTrend,
  chartCategoryBreakdown,
  chartSavingsDestinations,
  chartCashFlow,
  chartRecurringMerchants,
  chartTopMerchants,
  chartBudgetStatus,
  chartBalancesByType,
  chartBalancesByGroup,
  getBudgets,
  checkBudgetStatus,
  chartNetWorthHistory,
  projectCashFlow,
  getAlerts,
  getConsumptionVsSavings,
  chartConsumptionVsSavings,
  setTransactionCategory,
  bulkSetCategoryByMerchant,
  runCategorization,
  listCategories,
  getInsights,
  setAccountGroup,
  remember,
  recall,
  forget,
];

export function findTool(name: string): FinanceTool | undefined {
  return financeTools.find((t) => t.name === name);
}
