/**
 * Dev-only impersonation helper.
 *
 * This is a header-driven authentication bypass. It exists so an E2E runner
 * (Playwright) can be granted access to a specific local account without ever
 * handling the password. It must never be reachable on an internet-facing
 * deployment.
 *
 * A request is treated as authenticated only when ALL of the following hold:
 *
 *   1. ALLOW_DEV_IMPERSONATION === "1"
 *   2. DEV_IMPERSONATE_SECRET is set and at least 16 characters
 *   3. The request carries `x-dev-impersonate-secret` matching that value
 *   4. The request carries `x-dev-impersonate: <email>`
 *   5. That email is listed in DEV_IMPERSONATE_ALLOWED (comma-separated)
 *
 * The shared secret (2 + 3) is what keeps a stray `ALLOW_DEV_IMPERSONATION=1`
 * in a production .env from becoming account takeover for anyone who can guess
 * the owner's email address. Any single failed gate disables the feature;
 * remove the env vars entirely when you're done with them.
 *
 * The NODE_ENV check that used to guard this was dropped because `next start`
 * reports "production" even on a local machine, which made it useless as a
 * signal. The secret replaces it.
 */

const ALLOWED_ENV = process.env.DEV_IMPERSONATE_ALLOWED ?? "";
const ALLOW_FLAG = process.env.ALLOW_DEV_IMPERSONATION === "1";
const SECRET = process.env.DEV_IMPERSONATE_SECRET ?? "";
const MIN_SECRET_LENGTH = 16;

/**
 * Constant-time string compare. Avoids node:crypto so this module stays
 * importable from the edge middleware.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns the email to impersonate as, or null if any gate fails. */
export function impersonationEmailFor(headers: Headers): string | null {
  if (!ALLOW_FLAG) return null;
  if (SECRET.length < MIN_SECRET_LENGTH) return null;

  const presented = headers.get("x-dev-impersonate-secret") ?? "";
  if (!safeEqual(presented, SECRET)) return null;

  const requested = headers.get("x-dev-impersonate")?.toLowerCase().trim();
  if (!requested) return null;

  const allowed = ALLOWED_ENV.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(requested)) return null;

  return requested;
}

/** Lightweight check used by edge middleware (no DB hit). */
export function impersonationGatesPass(headers: Headers): boolean {
  return impersonationEmailFor(headers) !== null;
}

/**
 * True when the feature is switched on but misconfigured — lets callers warn
 * loudly instead of silently rejecting every impersonation attempt.
 */
export function impersonationMisconfigured(): boolean {
  return ALLOW_FLAG && SECRET.length < MIN_SECRET_LENGTH;
}
