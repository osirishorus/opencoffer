import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  alertRules,
  alerts as alertsTable,
  transactions,
  financialAccounts,
  budgets,
  connections,
} from "@/lib/db/schema";
import { effectiveCategorySQL, effectiveIsTransferSQL, spendKindWhere } from "@/lib/finance/tools";

/**
 * Evaluate every active rule for a user and persist any new alerts.
 * Idempotent per (rule, day, entity) — we don't repeat alerts for the same
 * transaction or category overrun within a single calendar day.
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
      else if (rule.kind === "card_dormant") await evaluateCardDormant(userId, rule);
      else if (rule.kind === "sync_stale") await evaluateSyncStale(userId, rule);
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
  // Don't emit the same alert twice in 24h.
  const existing = await db
    .select({ id: alertsTable.id })
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.userId, opts.userId),
        eq(alertsTable.kind, opts.kind),
        sql`${alertsTable.meta} ->> 'dedupeKey' = ${opts.dedupeKey}`,
        gte(alertsTable.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
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
        sql`${effectiveIsTransferSQL()} = false`,
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

/** Fee postings shouldn't count as "using" a card, and are worth calling out. */
const FEE_NAME_SQL = sql`(${transactions.name} ilike '%membership fee%' or ${transactions.name} ilike '%annual fee%')`;

/**
 * card_dormant: alert when a credit-group card has had no real purchase for
 * `threshold` days (default 90; the notification window is user-configurable
 * per rule). Fee postings, transfers, and pending rows don't count as usage.
 * If the card charged an annual/membership fee in the last 400 days, the
 * alert calls it out — a dormant card with a fee is money on fire.
 * Re-alerts at most once per calendar month per card while dormant.
 */
async function evaluateCardDormant(userId: string, rule: typeof alertRules.$inferSelect) {
  const days = Number(rule.threshold ?? 90);
  const cutoff = new Date(Date.now() - days * 86400_000);
  const accts = (
    await db.select().from(financialAccounts).where(eq(financialAccounts.userId, userId))
  ).filter(
    (a) =>
      (a.userAccountGroup ?? a.accountGroup) === "credit" &&
      (!rule.accountId || a.id === rule.accountId),
  );

  for (const acct of accts) {
    const [lastPurchase] = await db
      .select({ date: sql<Date | null>`max(${transactions.date})` })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, acct.id),
          sql`${transactions.amount} < 0`,
          eq(transactions.pending, false),
          sql`${effectiveIsTransferSQL()} = false`,
          sql`not ${FEE_NAME_SQL}`,
        ),
      );
    const last = lastPurchase?.date ? new Date(lastPurchase.date) : null;
    if (last && last >= cutoff) continue;

    const [fee] = await db
      .select({ date: transactions.date, amount: transactions.amount, name: transactions.name })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, acct.id),
          FEE_NAME_SQL,
          gte(transactions.date, new Date(Date.now() - 400 * 86400_000)),
        ),
      )
      .orderBy(desc(transactions.date))
      .limit(1);

    const lastLabel = last ? `Last purchase ${last.toISOString().slice(0, 10)}.` : "No purchases on record.";
    const feeLabel = fee
      ? ` Charged a ${Math.abs(Number(fee.amount)) > 0 ? `$${Math.abs(Number(fee.amount)).toLocaleString()} ` : ""}annual/membership fee on ${new Date(fee.date).toISOString().slice(0, 10)} — consider downgrading or canceling.`
      : "";
    await emit({
      userId,
      ruleId: rule.id,
      kind: "card_dormant",
      title: `Dormant card: ${acct.name} — no purchases in ${days}+ days`,
      body: `${lastLabel}${feeLabel}`,
      meta: { accountId: acct.id, days, lastPurchase: last?.toISOString() ?? null, feeDate: fee ? new Date(fee.date).toISOString() : null },
      dedupeKey: `dormant:${acct.id}:${new Date().toISOString().slice(0, 7)}`,
    });
  }
}

/**
 * sync_stale: health check on the SimpleFIN pipeline itself. Fires when any
 * active connection hasn't successfully synced within `threshold` hours
 * (default 24) or is sitting in status='error'. Evaluated for every user
 * with rules on each worker tick — including users whose sync FAILED, which
 * is exactly when this needs to fire. Dedupes daily per user.
 */
async function evaluateSyncStale(userId: string, rule: typeof alertRules.$inferSelect) {
  const hours = Number(rule.threshold ?? 24);
  const cutoff = new Date(Date.now() - hours * 3600_000);
  const conns = await db.select().from(connections).where(eq(connections.userId, userId));
  const active = conns.filter((c) => c.status !== "disconnected");
  if (active.length === 0) return;

  const unhealthy = active.filter(
    (c) => c.status === "error" || !c.lastSyncedAt || c.lastSyncedAt < cutoff,
  );
  if (unhealthy.length === 0) return;

  const lines = unhealthy.map((c) => {
    const label = c.label || c.orgName || "Connection";
    const age = c.lastSyncedAt
      ? `last synced ${Math.round((Date.now() - c.lastSyncedAt.getTime()) / 3600_000)}h ago`
      : "never synced";
    return `${label}: ${age}${c.status === "error" ? " (status: error)" : ""}`;
  });
  await emit({
    userId,
    ruleId: rule.id,
    kind: "sync_stale",
    title: `Bank sync unhealthy: ${unhealthy.length} of ${active.length} connection(s) stale`,
    body: `No fresh SimpleFIN data in over ${hours}h.\n${lines.join("\n")}`,
    meta: { hours, staleConnectionIds: unhealthy.map((c) => c.id) },
    dedupeKey: `sync_stale:${new Date().toISOString().slice(0, 10)}`,
  });
}

async function evaluateLowBalance(userId: string, rule: typeof alertRules.$inferSelect) {
  if (!rule.accountId || rule.threshold == null) return;
  const [acct] = await db
    .select()
    .from(financialAccounts)
    .where(eq(financialAccounts.id, rule.accountId))
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
