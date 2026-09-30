import NextAuth from "next-auth";
import type { Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db/client";
import { users, accounts, sessions, verificationTokens } from "@/lib/db/schema";
import { authConfig } from "@/auth.config";
import { impersonationEmailFor } from "@/lib/devImpersonation";
import {
  LOGIN_WINDOW_SECONDS,
  MAX_ATTEMPTS,
  MAX_ATTEMPTS_PER_IP,
  clientIpFrom,
  loginRateKey,
} from "@/lib/auth/rateLimit";
import { clearThrottle, throttle } from "@/lib/auth/throttle";

async function requestIp(): Promise<string> {
  try {
    return clientIpFrom(await headers());
  } catch {
    // headers() throws outside a request scope (e.g. unit tests).
    return "unknown";
  }
}

const nextAuth = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = String(credentials?.email ?? "").toLowerCase().trim();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;
        const ip = await requestIp();
        const ipKey = `login:ip:${ip}`;
        const userKey = `login:${loginRateKey(email, ip)}`;

        const byIp = await throttle(ipKey, MAX_ATTEMPTS_PER_IP, LOGIN_WINDOW_SECONDS);
        if (!byIp.allowed) return null;
        const byUser = await throttle(userKey, MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS);
        if (!byUser.allowed) return null;

        const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!u || !u.passwordHash) return null;
        const ok = await bcrypt.compare(password, u.passwordHash);
        if (!ok) return null;

        await Promise.all([clearThrottle(userKey), clearThrottle(ipKey)]);
        return { id: u.id, email: u.email, name: u.name };
      },
    }),
  ],
});

export const { handlers, signIn, signOut } = nextAuth;

/**
 * Wrapped auth(): when dev-impersonation gates pass and a valid email header
 * is present, synthesize a session for that user without going through the
 * normal NextAuth flow. Otherwise behaves identically to the original.
 *
 * Gates checked inside impersonationEmailFor():
 *   - NODE_ENV === "development"
 *   - ALLOW_DEV_IMPERSONATION === "1"
 *   - header `x-dev-impersonate: <email>` in DEV_IMPERSONATE_ALLOWED
 */
export const auth = (async (): Promise<Session | null> => {
  // Server-only: pull headers from the current request.
  try {
    const h = await headers();
    const email = impersonationEmailFor(h);
    if (email) {
      const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (u) {
        // Big warning trail so we never miss when this is active.
        console.warn("[dev-impersonation] serving request as", email, "(user.id =", u.id + ")");
        return {
          user: { id: u.id, email: u.email, name: u.name ?? null, image: null },
          expires: new Date(Date.now() + 30 * 60_000).toISOString(),
        } as Session;
      }
    }
  } catch {
    // headers() throws outside request scope — fall through to real auth.
  }
  return nextAuth.auth();
}) as typeof nextAuth.auth;
