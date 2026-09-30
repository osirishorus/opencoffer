import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  alertRules,
  alerts as alertsTable,
  transactions,
  financialAccounts,
  budgets,
} from "@/lib/db/schema";
import { effectiveCategorySQL, findTool, spendKindWhere, type RecurringMerchant } from "@/lib/finance/tools";
import { householdUserIds } from "@/lib/household";

export const ALERT_KINDS = [
  "large_tx",
  "category_overspend",
  "low_balance",
  "recurring_price_increase",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * Evaluate every active rule for a user and persist any new alerts.
 * Idempotent per dedupe key — each evaluator scopes its key to the thing it
 * alerts about (a transaction, a category-month, an account-day, a price
 * change), so re-running rules never repeats an alert.
 */
export async function evaluateAlerts(userId: string) {
  const rules = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.userId, userId), eq(alertRules.enabled, true)));
  if (rules.length === 0) return;

  for (const rule of rules) {
    try {
      if (rule.kind === "large_tx") await evaluateLargeTx(userId, rule);
      else if (rule.kind === "category_overspend") await evaluateOverspend(userId, rule);
      else if (rule.kind === "low_balance") await evaluateLowBalance(userId, rule);
      else if (rule.kind === "recurring_price_increase") await evaluatePriceIncrease(userId, rule);
    } catch (e) {
      console.error("[alerts] rule eval failed", rule.id, e);
    }
  }
}

async function emit(opts: {
  userId: string;
  ruleId: string;
  kind: string;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
  dedupeKey: string;
}) {
  // Dedupe on the key alone. A time window here used to re-fire alerts: large
  // transactions are scanned over a 3-day lookback (so a 24h window alerted on
  // the same transaction up to three times) and a budget overrun, keyed by
  // month, alerted again every day for the rest of the month.
  const existing = await db
    .select({ id: alertsTable.id })
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.userId, opts.userId),
        eq(alertsTable.kind, opts.kind),
        sql`${alertsTable.meta} ->> 'dedupeKey' = ${opts.dedupeKey}`,
      ),
    )
    .limit(1);
  if (existing.length) return;
  await db.insert(alertsTable).values({
    userId: opts.userId,
    ruleId: opts.ruleId,
    kind: opts.kind,
    title: opts.title,
    body: opts.body ?? null,
    meta: { ...(opts.meta ?? {}), dedupeKey: opts.dedupeKey },
  });
}

async function evaluateLargeTx(userId: string, rule: typeof alertRules.$inferSelect) {
  const threshold = Number(rule.threshold ?? 500);
  const since = new Date(Date.now() - 3 * 86400_000);
  const rows = await db
    .select({
      id: transactions.id,
      amount: transactions.amount,
      name: transactions.name,
      date: transactions.date,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, since),
        sql`abs(${transactions.amount}) >= ${threshold}`,
        eq(transactions.isTransfer, false),
      ),
    )
    .orderBy(desc(transactions.date))
    .limit(50);
  for (const t of rows) {
    const amount = Number(t.amount);
    await emit({
      userId,
      ruleId: rule.id,
      kind: "large_tx",
      title: `${amount < 0 ? "Large spend" : "Large inflow"}: $${Math.abs(amount).toLocaleString()}`,
      body: t.name.slice(0, 200),
      meta: { txId: t.id, amount },
      dedupeKey: `tx:${t.id}`,
    });
  }
}

async function evaluateOverspend(userId: string, rule: typeof alertRules.$inferSelect) {
  // Find this month's category total vs budget.
  if (!rule.category) return;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [budgetRow] = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.userId, userId), eq(budgets.category, rule.category)))
    .limit(1);
  if (!budgetRow) return;
  const cap = Number(budgetRow.monthlyAmount);
  const [{ spent }] = await db
    .select({
      spent: sql<string>`coalesce(abs(sum(${transactions.amount})), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.date, monthStart),
        sql`${transactions.amount} < 0`,
        eq(transactions.pending, false),
        spendKindWhere("consumption"),
        sql`${effectiveCategorySQL()} = ${rule.category}`,
      ),
    );
  const total = Number(spent);
  if (total >= cap) {
    await emit({
      userId,
      ruleId: rule.id,
      kind: "category_overspend",
      title: `Over budget — ${rule.category}: $${total.toLocaleString()} of $${cap.toLocaleString()}`,
      body: `You hit your monthly ${rule.category} budget on ${new Date().toLocaleDateString()}.`,
      meta: { category: rule.category, spent: total, budget: cap },
      dedupeKey: `overspend:${rule.category}:${monthStart.toISOString().slice(0, 7)}`,
    });
  }
}

async function evaluateLowBalance(userId: string, rule: typeof alertRules.$inferSelect) {
  if (!rule.accountId || rule.threshold == null) return;
  // The rule's account must belong to this user's household — otherwise a
  // crafted rule would leak another user's account name and balance.
  const ids = await householdUserIds(userId);
  const [acct] = await db
    .select()
    .from(financialAccounts)
    .where(and(eq(financialAccounts.id, rule.accountId), inArray(financialAccounts.userId, ids)))
    .limit(1);
  if (!acct) return;
  const bal = Number(acct.currentBalance ?? 0);
  if (bal <= Number(rule.threshold)) {
    await emit({
      userId,
      ruleId: rule.id,
      kind: "low_balance",
      title: `Low balance on ${acct.name}: $${bal.toLocaleString()}`,
      body: `Your account is at or below the $${Number(rule.threshold).toLocaleString()} threshold.`,
      meta: { accountId: acct.id, balance: bal },
      dedupeKey: `low_balance:${acct.id}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
}

async function evaluatePriceIncrease(userId: string, rule: typeof alertRules.$inferSelect) {
  // threshold = minimum % increase worth alerting on (default 5%).
  const minPct = rule.threshold != null ? Number(rule.threshold) : 5;
  const recurring = (await findTool("get_recurring_merchants")!.execute(
    { days: 365 },
    { userId },
  )) as RecurringMerchant[];
  for (const r of recurring) {
    const pc = r.priceChange;
    if (!r.active || !pc || pc.pct < minPct) continue;
    const lastDay = new Date(r.lastDate).toISOString().slice(0, 10);
    await emit({
      userId,
      ruleId: rule.id,
      kind: "recurring_price_increase",
      title: `Price increase — ${r.merchant}: $${pc.from.toFixed(2)} → $${pc.to.toFixed(2)}`,
      body: `Up ${pc.pct.toFixed(1)}% on the charge dated ${lastDay}.`,
      meta: { merchant: r.merchant, from: pc.from, to: pc.to, pct: pc.pct },
      dedupeKey: `price:${r.merchant.toLowerCase()}:${lastDay}`,
    });
  }
}
