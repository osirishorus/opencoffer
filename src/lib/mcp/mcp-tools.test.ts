/**
 * Integration suite for the 38 MCP finance tools + the MCP JSON-RPC server.
 *
 * Runs against a dedicated `opencoffer_test` database seeded with a fixture
 * set designed to exercise the semantics the tools document:
 *   - household visibility (two members share, outsiders never leak)
 *   - category / merchant / is_transfer override precedence
 *   - transfer + pending exclusion in aggregates
 *   - pagination envelopes and historical from/to reach
 *   - MCP protocol invariants (schema advertisement, structuredContent)
 *
 * Launch via scripts/test-mcp.mjs — do not point this at a real database.
 * The suite refuses to run unless DATABASE_URL contains "opencoffer_test".
 */
import test from "node:test";
import assert from "node:assert/strict";

const ENABLED = process.env.OPENCOFFER_MCP_TEST === "1";
const DB_URL = process.env.DATABASE_URL ?? "";

test("mcp tool integration", { skip: !ENABLED ? "run via scripts/test-mcp.mjs" : false }, async (t) => {
  assert.ok(DB_URL.includes("opencoffer_test"), "refusing to run against a non-test database");

  const { db } = await import("@/lib/db/client");
  const s = await import("@/lib/db/schema");
  const { financeTools, findTool } = await import("@/lib/finance/tools");
  const { handleMcpRequest } = await import("@/lib/mcp/server");

  /* ------------------------------------------------------------------ */
  /* Fixtures                                                            */
  /* ------------------------------------------------------------------ */

  const DAY = 86_400_000;
  const d = (n: number) => new Date(Date.now() - n * DAY);

  // Users + households
  const [u1] = await db.insert(s.users).values({ email: "u1@test.local", name: "U1" }).returning();
  const [u2] = await db.insert(s.users).values({ email: "u2@test.local", name: "U2" }).returning();
  const [u3] = await db.insert(s.users).values({ email: "u3@test.local", name: "Outsider" }).returning();
  const [h1] = await db.insert(s.households).values({ ownerUserId: u1.id }).returning();
  const [h3] = await db.insert(s.households).values({ ownerUserId: u3.id }).returning();
  await db.insert(s.householdMembers).values([
    { householdId: h1.id, userId: u1.id, role: "owner" },
    { householdId: h1.id, userId: u2.id, role: "member" },
    { householdId: h3.id, userId: u3.id, role: "owner" },
  ]);
  const { eq, inArray } = await import("drizzle-orm");
  await db.update(s.users).set({ householdId: h1.id }).where(inArray(s.users.id, [u1.id, u2.id]));
  await db.update(s.users).set({ householdId: h3.id }).where(eq(s.users.id, u3.id));

  // Accounts
  const acct = async (userId: string, v: Partial<typeof s.financialAccounts.$inferInsert>) => {
    const [row] = await db
      .insert(s.financialAccounts)
      .values({
        userId,
        externalAccountId: `ext-${Math.random().toString(36).slice(2)}`,
        name: v.name!,
        type: v.type!,
        subtype: v.subtype ?? null,
        accountGroup: v.accountGroup ?? "other",
        userAccountGroup: v.userAccountGroup ?? null,
        currentBalance: v.currentBalance ?? "0",
        source: "simplefin",
      })
      .returning();
    return row;
  };
  const CHK = await acct(u1.id, { name: "Test Checking (1111)", type: "depository", subtype: "checking", accountGroup: "cash", currentBalance: "5000" });
  const CC = await acct(u1.id, { name: "Test Card (2222)", type: "credit", subtype: "credit card", accountGroup: "credit", currentBalance: "-1000" });
  const BRK = await acct(u1.id, { name: "Test Brokerage (3333)", type: "investment", accountGroup: "brokerage", currentBalance: "10000" });
  const K401 = await acct(u1.id, { name: "Test 401k (4444)", type: "investment", accountGroup: "retirement", currentBalance: "20000" });
  // Depository-typed card the user re-grouped to credit — exercises the
  // effective-group classification in get_net_worth / get_balances_by_group.
  await acct(u1.id, { name: "Regrouped Card (5555)", type: "depository", subtype: "checking", accountGroup: "cash", userAccountGroup: "credit", currentBalance: "-200" });
  const CHK2 = await acct(u2.id, { name: "Partner Checking (6666)", type: "depository", accountGroup: "cash", currentBalance: "2000" });
  const CHK3 = await acct(u3.id, { name: "Outsider Checking (7777)", type: "depository", accountGroup: "cash", currentBalance: "500" });

  // Transactions
  type TxFix = {
    acct: typeof CHK; user?: string; d: number | Date; amt: string; name: string;
    merchant?: string; ai?: string; overrideCategory?: string; overrideMerchant?: string;
    overrideIsTransfer?: boolean; isTransfer?: boolean; pending?: boolean; recurring?: string;
  };
  const TXS: TxFix[] = [
    { acct: CHK, d: 1, amt: "3000", name: "ACME PAYROLL", ai: "Income — Salary" },
    { acct: CC, d: 2, amt: "-50", name: "WHOLE FOODS 123", merchant: "Whole Foods", ai: "Groceries" },
    { acct: CC, d: 2, amt: "-30.25", name: "TARGET T-1234", merchant: "Target", ai: "Shopping" },
    { acct: CHK, d: 3, amt: "-1200", name: "RENT LLC", merchant: "Rent LLC", ai: "Rent & Mortgage", recurring: "monthly" },
    { acct: K401, d: 4, amt: "-500", name: "401K CONTRIBUTION", ai: "Retirement Contributions" },
    { acct: CC, d: 5, amt: "-50", name: "WHOLE FOODS 123", merchant: "Whole Foods", ai: "Groceries" },
    { acct: CC, d: 5, amt: "-15.49", name: "NETFLIX.COM", merchant: "Netflix", ai: "Subscriptions", recurring: "monthly" },
    { acct: CHK, d: 6, amt: "-800", name: "CC AUTOPAY", isTransfer: true },
    { acct: CC, d: 6, amt: "800", name: "Payment Thank You", isTransfer: true },
    { acct: CC, d: 7, amt: "-25", name: "PENDING CAFE", ai: "Coffee & Cafes", pending: true },
    { acct: CC, d: 8, amt: "-60", name: "AMAZON MKTP", merchant: "Amazon", ai: "Shopping", overrideCategory: "Travel" },
    { acct: CC, d: 9, amt: "-40", name: "BIG BOX REFUNDABLE", ai: "Shopping", overrideIsTransfer: true },
    { acct: CC, d: 10, amt: "-75", name: "STEAKHOUSE 55", overrideMerchant: "Ruths Chris", ai: "Food & Dining" },
    { acct: CC, d: 35, amt: "-15.49", name: "NETFLIX.COM", merchant: "Netflix", ai: "Subscriptions", recurring: "monthly" },
    { acct: CC, d: 65, amt: "-15.49", name: "NETFLIX.COM", merchant: "Netflix", ai: "Subscriptions", recurring: "monthly" },
    { acct: CC, d: 95, amt: "-15.49", name: "NETFLIX.COM", merchant: "Netflix", ai: "Subscriptions", recurring: "monthly" },
    { acct: CHK, d: 400, amt: "-2000", name: "ANCIENT VENDOR" },
    { acct: CHK, d: new Date(0), amt: "-10", name: "EPOCH GLITCH" },
    { acct: CHK2, user: u2.id, d: 3, amt: "-75", name: "GROCERY MART", merchant: "Grocery Mart", ai: "Groceries" },
    { acct: CHK3, user: u3.id, d: 2, amt: "-999", name: "OUTSIDER STORE" },
  ];
  for (const tx of TXS) {
    await db.insert(s.transactions).values({
      accountId: tx.acct.id,
      userId: tx.user ?? tx.acct.userId,
      externalTxId: `ext-${Math.random().toString(36).slice(2)}`,
      date: tx.d instanceof Date ? tx.d : d(tx.d),
      amount: tx.amt,
      name: tx.name,
      merchantName: tx.merchant ?? null,
      aiCategory: tx.ai ?? null,
      overrideCategory: tx.overrideCategory ?? null,
      overrideMerchant: tx.overrideMerchant ?? null,
      overrideIsTransfer: tx.overrideIsTransfer ?? null,
      isTransfer: tx.isTransfer ?? false,
      pending: tx.pending ?? false,
      isRecurring: !!tx.recurring,
      recurrenceCadence: tx.recurring ?? null,
    });
  }

  // Connection + securities + holdings
  const [conn] = await db.insert(s.connections).values({ userId: u1.id, accessUrlCipher: "test-cipher" }).returning();
  const [aapl] = await db.insert(s.securities).values({ connectionId: conn.id, externalSecurityId: "AAPL", tickerSymbol: "AAPL", name: "Apple Inc", closePrice: "200" }).returning();
  const [vti] = await db.insert(s.securities).values({ connectionId: conn.id, externalSecurityId: "VTI", tickerSymbol: "VTI", name: "Vanguard Total", closePrice: "100" }).returning();
  await db.insert(s.holdings).values([
    { accountId: BRK.id, userId: u1.id, securityId: aapl.id, quantity: "10", costBasis: "1500", institutionPrice: "200", institutionValue: "2000" },
    { accountId: K401.id, userId: u1.id, securityId: vti.id, quantity: "5", costBasis: "600", institutionPrice: "100", institutionValue: "500" },
  ]);

  // Budgets + net-worth snapshots
  await db.insert(s.budgets).values([
    { userId: u1.id, category: "Groceries", monthlyAmount: "200" },
    { userId: u1.id, category: "Food & Dining", monthlyAmount: "100" },
  ]);
  await db.insert(s.netWorthSnapshots).values([1, 2, 3].map((n) => ({
    userId: u1.id, snapshotDate: d(n), assets: String(36000 + n), liabilities: "1200", netWorth: String(34800 + n), byGroup: {},
  })));

  /* ------------------------------------------------------------------ */
  /* Harness                                                             */
  /* ------------------------------------------------------------------ */

  const called = new Set<string>();
  const call = async (name: string, args: Record<string, unknown> = {}, userId = u1.id) => {
    const tool = findTool(name);
    assert.ok(tool, `tool ${name} exists`);
    const parsed = tool!.schema.safeParse(args);
    assert.ok(parsed.success, `${name} accepted args ${JSON.stringify(args)}: ${JSON.stringify(!parsed.success ? parsed.error.issues : "")}`);
    called.add(name);
    return (await tool!.execute(parsed.data, { userId })) as never;
  };
  const near = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 0.005, `${what}: expected ${b}, got ${a}`);
  const mcpCtx = { userId: u1.id, tokenPrefix: "oc_test0000" };
  const rpc = (method: string, params?: unknown) =>
    handleMcpRequest({ jsonrpc: "2.0", id: 1, method, params } as never, mcpCtx);

  /* ------------------------------------------------------------------ */
  /* MCP protocol invariants                                             */
  /* ------------------------------------------------------------------ */

  await t.test("tools/list schema matches validator: optionality + no empty property schemas", async () => {
    const res = (await rpc("tools/list"))!;
    const tools = (res.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, object>; required?: string[] } }> }).tools;
    assert.equal(tools.length, financeTools.length);
    for (const adv of tools) {
      const tool = findTool(adv.name)!;
      const shape = (tool.schema as unknown as { shape: Record<string, { isOptional(): boolean }> }).shape;
      const required = adv.inputSchema.required ?? [];
      for (const [key, field] of Object.entries(shape)) {
        const advertisedOptional = !required.includes(key);
        assert.equal(field.isOptional(), advertisedOptional,
          `${adv.name}.${key}: validator optional=${field.isOptional()} but advertised optional=${advertisedOptional}`);
        const prop = adv.inputSchema.properties?.[key] ?? {};
        assert.ok(Object.keys(prop).length > 0, `${adv.name}.${key} advertised as empty {} schema`);
      }
    }
  });

  await t.test("structuredContent present only for object results", async () => {
    const arr = (await rpc("tools/call", { name: "get_accounts", arguments: {} }))!;
    assert.equal((arr.result as Record<string, unknown>).structuredContent, undefined, "array result must omit structuredContent");
    const obj = (await rpc("tools/call", { name: "get_net_worth", arguments: {} }))!;
    assert.ok((obj.result as Record<string, unknown>).structuredContent, "object result should include structuredContent");
    const text = (obj.result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(JSON.parse(text));
  });

  await t.test("protocol: initialize, ping, resources/prompts, errors", async () => {
    assert.ok(((await rpc("initialize"))!.result as { serverInfo: { name: string } }).serverInfo.name);
    assert.deepEqual((await rpc("ping"))!.result, {});
    assert.deepEqual((await rpc("resources/list"))!.result, { resources: [] });
    assert.deepEqual((await rpc("prompts/list"))!.result, { prompts: [] });
    assert.equal((await rpc("bogus/method"))!.error?.code, -32601);
    assert.equal((await rpc("tools/call", { name: "nope" }))!.error?.code, -32601);
    assert.equal((await rpc("tools/call", { name: "get_recent_transactions", arguments: { days: "NaN" } }))!.error?.code, -32602);
  });

  /* ------------------------------------------------------------------ */
  /* Row tools: envelopes, pagination, overrides, household              */
  /* ------------------------------------------------------------------ */

  type Envelope = { total: number; returned: number; offset: number; truncated: boolean; transactions: Array<Record<string, unknown>> };

  await t.test("get_recent_transactions: envelope + pagination walk", async () => {
    const all: Envelope = await call("get_recent_transactions", { days: 20, limit: 500 });
    assert.equal(all.total, 14, "13 U1 rows + 1 household partner row within 20 days");
    assert.equal(all.truncated, false);
    const ids = new Set<string>();
    let offset = 0;
    for (;;) {
      const page: Envelope = await call("get_recent_transactions", { days: 20, limit: 5, offset });
      page.transactions.forEach((r) => ids.add(r.id as string));
      assert.equal(page.total, 14);
      if (!page.truncated) break;
      offset += 5;
      assert.ok(offset < 100, "pagination must terminate");
    }
    assert.equal(ids.size, 14, "pages cover every row exactly once");
  });

  await t.test("get_recent_transactions: from/to reach beyond 365d and account labels", async () => {
    const old: Envelope = await call("get_recent_transactions", { from: "1970-01-01", to: "1971-01-01", limit: 10 });
    assert.equal(old.total, 1);
    assert.equal(old.transactions[0].name, "EPOCH GLITCH");
    const ancient: Envelope = await call("get_recent_transactions", { days: 3650, limit: 500 });
    assert.ok(ancient.transactions.some((r) => r.name === "ANCIENT VENDOR"));
    const cc: Envelope = await call("get_recent_transactions", { days: 20, accountId: CC.id, limit: 500 });
    assert.ok(cc.transactions.length > 0);
    assert.ok(cc.transactions.every((r) => r.account === "Test Card (2222)"), "every row carries its account name");
  });

  await t.test("get_recent_transactions: override precedence + category filter", async () => {
    const travel: Envelope = await call("get_recent_transactions", { days: 20, category: "Travel", limit: 50 });
    assert.deepEqual(travel.transactions.map((r) => r.name), ["AMAZON MKTP"], "override category wins the filter");
    const shopping: Envelope = await call("get_recent_transactions", { days: 20, category: "Shopping", limit: 50 });
    assert.deepEqual(shopping.transactions.map((r) => r.name).sort(), ["BIG BOX REFUNDABLE", "TARGET T-1234"], "overridden-away rows excluded");
    const bigbox = shopping.transactions.find((r) => r.name === "BIG BOX REFUNDABLE")!;
    assert.equal(bigbox.isTransfer, true, "overrideIsTransfer surfaces");
  });

  await t.test("household isolation: partner visible, outsider never", async () => {
    const everything: Envelope = await call("get_recent_transactions", { from: "1970-01-01", limit: 500 });
    const names = everything.transactions.map((r) => r.name);
    assert.ok(names.includes("GROCERY MART"), "household partner data visible");
    assert.ok(!names.includes("OUTSIDER STORE"), "outsider data must never leak");
    const mine: Envelope = await call("get_recent_transactions", { days: 20, limit: 500 }, u3.id);
    assert.deepEqual(mine.transactions.map((r) => r.name), ["OUTSIDER STORE"]);
  });

  await t.test("search_transactions: override merchant, signed amounts, envelope", async () => {
    const ruth: Envelope = await call("search_transactions", { query: "ruth", limit: 10 });
    assert.equal(ruth.total, 1);
    assert.equal(ruth.transactions[0].merchant, "Ruths Chris");
    const wf: Envelope = await call("search_transactions", { query: "WHOLE", minAmount: -50, maxAmount: -10, limit: 10 });
    assert.equal(wf.total, 2, "signed amount range matches both -50 purchases");
    const epoch: Envelope = await call("search_transactions", { query: "EPOCH", from: "1970-01-01", to: "1970-01-02", limit: 10 });
    assert.equal(epoch.total, 1, "date-bounded search reaches arbitrary history");
  });

  await t.test("get_largest_transactions: honors overrideIsTransfer + precedence", async () => {
    const rows: Array<{ name: string; amount: number; merchant: string | null; category: string | null }> =
      await call("get_largest_transactions", { days: 20, direction: "outflow", limit: 5 });
    assert.deepEqual(rows.slice(0, 3).map((r) => r.name), ["RENT LLC", "401K CONTRIBUTION", "STEAKHOUSE 55"]);
    assert.ok(!rows.some((r) => r.name === "BIG BOX REFUNDABLE"), "override-transfer rows excluded");
    assert.ok(!rows.some((r) => r.name === "PENDING CAFE"), "pending excluded");
    assert.equal(rows.find((r) => r.name === "STEAKHOUSE 55")!.merchant, "Ruths Chris");
    assert.equal(rows.find((r) => r.name === "AMAZON MKTP")?.category, "Travel");
  });

  /* ------------------------------------------------------------------ */
  /* Aggregates                                                          */
  /* ------------------------------------------------------------------ */

  await t.test("get_spending_by_category: consumption semantics", async () => {
    const rows: Array<{ category: string; total: number; count: number }> =
      await call("get_spending_by_category", { days: 20, groupBy: "total", kind: "consumption" });
    const by = new Map(rows.map((r) => [r.category, r]));
    near(by.get("Groceries")!.total, 175, "Groceries includes household partner");
    assert.equal(by.get("Groceries")!.count, 3);
    near(by.get("Travel")!.total, 60, "override category re-bucketed Amazon");
    near(by.get("Shopping")!.total, 30.25, "Shopping excludes overridden + transfer rows");
    near(by.get("Rent & Mortgage")!.total, 1200, "rent");
    assert.ok(!by.has("Retirement Contributions"), "savings kind excluded from consumption");
    assert.ok(!by.has("Coffee & Cafes"), "pending excluded");
    const savings: Array<{ category: string; total: number }> =
      await call("get_spending_by_category", { days: 20, groupBy: "total", kind: "savings" });
    near(savings.find((r) => r.category === "Retirement Contributions")!.total, 500, "savings kind");
  });

  await t.test("get_cash_flow: excludes transfers including overrides", async () => {
    const rows: Array<{ inflow: number; outflow: number; net: number }> =
      await call("get_cash_flow", { days: 20, groupBy: "month" });
    const inflow = rows.reduce((x, r) => x + r.inflow, 0);
    const outflow = rows.reduce((x, r) => x + r.outflow, 0);
    near(inflow, 3000, "inflow = salary only (CC payment credit is transfer)");
    near(outflow, 2055.74, "outflow excludes CC autopay + BIG BOX (override) + pending");
  });

  await t.test("get_consumption_vs_savings + savings rate", async () => {
    const [row]: Array<{ consumption: number; savings: number; income: number; savingsRate: number | null }> =
      await call("get_consumption_vs_savings", { days: 20, groupBy: "total" });
    near(row.consumption, 1555.74, "consumption");
    near(row.savings, 500, "savings");
    near(row.income, 3000, "income");
    // The tool reports savings rate as a rounded PERCENTAGE (16.7), not a ratio.
    near(row.savingsRate ?? 0, Math.round((500 / 3000) * 1000) / 10, "savings rate (percent)");
  });

  await t.test("get_top_merchants: inflow excludes transfer pseudo-income", async () => {
    const inflow: Array<{ merchant: string; total: number }> =
      await call("get_top_merchants", { days: 20, direction: "inflow", limit: 10, kind: "consumption" });
    assert.ok(!inflow.some((m) => m.merchant.includes("Payment")), "CC payment must not rank as income");
    assert.equal(inflow[0].merchant, "ACME PAYROLL");
    const outflow: Array<{ merchant: string; total: number }> =
      await call("get_top_merchants", { days: 20, direction: "outflow", limit: 10, kind: "consumption" });
    const ruths = outflow.find((m) => m.merchant === "Ruths Chris");
    assert.ok(ruths, "override merchant used for grouping");
    near(ruths!.total, 75, "Ruths Chris total");
  });

  await t.test("get_recurring_merchants: multi-month detection", async () => {
    const rows: Array<{ merchant: string; months: number; typicalAmount: number; totalCharges: number }> =
      await call("get_recurring_merchants", { days: 120 });
    const netflix = rows.find((r) => r.merchant === "Netflix");
    assert.ok(netflix, "netflix detected");
    assert.ok(netflix!.months >= 3, "spans several months");
    assert.equal(netflix!.totalCharges, 4);
    near(netflix!.typicalAmount, 15.49, "typical amount = median");
    assert.ok(!rows.some((r) => r.merchant === "Rent LLC"), "single-month merchant not recurring");
  });

  await t.test("compare_periods: window totals", async () => {
    const res: { periodA: { total: number }; periodB: { total: number }; totalDelta: number } =
      await call("compare_periods", { periodADaysAgo: 30, periodBDaysAgo: 0, windowDays: 30 });
    near(res.periodA.total, 15.49, "older window catches the d-35 Netflix charge");
    near(res.periodB.total, 1555.74, "newer window = consumption last 30d");
    near(res.totalDelta, 1555.74 - 15.49, "delta");
  });

  /* ------------------------------------------------------------------ */
  /* Balances, net worth, portfolio, budgets                             */
  /* ------------------------------------------------------------------ */

  await t.test("get_net_worth: effective-group classification", async () => {
    const nw: { assets: number; liabilities: number; netWorth: number; accountCount: number } =
      await call("get_net_worth");
    near(nw.assets, 37000, "assets = 5000 + 10000 + 20000 + partner 2000");
    near(nw.liabilities, 1200, "liabilities include the regrouped depository card");
    near(nw.netWorth, 35800, "net");
    assert.equal(nw.accountCount, 6);
  });

  await t.test("get_balances_by_group: honors user override", async () => {
    const rows: Array<{ group: string; balance: number; accounts: number }> = await call("get_balances_by_group");
    const by = new Map(rows.map((r) => [r.group, r]));
    near(by.get("cash")!.balance, 7000, "cash = U1 checking + partner");
    assert.equal(by.get("credit")!.accounts, 2, "regrouped card counts as credit");
    near(by.get("credit")!.balance, -1200, "credit balance");
    near(by.get("retirement")!.balance, 20000, "retirement");
  });

  await t.test("get_accounts / get_holdings / get_portfolio_summary", async () => {
    const accounts: Array<{ name: string; group: string; userGroupOverride: string | null }> = await call("get_accounts");
    assert.equal(accounts.length, 6);
    const regrouped = accounts.find((a) => a.name.startsWith("Regrouped"))!;
    assert.equal(regrouped.group, "credit");
    assert.equal(regrouped.userGroupOverride, "credit");

    const holdings: Array<{ ticker: string | null; value: number }> = await call("get_holdings", { accountId: BRK.id });
    assert.equal(holdings.length, 1);
    assert.equal(holdings[0].ticker, "AAPL");

    const pf: { totalValue: number; positionsCount: number; topPositions: Array<{ ticker: string | null; unrealizedGain: number | null }> } =
      await call("get_portfolio_summary");
    near(pf.totalValue, 30000, "investment account balances");
    assert.equal(pf.positionsCount, 2);
    assert.equal(pf.topPositions[0].ticker, "AAPL");
    near(pf.topPositions[0].unrealizedGain ?? 0, 500, "AAPL gain");
  });

  await t.test("get_budgets / check_budget_status", async () => {
    const budgets: Array<{ category: string; monthly: number }> = await call("get_budgets");
    assert.equal(budgets.length, 2);
    const status: Array<{ category: string; budget: number; spent: number; status: string }> =
      await call("check_budget_status");
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    // Mirror the tool's month-to-date semantics against the fixture list.
    const groceriesMTD = [d(2), d(5)].filter((x) => x >= monthStart).length * 50 + (d(3) >= monthStart ? 75 : 0);
    const g = status.find((r) => r.category === "Groceries")!;
    near(g.spent, groceriesMTD, "groceries month-to-date (incl. household)");
    assert.ok(["under", "near", "over"].includes(g.status));
  });

  /* ------------------------------------------------------------------ */
  /* Charts (shape) + misc read tools                                    */
  /* ------------------------------------------------------------------ */

  await t.test("chart tools return renderable _chart specs", async () => {
    const chartCalls: Array<[string, Record<string, unknown>]> = [
      ["chart_spending_trend", { days: 30, groupBy: "week", kind: "consumption" }],
      ["chart_category_breakdown", { days: 30, kind: "consumption" }],
      ["chart_cash_flow", { days: 30, groupBy: "week" }],
      ["chart_consumption_vs_savings", { days: 30, groupBy: "week" }],
      ["chart_savings_destinations", { days: 30 }],
      ["chart_recurring_merchants", { days: 120, limit: 5 }],
      ["chart_top_merchants", { days: 30, limit: 5 }],
      ["chart_budget_status", {}],
      ["chart_balances_by_type", {}],
      ["chart_balances_by_group", {}],
      ["chart_net_worth_history", { days: 30 }],
    ];
    for (const [name, args] of chartCalls) {
      const res: { _chart?: { type: string; data: unknown[] } } = await call(name, args);
      assert.ok(res._chart, `${name} returned a _chart spec`);
      assert.ok(Array.isArray(res._chart!.data), `${name} data is an array`);
    }
    const nwh: { _chart: { data: unknown[] } } = await call("chart_net_worth_history", { days: 30 });
    assert.equal(nwh._chart.data.length, 3, "3 seeded snapshots");
    const breakdown: { _chart: { data: Array<{ value: number }> } } = await call("chart_category_breakdown", { days: 20, kind: "consumption" });
    const sliceSum = breakdown._chart.data.reduce((x, r) => x + r.value, 0);
    near(sliceSum, 1555.74, "pie slices sum to consumption total");
  });

  await t.test("misc read tools: alerts, insights, categories, projection, categorization", async () => {
    assert.deepEqual(await call("get_alerts", { limit: 10 }), []);
    assert.deepEqual(await call("get_insights"), []);
    const cats: unknown = await call("list_categories");
    assert.ok(JSON.stringify(cats).includes("Groceries"));
    const proj: unknown = await call("project_cash_flow", { days: 30 });
    assert.ok(proj && typeof proj === "object");
    const report: { scanned: number; classified: number } = await call("run_categorization", { mode: "uncategorized", limit: 10 });
    assert.equal(report.scanned, 0, "no LLM credential → graceful zero report");
  });

  /* ------------------------------------------------------------------ */
  /* Mutating tools (run last)                                           */
  /* ------------------------------------------------------------------ */

  await t.test("memory tools: remember / recall / forget round-trip", async () => {
    const created: { ok: boolean; id: string; action: string } =
      await call("remember", { content: "Treats brokerage as cash", key: "brk-as-cash", pinned: true });
    assert.equal(created.action, "created");
    const updated: { id: string; action: string } =
      await call("remember", { content: "Treats brokerage as CASH", key: "brk-as-cash", pinned: true });
    assert.equal(updated.action, "updated");
    assert.equal(updated.id, created.id, "same key upserts");
    const found: Array<{ key: string | null }> = await call("recall", { query: "brokerage", limit: 10 });
    assert.equal(found.length, 1);
    const gone: { ok: boolean } = await call("forget", { key: "brk-as-cash" });
    assert.ok(gone.ok);
    assert.deepEqual(await call("recall", { limit: 10 }), []);
  });

  await t.test("set_transaction_category: set, cascade, clear", async () => {
    const target: Envelope = await call("search_transactions", { query: "TARGET", limit: 1 });
    const id = target.transactions[0].id as string;
    await call("set_transaction_category", { transactionId: id, category: "Electronics" });
    const after: Envelope = await call("search_transactions", { query: "TARGET", limit: 1 });
    assert.equal(after.transactions[0].category, "Electronics");
    const spend: Array<{ category: string; total: number }> =
      await call("get_spending_by_category", { days: 20, groupBy: "total", kind: "consumption" });
    near(spend.find((r) => r.category === "Electronics")!.total, 30.25, "aggregates follow the override");
    await call("set_transaction_category", { transactionId: id, category: null });
    const cleared: Envelope = await call("search_transactions", { query: "TARGET", limit: 1 });
    assert.equal(cleared.transactions[0].category, "Shopping", "null clears back to AI category");
  });

  await t.test("bulk_set_category_by_merchant", async () => {
    const res: { updated: number } = await call("bulk_set_category_by_merchant", { matchSubstring: "NETFLIX", category: "Streaming" });
    assert.equal(res.updated, 4);
    const spend: Array<{ category: string; total: number }> =
      await call("get_spending_by_category", { days: 120, groupBy: "total", kind: "consumption" });
    near(spend.find((r) => r.category === "Streaming")!.total, 61.96, "all four charges re-bucketed");
  });

  await t.test("set_account_group: override + clear", async () => {
    await call("set_account_group", { accountId: BRK.id, group: "cash" });
    let rows: Array<{ group: string; balance: number }> = await call("get_balances_by_group");
    near(rows.find((r) => r.group === "cash")!.balance, 17000, "brokerage now counts as cash");
    await call("set_account_group", { accountId: BRK.id, group: "clear" });
    rows = await call("get_balances_by_group");
    near(rows.find((r) => r.group === "brokerage")!.balance, 10000, "clear restores system group");
  });

  /* ------------------------------------------------------------------ */
  /* Coverage                                                            */
  /* ------------------------------------------------------------------ */

  await t.test("every registered tool was exercised", () => {
    const missing = financeTools.map((x) => x.name).filter((n) => !called.has(n));
    assert.deepEqual(missing, [], `uncovered tools: ${missing.join(", ")}`);
  });

  await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
});
