import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

/**
 * Durable, cross-process rate limiting backed by Postgres.
 *
 * The in-memory version this replaces had two holes: the web and worker
 * processes kept separate counters, and a restart reset every budget to zero.
 * Both are trivially exploitable on a long-lived deployment.
 *
 * The whole check is one statement so concurrent requests cannot interleave a
 * read and a write and slip past the cap — the row lock taken by ON CONFLICT
 * serializes them.
 */

export type ThrottleResult = {
  allowed: boolean;
  /** Attempts used in the current window, including this one. */
  count: number;
  /** Seconds until the window resets. 0 when the request was allowed. */
  retryAfterSeconds: number;
};

/**
 * Records an attempt against `key` and reports whether it is within `max` for
 * the trailing `windowSeconds`.
 *
 * Fails open: if the database is unreachable we allow the request rather than
 * locking every user out of their own self-hosted app. Throttling is a
 * mitigation here, not the primary access control — the password check and
 * session validation still stand on their own.
 */
export async function throttle(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<ThrottleResult> {
  try {
    const rows = await db.execute<{ count: number; age_seconds: number }>(sql`
      insert into rate_limits (key, count, window_start)
      values (${key}, 1, now())
      on conflict (key) do update set
        count = case
          when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          then 1
          else rate_limits.count + 1
        end,
        window_start = case
          when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          then now()
          else rate_limits.window_start
        end
      returning count, extract(epoch from (now() - window_start))::int as age_seconds
    `);

    const row = rows.rows[0];
    if (!row) return { allowed: true, count: 0, retryAfterSeconds: 0 };

    const count = Number(row.count);
    const allowed = count <= max;
    return {
      allowed,
      count,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, windowSeconds - Number(row.age_seconds ?? 0)),
    };
  } catch (error) {
    console.error("[throttle] rate-limit check failed, allowing request:", error);
    return { allowed: true, count: 0, retryAfterSeconds: 0 };
  }
}

/** Clears a bucket — call after a success so a good login resets the budget. */
export async function clearThrottle(key: string): Promise<void> {
  try {
    await db.execute(sql`delete from rate_limits where key = ${key}`);
  } catch (error) {
    console.error("[throttle] failed to clear bucket:", error);
  }
}

/** Drops windows that can no longer block anything. Called by the worker. */
export async function pruneThrottles(olderThanSeconds = 86_400): Promise<void> {
  try {
    await db.execute(
      sql`delete from rate_limits where window_start < now() - make_interval(secs => ${olderThanSeconds})`,
    );
  } catch (error) {
    console.error("[throttle] prune failed:", error);
  }
}
