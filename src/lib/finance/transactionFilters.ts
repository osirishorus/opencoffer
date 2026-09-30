import { and, eq, gte, ilike, inArray, lte, or, type SQL } from "drizzle-orm";
import { financialAccounts, transactions } from "@/lib/db/schema";
import { householdUserIds } from "@/lib/household";

/**
 * The filter set shared by the transactions page, the CSV export, and anything
 * else that lists transactions. Keeping one builder means the table you're
 * looking at and the CSV you download can never disagree about what "matches".
 */
export type TransactionFilters = {
  search?: string | null;
  accountId?: string | null;
  category?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};

/** Reads the filter set out of a URL's query string. */
export function parseTransactionFilters(params: URLSearchParams): TransactionFilters {
  const get = (key: string) => params.get(key)?.trim() || null;
  return {
    // `q` is what the UI uses; `search` is kept for existing export links.
    search: get("q") ?? get("search"),
    accountId: get("accountId") ?? get("account"),
    category: get("category"),
    startDate: get("startDate") ?? get("from"),
    endDate: get("endDate") ?? get("to"),
  };
}

/** Serializes filters back into a query string (omitting empty values). */
export function transactionFiltersToQuery(filters: TransactionFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.accountId) params.set("accountId", filters.accountId);
  if (filters.category) params.set("category", filters.category);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  return params;
}

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Builds the WHERE clause for a transaction list, scoped to everyone whose data
 * `viewerUserId` is allowed to see. Household members share accounts, so this
 * must use householdUserIds() — scoping to the viewer alone makes the
 * transaction list silently disagree with the dashboard totals above it.
 *
 * Queries using this must join `financialAccounts`, since the search clause
 * matches on the account name.
 */
export async function transactionWhere(
  viewerUserId: string,
  filters: TransactionFilters,
): Promise<SQL | undefined> {
  const ids = await householdUserIds(viewerUserId);
  const conditions: SQL[] = [inArray(transactions.userId, ids)];

  if (filters.accountId) conditions.push(eq(transactions.accountId, filters.accountId));

  const start = validDate(filters.startDate);
  if (start) conditions.push(gte(transactions.date, start));

  const end = validDate(filters.endDate);
  if (end) {
    // Treat a bare YYYY-MM-DD end date as inclusive of that whole day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.endDate!.trim())) {
      end.setUTCHours(23, 59, 59, 999);
    }
    conditions.push(lte(transactions.date, end));
  }

  if (filters.category) {
    conditions.push(
      or(
        ilike(transactions.overrideCategory, filters.category),
        ilike(transactions.aiCategory, filters.category),
        ilike(transactions.category, filters.category),
      )!,
    );
  }

  if (filters.search) {
    // Escape LIKE wildcards so a literal % or _ in the query doesn't match everything.
    const like = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      or(
        ilike(transactions.name, like),
        ilike(transactions.merchantName, like),
        ilike(transactions.overrideMerchant, like),
        ilike(transactions.userNotes, like),
        ilike(financialAccounts.name, like),
        ilike(transactions.overrideCategory, like),
        ilike(transactions.aiCategory, like),
        ilike(transactions.category, like),
      )!,
    );
  }

  return and(...conditions);
}
