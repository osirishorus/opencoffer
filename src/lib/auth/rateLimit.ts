type RateLimitEntry = {
  attempts: number[];
};

export const LOGIN_WINDOW_SECONDS = 15 * 60;
const WINDOW_MS = LOGIN_WINDOW_SECONDS * 1000;
export const MAX_ATTEMPTS = 5;

/**
 * Per-IP ceiling. Higher than the per-identity limit so a household behind one
 * NAT can still sign several people in, but low enough to stop credential
 * spraying across many emails from a single source.
 */
export const MAX_ATTEMPTS_PER_IP = 30;

function prune(entry: RateLimitEntry, now: number) {
  entry.attempts = entry.attempts.filter((attempt) => now - attempt < WINDOW_MS);
}

export function rateLimitAttempt(
  store: Map<string, RateLimitEntry>,
  key: string,
  now = Date.now(),
  max = MAX_ATTEMPTS,
): boolean {
  const entry = store.get(key) ?? { attempts: [] };
  prune(entry, now);
  if (entry.attempts.length >= max) {
    store.set(key, entry);
    return false;
  }
  entry.attempts.push(now);
  store.set(key, entry);
  return true;
}

export function clearRateLimit(store: Map<string, RateLimitEntry>, key: string) {
  store.delete(key);
}

/**
 * Throttle key for a login attempt.
 *
 * Deliberately scoped to (email, source IP) rather than email alone. Keying on
 * email by itself lets anyone who knows your address lock you out of your own
 * account for 15 minutes just by failing five logins — a trivial denial of
 * service. Pairing it with the source IP keeps brute force against a single
 * account expensive while leaving the real owner's own attempts unaffected.
 */
export function loginRateKey(email: string, ip: string): string {
  return `${email}|${ip}`;
}

/**
 * Best-effort client IP. Behind a reverse proxy the left-most x-forwarded-for
 * entry is the original client; direct connections fall back to a constant so
 * every attempt still shares one bucket rather than none.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export type RateLimitStore = Map<string, RateLimitEntry>;
