import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { transactions, financialAccounts, categoryRules } from "@/lib/db/schema";
import { count, desc, eq, inArray } from "drizzle-orm";
import { AppBar } from "@/components/AppBar";
import { householdUserIds } from "@/lib/household";
import { parseTransactionFilters, transactionWhere } from "@/lib/finance/transactionFilters";
import { TransactionsClient } from "./TransactionsClient";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const resolved = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0]) query.set(key, value[0]);
  }

  const filters = parseTransactionFilters(query);
  const page = Math.max(1, Number(query.get("page") ?? "1") || 1);
  const where = await transactionWhere(userId, filters);
  const ids = await householdUserIds(userId);

  const [rows, [countRow], accounts, rules] = await Promise.all([
    db
      .select({
        id: transactions.id,
        date: transactions.date,
        amount: transactions.amount,
        name: transactions.name,
        merchant: transactions.merchantName,
        overrideMerchant: transactions.overrideMerchant,
        category: transactions.category,
        aiCategory: transactions.aiCategory,
        overrideCategory: transactions.overrideCategory,
        aiSubcategory: transactions.aiSubcategory,
        overrideSubcategory: transactions.overrideSubcategory,
        isTransfer: transactions.isTransfer,
        overrideIsTransfer: transactions.overrideIsTransfer,
        isRecurring: transactions.isRecurring,
        userNotes: transactions.userNotes,
        pending: transactions.pending,
        currency: transactions.isoCurrencyCode,
        accountId: financialAccounts.id,
        accountName: financialAccounts.name,
        accountMask: financialAccounts.mask,
        accountSource: financialAccounts.source,
      })
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(where)
      .orderBy(desc(transactions.date), desc(transactions.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({ total: count() })
      .from(transactions)
      .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
      .where(where),
    db
      .select({
        id: financialAccounts.id,
        name: financialAccounts.name,
        type: financialAccounts.type,
        source: financialAccounts.source,
        currency: financialAccounts.isoCurrencyCode,
      })
      .from(financialAccounts)
      .where(inArray(financialAccounts.userId, ids))
      .orderBy(financialAccounts.name),
    db
      .select()
      .from(categoryRules)
      .where(eq(categoryRules.userId, userId))
      .orderBy(desc(categoryRules.createdAt)),
  ]);

  const total = countRow?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(
    filters.search || filters.accountId || filters.category || filters.startDate || filters.endDate,
  );

  return (
    <>
      <AppBar
        title="Transactions"
        subtitle={
          total === 0
            ? hasFilters
              ? "No transactions match these filters."
              : "Nothing here yet."
            : `${total.toLocaleString()} matching · page ${page} of ${pageCount}`
        }
      />
      <div className="p-4 pb-24 md:p-8 md:pb-8">
        <TransactionsClient
          rows={rows.map((r) => ({
            ...r,
            date: r.date.toISOString(),
            amount: Number(r.amount),
          }))}
          initialRules={rules.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
          }))}
          accounts={accounts}
          filters={{
            search: filters.search ?? "",
            accountId: filters.accountId ?? "",
            category: filters.category ?? "",
            startDate: filters.startDate ?? "",
            endDate: filters.endDate ?? "",
          }}
          page={page}
          pageCount={pageCount}
          total={total}
        />
      </div>
    </>
  );
}
