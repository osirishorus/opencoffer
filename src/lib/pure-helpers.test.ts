/**
 * Unit tests for pure helpers: CSV escaping/parsing, crypto round-trips,
 * login rate limiting, chat-history normalization, category-rule matching,
 * LLM verdict parsing, SimpleFIN transfer heuristics, notification payload
 * builders, and display classification. No database required.
 */
import test from "node:test";
import assert from "node:assert/strict";

// crypto.ts reads APP_ENCRYPTION_KEY lazily — set a fixed test key before use.
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

test("csv: escapeCsvField", async () => {
  const { escapeCsvField } = await import("@/lib/csv");
  assert.equal(escapeCsvField("plain"), "plain");
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField("a,b"), '"a,b"');
  assert.equal(escapeCsvField("line1\nline2"), '"line1\nline2"');
  assert.equal(escapeCsvField(null), "");
  assert.equal(escapeCsvField(12.5), "12.5");
});

test("csv: parseCsv handles quotes, commas, CRLF", async () => {
  const { parseCsv } = await import("@/lib/csv");
  const parsed = parseCsv('name,amount\r\n"Whole, Foods","-50"\r\n"say ""hi""",3\r\n');
  assert.deepEqual(parsed.headers ?? parsed.rows?.[0] ?? parsed, parsed.headers ? parsed.headers : parsed);
  const rows = (parsed as { rows: string[][] }).rows;
  const headers = (parsed as { headers: string[] }).headers;
  assert.deepEqual(headers, ["name", "amount"]);
  assert.deepEqual(rows[0], ["Whole, Foods", "-50"]);
  assert.deepEqual(rows[1], ['say "hi"', "3"]);
});

test("crypto: encrypt/decrypt round-trip and tamper detection", async () => {
  const { encrypt, decrypt, hashToken, generateToken } = await import("@/lib/crypto");
  const secret = "https://user:pass@bridge.simplefin.org/simplefin";
  const cipher = encrypt(secret);
  assert.notEqual(cipher, secret);
  assert.equal(decrypt(cipher), secret);
  assert.notEqual(encrypt(secret), cipher, "fresh IV per encryption");
  const buf = Buffer.from(cipher, "base64");
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => decrypt(buf.toString("base64")), "tampered ciphertext must not decrypt");

  const { token, hash, prefix } = generateToken();
  assert.match(token, /^oc_[A-Za-z0-9_-]{40,}$/);
  assert.equal(hash, hashToken(token));
  assert.equal(prefix, token.slice(0, 11));
});

test("auth: rateLimitAttempt window and lockout", async () => {
  const { rateLimitAttempt, clearRateLimit } = await import("@/lib/auth/rateLimit");
  const store = new Map();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(rateLimitAttempt(store, "ip", t0 + i), true);
  assert.equal(rateLimitAttempt(store, "ip", t0 + 5), false, "6th attempt within window blocked");
  assert.equal(rateLimitAttempt(store, "other", t0 + 5), true, "other keys unaffected");
  assert.equal(rateLimitAttempt(store, "ip", t0 + 15 * 60 * 1000 + 1), true, "window expiry unblocks");
  clearRateLimit(store, "other");
  assert.equal(store.has("other"), false);
});

test("chat history: text extraction and title hygiene", async () => {
  const { textFromMessageContent, titleFromMessage, cleanGeneratedTitle } = await import("@/lib/chat/history");
  assert.equal(textFromMessageContent("plain text"), "plain text");
  assert.equal(textFromMessageContent([{ type: "text", text: "part 1" }, { type: "text", text: "part 2" }]).includes("part 1"), true);
  assert.equal(textFromMessageContent(null), "");
  assert.equal(textFromMessageContent(42 as unknown), "42", "non-null unknowns JSON-stringified");
  const title = titleFromMessage("How much did I spend on groceries last month and the month before that, broken down weekly?");
  assert.ok(title.length <= 80, `title should be truncated, got ${title.length} chars`);
  assert.equal(cleanGeneratedTitle('"Grocery spending"', "fallback"), "Grocery spending");
  assert.equal(cleanGeneratedTitle("", "fallback"), "fallback");
});

test("rules: matchesCategoryRule semantics", async () => {
  const { matchesCategoryRule } = await import("@/lib/finance/rules");
  const tx = { merchantName: "Starbucks #123", name: "STARBUCKS STORE 123" };
  assert.equal(matchesCategoryRule({ field: "merchant", matchType: "contains", pattern: "starbucks" }, tx), true, "case-insensitive contains");
  assert.equal(matchesCategoryRule({ field: "merchant", matchType: "equals", pattern: "starbucks #123" }, tx), true, "case-insensitive equals");
  assert.equal(matchesCategoryRule({ field: "merchant", matchType: "equals", pattern: "starbucks" }, tx), false);
  assert.equal(matchesCategoryRule({ field: "name", matchType: "contains", pattern: "store 123" }, tx), true);
  assert.equal(matchesCategoryRule({ field: "merchant", matchType: "contains", pattern: "star" }, { merchantName: null, name: "x" }), false, "null merchant never matches");
  assert.equal(matchesCategoryRule({ field: "name", matchType: "contains", pattern: "   " }, tx), false, "blank pattern never matches");
});

test("categorize: parseVerdicts robustness", async () => {
  const { parseVerdicts } = await import("@/lib/finance/categorize");
  const good = [{ id: "a", category: "Groceries", subcategory: "whole foods", is_transfer: false, is_recurring: false, recurrence_cadence: null, confidence: 0.9 }];
  assert.equal(parseVerdicts(JSON.stringify(good)).length, 1, "bare JSON array");
  assert.equal(parseVerdicts("```json\n" + JSON.stringify(good) + "\n```").length, 1, "fenced JSON");
  assert.equal(parseVerdicts("Here are the results:\n" + JSON.stringify(good) + "\nDone!").length, 1, "prose-wrapped JSON");
  assert.equal(parseVerdicts(JSON.stringify([{ id: "a", category: "Not A Real Category" }])).length, 0, "unknown category dropped");
  assert.equal(parseVerdicts(JSON.stringify([{ category: "Groceries" }])).length, 0, "missing id dropped");
  assert.equal(parseVerdicts("total garbage").length, 0);
  assert.equal(parseVerdicts(JSON.stringify({ id: "a" })).length, 0, "non-array rejected");
  const long = parseVerdicts(JSON.stringify([{ id: "a", category: "Groceries", subcategory: "x".repeat(200) }]));
  assert.equal(long[0].subcategory!.length, 64, "subcategory truncated");
  assert.equal(long[0].confidence, 0.5, "missing confidence defaults to 0.5");
});

test("simplefin: isTransferTransaction heuristic", async () => {
  const { isTransferTransaction } = await import("@/lib/simplefin/client");
  const tx = (over: Record<string, unknown>) => ({ id: "1", posted: 1, amount: "-10", description: "", ...over }) as never;
  assert.equal(isTransferTransaction(tx({ amount: "500", description: "refund" }), "credit"), true, "any credit-card inflow is a payment/refund");
  assert.equal(isTransferTransaction(tx({ description: "Payment Thank You - Web" }), "depository"), true);
  assert.equal(isTransferTransaction(tx({ description: "CHASE CREDIT CRD AUTOPAY" }), "depository"), true);
  assert.equal(isTransferTransaction(tx({ description: "Online payment to CRD 9999" }), "depository"), true);
  assert.equal(isTransferTransaction(tx({ description: "Zelle payment to Jing Le for rent" }), "depository"), false, "P2P rent payment is real spending");
  assert.equal(isTransferTransaction(tx({ description: "WHOLE FOODS 123" }), "credit"), false, "card purchase is not a transfer");
  assert.equal(isTransferTransaction(tx({ amount: "3000", description: "ACME PAYROLL" }), "depository"), false, "payroll is income");
});

test("notifications: buildNotificationRequest payloads", async () => {
  const { buildNotificationRequest } = await import("@/lib/notifications/deliver");
  const alert = { id: "a1", kind: "large_tx", title: "Large spend: $500", body: "ACME GARDEN SUPPLY", createdAt: new Date("2026-07-11T00:00:00Z") };
  const ntfy = buildNotificationRequest({ kind: "ntfy", config: { url: "https://ntfy.sh/", topic: "money alerts", authToken: "tk" } }, alert);
  assert.equal(ntfy.url, "https://ntfy.sh/money%20alerts", "topic URL-encoded and joined");
  assert.equal(ntfy.headers.Title, alert.title);
  assert.equal(ntfy.headers.Authorization, "Bearer tk");
  assert.equal(ntfy.body, "ACME GARDEN SUPPLY");
  const discord = buildNotificationRequest({ kind: "discord", config: { url: "https://discord/hook" } }, alert);
  assert.deepEqual(JSON.parse(discord.body), { content: "Large spend: $500\nACME GARDEN SUPPLY" });
  const slack = buildNotificationRequest({ kind: "slack", config: { url: "https://slack/hook" } }, alert);
  assert.deepEqual(JSON.parse(slack.body), { text: "Large spend: $500\nACME GARDEN SUPPLY" });
  const hook = buildNotificationRequest({ kind: "webhook", config: { url: "https://x/hook" } }, alert);
  const payload = JSON.parse(hook.body);
  assert.equal(payload.title, alert.title);
  assert.equal(payload.severity, "large_tx");
  assert.equal(payload.createdAt, "2026-07-11T00:00:00.000Z");

  const push = buildNotificationRequest(
    { kind: "pushover", config: { url: "", authToken: "app-token", userKey: "user-key" } },
    alert,
  );
  assert.equal(push.url, "https://api.pushover.net/1/messages.json", "empty url falls back to the official endpoint");
  const pushBody = JSON.parse(push.body);
  assert.equal(pushBody.token, "app-token");
  assert.equal(pushBody.user, "user-key");
  assert.equal(pushBody.title, alert.title);
  assert.equal(pushBody.message, "ACME GARDEN SUPPLY");
});

test("import rows: identity derivation and transfer heuristic", async () => {
  const { externalId, deriveImportIsTransfer } = await import("@/lib/finance/importRows");
  const base = { date: "2024-03-01", amount: -4.5, name: "STARBUCKS STORE 08882" };
  assert.equal(externalId(base), externalId({ ...base }), "content identity is deterministic");
  assert.equal(
    externalId(base),
    externalId({ ...base, reference: null }),
    "null reference keeps the legacy hash (pre-reference imports still dedupe)",
  );
  assert.notEqual(
    externalId({ ...base, reference: "240301002" }),
    externalId({ ...base, reference: "240301003" }),
    "distinct references give identical rows distinct identity",
  );
  assert.notEqual(externalId(base), externalId({ ...base, amount: -4.51 }));

  assert.equal(deriveImportIsTransfer({ ...base, amount: 500, name: "Payment Thank You - Web" }, "credit"), true);
  assert.equal(deriveImportIsTransfer({ ...base, name: "CHASE AUTOPAY 9999" }, "depository"), true);
  assert.equal(deriveImportIsTransfer({ ...base, amount: 120, name: "REFUND AMAZON" }, "credit"), true, "credit inflow is payment/refund");
  assert.equal(deriveImportIsTransfer(base, "credit"), false, "purchase is not a transfer");
  assert.equal(deriveImportIsTransfer({ ...base, amount: 3000, name: "ACME PAYROLL" }, "depository"), false);
});

test("display: category normalization and outflow classification", async () => {
  const d = await import("@/lib/finance/display");
  assert.equal(d.normalizeCategoryName("  "), "Uncategorized");
  assert.equal(d.effectiveCategoryFromParts({ overrideCategory: "Travel", aiCategory: "Shopping", rawCategory: "Misc" }), "Travel");
  assert.equal(d.effectiveCategoryFromParts({ aiCategory: null, rawCategory: null }), "Uncategorized");
  assert.equal(d.classifyOutflowKind({ category: "Groceries", isTransfer: false }), "consumption");
  assert.equal(d.classifyOutflowKind({ category: "Retirement Contributions", isTransfer: false }), "savings");
  assert.equal(d.classifyOutflowKind({ category: "Groceries", isTransfer: true }), "transfer");
  assert.equal(d.classifyOutflowKind({ category: "Income — Salary", isTransfer: false }), "income");
  assert.equal(d.classifyOutflowKind({ category: "Income - Salary", isTransfer: false }), "income", "hyphen variant normalized to em-dash");
  assert.equal(d.dateWindowLabel(30), "Last 1 month");
  assert.equal(d.dateWindowLabel(365), "Last 1 year");
  assert.equal(d.dateWindowLabel(45), "Last 45 days");
});
