import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users, householdMembers } from "@/lib/db/schema";

/**
 * Returns the set of user IDs whose financial data is visible to `viewerUserId`.
 * Same household = combined view. Falls back to just the viewer if they're not
 * yet in a household (shouldn't happen post-migration but safe).
 *
 * Used to scope queries on shared tables: transactions, financial_accounts,
 * connections, holdings, budgets, alert_rules, alerts, net_worth_snapshots.
 *
 * NOT used for per-user-only tables: llm_credentials, chat_threads, chat_messages,
 * mcp_tokens.
 *
 * Wrapped in React's cache() so it resolves once per request instead of once per
 * tool call — the dashboard alone fans out to eight tools, which meant sixteen
 * redundant queries just to answer "who am I allowed to see?". Outside a request
 * (the worker) cache() passes straight through, so a long-running process never
 * pins a stale household.
 */
export const householdUserIds = cache(async function householdUserIds(
  viewerUserId: string,
): Promise<string[]> {
  const [me] = await db
    .select({ householdId: users.householdId })
    .from(users)
    .where(eq(users.id, viewerUserId))
    .limit(1);
  if (!me?.householdId) return [viewerUserId];
  const rows = await db
    .select({ userId: householdMembers.userId })
    .from(householdMembers)
    .where(eq(householdMembers.householdId, me.householdId));
  if (rows.length === 0) return [viewerUserId];
  return rows.map((r) => r.userId);
});
