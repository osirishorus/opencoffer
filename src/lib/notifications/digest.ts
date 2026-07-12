/**
 * Scheduled digest summaries.
 *
 * Built from the same deterministic finance tools the chat uses, emitted as
 * an alert row (kind "digest") so it appears in the in-app alerts feed and
 * rides the existing notification-delivery pipeline. Channels receive
 * digests only when their config has `digest: true` (per-channel opt-in,
 * enforced in deliverPendingAlerts).
 *
 * Cadence is controlled by OPENCOFFER_DIGEST_CRON (default: Monday 08:00).
 */
import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { alerts, notificationChannels, users } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { findTool } from "@/lib/finance/tools";
import type { NotificationConfig } from "@/lib/notifications/deliver";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

async function callTool<T>(name: string, args: Record<string, unknown>, userId: string): Promise<T> {
  const tool = findTool(name)!;
  return (await tool.execute(tool.schema.parse(args), { userId })) as T;
}

export async function buildDigestForUser(userId: string): Promise<{ title: string; body: string }> {
  const [flows, budgets, netWorth, topMerchants] = await Promise.all([
    callTool<Array<{ consumption: number; savings: number; income: number }>>(
      "get_consumption_vs_savings", { days: 7, groupBy: "total" }, userId,
    ),
    callTool<Array<{ category: string; spent: number; budget: number; status: string }>>(
      "check_budget_status", {}, userId,
    ),
    callTool<{ netWorth: number }>("get_net_worth", {}, userId),
    callTool<Array<{ merchant: string; total: number }>>(
      "get_top_merchants", { days: 7, direction: "outflow", limit: 3, kind: "consumption" }, userId,
    ),
  ]);

  const f = flows[0] ?? { consumption: 0, savings: 0, income: 0 };
  const lines: string[] = [
    `In: ${money(f.income)} · Spent: ${money(f.consumption)} · Saved: ${money(f.savings)}`,
  ];
  if (topMerchants.length) {
    lines.push(`Top spending: ${topMerchants.map((m) => `${m.merchant} ${money(m.total)}`).join(", ")}`);
  }
  const over = budgets.filter((b) => b.status === "over");
  const near = budgets.filter((b) => b.status === "near");
  if (over.length || near.length) {
    const parts = [
      ...over.map((b) => `${b.category} OVER (${money(b.spent)}/${money(b.budget)})`),
      ...near.map((b) => `${b.category} near (${money(b.spent)}/${money(b.budget)})`),
    ];
    lines.push(`Budgets: ${parts.join(", ")}`);
  } else if (budgets.length) {
    lines.push("Budgets: all on track");
  }
  lines.push(`Net worth: ${money(netWorth.netWorth)}`);

  return { title: "Your OpenCoffer week in review", body: lines.join("\n") };
}

/** True if the user has at least one enabled channel opted into digests. */
export async function userWantsDigest(userId: string): Promise<boolean> {
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.enabled, true)));
  return channels.some((c) => {
    try {
      return (JSON.parse(decrypt(c.configCipher)) as NotificationConfig).digest === true;
    } catch {
      return false;
    }
  });
}

/** Emit a digest alert for every opted-in user. Skips if one was already
 *  emitted in the last 20 hours (guards against overlapping cron fires). */
export async function emitDigests(): Promise<{ users: number; emitted: number; emittedUserIds: string[] }> {
  const allUsers = await db.select({ id: users.id }).from(users);
  let emitted = 0;
  const emittedUserIds: string[] = [];
  for (const u of allUsers) {
    try {
      if (!(await userWantsDigest(u.id))) continue;
      const recent = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(
          and(
            eq(alerts.userId, u.id),
            eq(alerts.kind, "digest"),
            gte(alerts.createdAt, new Date(Date.now() - 20 * 3600_000)),
          ),
        )
        .limit(1);
      if (recent.length) continue;
      const digest = await buildDigestForUser(u.id);
      await db.insert(alerts).values({
        userId: u.id,
        kind: "digest",
        title: digest.title,
        body: digest.body,
        meta: { dedupeKey: `digest:${new Date().toISOString().slice(0, 10)}` },
      });
      emitted++;
      emittedUserIds.push(u.id);
    } catch (e) {
      console.error(`[digest] failed for ${u.id}:`, e);
    }
  }
  return { users: allUsers.length, emitted, emittedUserIds };
}
