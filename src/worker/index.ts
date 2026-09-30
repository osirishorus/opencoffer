/* OpenCoffer background worker.
 *
 * Runs two cron jobs:
 *  - Frequent reconciliation: re-sync every active SimpleFIN connection.
 *  - Hourly retention check: hard-delete connections where status='disconnected'
 *    and purge_after <= now() (matches OpenAI's 30-day-after-disconnect rule).
 */
import cron from "node-cron";
import { lte, and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { connections, auditLog } from "@/lib/db/schema";
import { syncConnection } from "@/lib/simplefin/sync";
import { categorizeUncategorized } from "@/lib/finance/categorize";
import { snapshotAllUsers, snapshotNetWorthForUser } from "@/lib/finance/netWorthSnapshot";
import { evaluateAlerts } from "@/lib/finance/alerts";
import { generateInsights } from "@/lib/finance/insights";
import { refreshAllRealAssets } from "@/lib/real-assets/refresh";
import { deliverPendingAlerts } from "@/lib/notifications/deliver";
import { pruneThrottles } from "@/lib/auth/throttle";

async function runFrequentSync() {
  const items = await db.select().from(connections).where(eq(connections.status, "active"));
  console.log(`[worker] sync: ${items.length} connection(s)`);
  const seenUsers = new Set<string>();
  for (const it of items) {
    try {
      await syncConnection(it.id);
      seenUsers.add(it.userId);
    } catch (e) {
      console.error(`[worker] sync failed for ${it.id}:`, e);
    }
  }
  // syncConnection fires categorize in the background, but in the worker we
  // want to wait so the next cron tick can see fresh state and audit_log entries.
  for (const uid of seenUsers) {
    try {
      const r = await categorizeUncategorized(uid);
      console.log(`[worker] categorize for ${uid}:`, r);
    } catch (e) {
      console.error(`[worker] categorize failed for ${uid}:`, e);
    }
    try {
      await snapshotNetWorthForUser(uid);
    } catch (e) {
      console.error(`[worker] snapshot failed for ${uid}:`, e);
    }
    try {
      await evaluateAlerts(uid);
    } catch (e) {
      console.error(`[worker] alerts failed for ${uid}:`, e);
    }
    try {
      const delivered = await deliverPendingAlerts(uid);
      if (delivered.alerts > 0) console.log(`[worker] alert delivery for ${uid}:`, delivered);
    } catch (e) {
      console.error(`[worker] alert delivery failed for ${uid}:`, e);
    }
    try {
      await generateInsights(uid);
    } catch (e) {
      console.error(`[worker] insights failed for ${uid}:`, e);
    }
  }
}

async function runRetentionPurge() {
  // Expired throttle windows can't block anything; drop them so the table
  // doesn't grow one row per (email, IP) pair seen forever.
  await pruneThrottles();

  const due = await db
    .select()
    .from(connections)
    .where(and(eq(connections.status, "disconnected"), lte(connections.purgeAfter, new Date())));
  if (due.length === 0) return;
  console.log(`[worker] purge: ${due.length} connection(s)`);
  for (const it of due) {
    await db.delete(connections).where(eq(connections.id, it.id));
    await db.insert(auditLog).values({
      userId: it.userId,
      kind: "simplefin.purge",
      actor: "worker",
      target: it.id,
    });
  }
}

async function runAssetRefresh() {
  try {
    const result = await refreshAllRealAssets();
    console.log("[worker] real asset refresh:", result);
    for (const userId of result.refreshedUserIds) {
      try {
        await snapshotNetWorthForUser(userId);
      } catch (e) {
        console.error(`[worker] asset snapshot failed for ${userId}:`, e);
      }
    }
  } catch (e) {
    console.error("[worker] real asset refresh failed:", e);
  }
}

async function runDailySnapshots() {
  await snapshotAllUsers();
}

const syncCron = process.env.OPENCOFFER_SYNC_CRON || process.env.OPENFINANCE_SYNC_CRON || "*/30 * * * *";
const assetRefreshCron = process.env.OPENCOFFER_ASSET_REFRESH_CRON || "0 3 * * 0";
cron.schedule(syncCron, runFrequentSync); // every 30 min by default
cron.schedule("0 * * * *", runRetentionPurge); // top of every hour
cron.schedule(assetRefreshCron, runAssetRefresh); // weekly by default
cron.schedule("15 0 * * *", runDailySnapshots); // daily snapshot for all users

console.log(`[worker] started (sync cron: ${syncCron}; asset refresh cron: ${assetRefreshCron})`);
// Keep the process alive even if cron has no immediate work.
setInterval(() => {}, 1 << 30);
