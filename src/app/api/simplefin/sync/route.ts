import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { connections } from "@/lib/db/schema";
import { syncConnection, syncAllForUser } from "@/lib/simplefin/sync";
import { throttle } from "@/lib/auth/throttle";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Each sync fans out to the SimpleFIN bridge, so an unthrottled endpoint lets a
 * logged-in tab (or a stuck retry loop) hammer a third party we don't own and
 * burn its quota. The client-side lock in DataAutoRefresh is a courtesy, not a
 * control — this is the one that counts.
 */
const SYNC_MAX_PER_WINDOW = 12;
const SYNC_WINDOW_SECONDS = 15 * 60;

const FINANCE_PATHS = [
  "/dashboard",
  "/dashboard/charts",
  "/dashboard/subscriptions",
  "/dashboard/investments",
  "/settings/accounts",
  "/settings/connections",
];

function revalidateFinancePaths() {
  for (const path of FINANCE_PATHS) revalidatePath(path);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const connectionId = url.searchParams.get("connectionId");
  const staleMinutes = Number(url.searchParams.get("staleMinutes") ?? "0");

  const gate = await throttle(
    `sync:${session.user.id}`,
    SYNC_MAX_PER_WINDOW,
    SYNC_WINDOW_SECONDS,
  );
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many sync requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(gate.retryAfterSeconds) } },
    );
  }

  try {
    let synced = 0;
    let skipped = 0;
    if (connectionId) {
      const [conn] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.id, connectionId), eq(connections.userId, session.user.id)))
        .limit(1);
      if (!conn) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (staleMinutes > 0 && conn.lastSyncedAt) {
        const cutoff = Date.now() - staleMinutes * 60_000;
        if (conn.lastSyncedAt.getTime() > cutoff) skipped++;
        else {
          await syncConnection(conn.id, { runAnalysis: staleMinutes <= 0 });
          synced++;
        }
      } else {
        await syncConnection(conn.id);
        synced++;
      }
    } else {
      if (staleMinutes > 0) {
        const cutoff = new Date(Date.now() - staleMinutes * 60_000);
        const active = await db
          .select()
          .from(connections)
          .where(
            and(
              eq(connections.userId, session.user.id),
              eq(connections.status, "active"),
            ),
          );
        for (const conn of active) {
          if (!conn.lastSyncedAt || conn.lastSyncedAt < cutoff) {
            await syncConnection(conn.id, { runAnalysis: false });
            synced++;
          } else {
            skipped++;
          }
        }
      } else {
        const r = await syncAllForUser(session.user.id);
        synced = r.synced;
      }
    }
    if (synced > 0) revalidateFinancePaths();
    return NextResponse.json({ ok: true, synced, skipped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "sync failed";
    console.error("simplefin sync failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
