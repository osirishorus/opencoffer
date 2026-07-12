/**
 * Pending-transaction hygiene.
 *
 * Banks frequently issue a NEW transaction id when a pending charge posts, so
 * the posted row arrives alongside the stale pending ghost instead of
 * replacing it. Aggregates already exclude pending rows, but row-level tools
 * and the UI show them — and a ghost that never clears double-counts the
 * purchase forever.
 *
 * Two conservative passes:
 *  1. Duplicate reconciliation: delete a pending row when a POSTED row exists
 *     on the same account with the exact same amount within ±7 days. Pairing
 *     is strictly 1:1 (greedy, closest-date first) so a batch of identical
 *     legitimate pending charges is never mass-deleted against one posted row.
 *  2. Stale expiry: delete pending rows older than 21 days — real pendings
 *     post within days; anything older is a void or a ghost.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { transactions } from "@/lib/db/schema";

const DUPLICATE_WINDOW_MS = 7 * 86400_000;
const STALE_AFTER_DAYS = 21;

export async function cleanPendingTransactions(
  userId?: string,
): Promise<{ removedDuplicates: number; removedStale: number }> {
  const pendingConds = [eq(transactions.pending, true)];
  if (userId) pendingConds.push(eq(transactions.userId, userId));
  const pendings = await db
    .select({ id: transactions.id, accountId: transactions.accountId, amount: transactions.amount, date: transactions.date })
    .from(transactions)
    .where(and(...pendingConds));

  const toDelete: string[] = [];
  if (pendings.length > 0) {
    const accountIds = [...new Set(pendings.map((p) => p.accountId))];
    const posted = await db
      .select({ id: transactions.id, accountId: transactions.accountId, amount: transactions.amount, date: transactions.date })
      .from(transactions)
      .where(and(eq(transactions.pending, false), inArray(transactions.accountId, accountIds)));

    // Group posted rows by (account, amount) for 1:1 claiming.
    const buckets = new Map<string, Array<{ id: string; date: Date; claimed: boolean }>>();
    for (const q of posted) {
      const key = `${q.accountId}|${Number(q.amount)}`;
      const b = buckets.get(key) ?? [];
      b.push({ id: q.id, date: q.date, claimed: false });
      buckets.set(key, b);
    }
    for (const p of pendings) {
      const candidates = buckets.get(`${p.accountId}|${Number(p.amount)}`) ?? [];
      const match = candidates
        .filter((c) => !c.claimed && Math.abs(c.date.getTime() - p.date.getTime()) <= DUPLICATE_WINDOW_MS)
        .sort((a, b) => Math.abs(a.date.getTime() - p.date.getTime()) - Math.abs(b.date.getTime() - p.date.getTime()))[0];
      if (match) {
        match.claimed = true;
        toDelete.push(p.id);
      }
    }
    if (toDelete.length) {
      await db.delete(transactions).where(inArray(transactions.id, toDelete));
    }
  }

  const staleConds = [
    eq(transactions.pending, true),
    lt(transactions.date, sql`now() - make_interval(days => ${STALE_AFTER_DAYS})`),
  ];
  if (userId) staleConds.push(eq(transactions.userId, userId));
  const stale = await db
    .delete(transactions)
    .where(and(...staleConds))
    .returning({ id: transactions.id });

  return { removedDuplicates: toDelete.length, removedStale: stale.length };
}
