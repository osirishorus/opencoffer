#!/usr/bin/env node
/**
 * MCP tool integration test runner.
 *
 * Creates a disposable `opencoffer_test` database next to the configured one,
 * runs migrations into it, executes the integration suite against it, then
 * drops it. The real database is never touched — the suite itself also
 * refuses to run unless DATABASE_URL points at *opencoffer_test*.
 *
 * Run inside the web container (has node_modules + network to postgres):
 *
 *   docker compose run --rm --no-deps \
 *     -v "$PWD/src":/app/src -v "$PWD/scripts":/app/scripts \
 *     web node scripts/test-mcp.mjs
 *
 * Or in local dev (Postgres on localhost): node scripts/test-mcp.mjs
 */
import { spawnSync } from "node:child_process";
import pg from "pg";

const baseUrl = process.env.DATABASE_URL ?? "postgres://opencoffer:opencoffer@postgres:5432/opencoffer";
const u = new URL(baseUrl);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const testUrl = new URL(baseUrl);
testUrl.pathname = "/opencoffer_test";

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
console.log(`[test-mcp] recreating opencoffer_test on ${u.host}`);
await admin.query("drop database if exists opencoffer_test");
await admin.query("create database opencoffer_test");
await admin.end();

const env = { ...process.env, DATABASE_URL: testUrl.toString(), OPENCOFFER_MCP_TEST: "1" };

console.log("[test-mcp] running migrations");
const mig = spawnSync("./node_modules/.bin/drizzle-kit", ["migrate"], { env, stdio: "inherit" });
if (mig.status !== 0) process.exit(mig.status ?? 1);

console.log("[test-mcp] running suite");
const run = spawnSync(
  "node",
  [
    "--import", "tsx", "--test",
    "src/lib/mcp/mcp-tools.test.ts",
    "src/lib/finance/app-db.test.ts",
  ],
  { env, stdio: "inherit" },
);

const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
await cleanup.connect();
await cleanup.query("drop database if exists opencoffer_test with (force)").catch(() => {});
await cleanup.end();

process.exit(run.status ?? 1);
