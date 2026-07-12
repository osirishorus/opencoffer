import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness/readiness probe for Docker healthchecks and
 * uptime monitors. Deliberately minimal — reveals nothing about the data.
 * Per-user sync-staleness alerting lives in the `sync_stale` alert rule.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: true, time: new Date().toISOString() });
  } catch {
    return NextResponse.json({ ok: false, db: false }, { status: 503 });
  }
}
