import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ATTEMPTS,
  clearRateLimit,
  clientIpFrom,
  loginRateKey,
  rateLimitAttempt,
  type RateLimitStore,
} from "./rateLimit";

const headers = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

test("rateLimitAttempt blocks after the configured number of attempts", () => {
  const store: RateLimitStore = new Map();
  const now = Date.now();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    assert.equal(rateLimitAttempt(store, "k", now), true, `attempt ${i + 1} should pass`);
  }
  assert.equal(rateLimitAttempt(store, "k", now), false);
});

test("rateLimitAttempt honours a custom max", () => {
  const store: RateLimitStore = new Map();
  const now = Date.now();
  assert.equal(rateLimitAttempt(store, "k", now, 2), true);
  assert.equal(rateLimitAttempt(store, "k", now, 2), true);
  assert.equal(rateLimitAttempt(store, "k", now, 2), false);
});

test("attempts outside the 15-minute window are pruned", () => {
  const store: RateLimitStore = new Map();
  const start = Date.now();
  for (let i = 0; i < MAX_ATTEMPTS; i++) rateLimitAttempt(store, "k", start);
  assert.equal(rateLimitAttempt(store, "k", start), false);
  assert.equal(rateLimitAttempt(store, "k", start + 15 * 60_000 + 1), true);
});

test("clearRateLimit resets a key after a successful login", () => {
  const store: RateLimitStore = new Map();
  const now = Date.now();
  for (let i = 0; i < MAX_ATTEMPTS; i++) rateLimitAttempt(store, "k", now);
  clearRateLimit(store, "k");
  assert.equal(rateLimitAttempt(store, "k", now), true);
});

test("a remote attacker cannot lock the owner out of their own account", () => {
  const store: RateLimitStore = new Map();
  const now = Date.now();
  const email = "owner@example.com";
  const attacker = loginRateKey(email, "203.0.113.9");
  const owner = loginRateKey(email, "192.168.1.5");

  for (let i = 0; i < MAX_ATTEMPTS; i++) rateLimitAttempt(store, attacker, now);
  assert.equal(rateLimitAttempt(store, attacker, now), false, "attacker is throttled");
  assert.equal(rateLimitAttempt(store, owner, now), true, "owner is unaffected");
});

test("clientIpFrom prefers the left-most x-forwarded-for entry", () => {
  assert.equal(
    clientIpFrom(headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1, 10.0.0.2" })),
    "198.51.100.7",
  );
  assert.equal(clientIpFrom(headers({ "x-real-ip": "198.51.100.8" })), "198.51.100.8");
  assert.equal(clientIpFrom(headers({})), "unknown");
});
