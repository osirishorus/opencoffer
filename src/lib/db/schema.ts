import {
  pgTable,
  text,
  timestamp,
  primaryKey,
  integer,
  uniqueIndex,
  index,
  jsonb,
  boolean,
  numeric,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/* ---------- Auth.js core tables ---------- */

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique().notNull(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  passwordHash: text("password_hash"),
  /** Primary household for this user. Set after signup (one per user by default). */
  householdId: uuid("household_id"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("My Household"),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | member
    joinedAt: timestamp("joined_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] }), index("hm_user_idx").on(t.userId)],
);

export const householdInvites = pgTable("household_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: uuid("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  inviterUserId: text("inviter_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  consumedAt: timestamp("consumed_at", { mode: "date" }),
  consumedByUserId: text("consumed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [primaryKey({ columns: [account.provider, account.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

/* ---------- SimpleFIN connections + financial data ---------- */

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Encrypted SimpleFIN access URL (contains basic-auth credentials). */
    accessUrlCipher: text("access_url_cipher").notNull(),
    /** Org domain reported by SimpleFIN (e.g. "fidelity.com"); informational only. */
    orgDomain: text("org_domain"),
    /** Org name reported by SimpleFIN (e.g. "Fidelity"); informational only.
     * A bridge can return MULTIPLE institutions — see `institutions` below for
     * the full list. This field is kept for backward compat / sort. */
    orgName: text("org_name"),
    /** All distinct institutions seen at the most recent sync, e.g.
     *  [{ name: "Fidelity Investments", domain: "fidelity.com", accounts: 7 },
     *   { name: "Bank of America",       domain: "bofa.com",     accounts: 2 }]. */
    institutions: jsonb("institutions"),
    /** User-visible label they set at connect time, e.g. "Personal banks". */
    label: text("label"),
    status: text("status").notNull().default("active"), // active | error | disconnected
    error: jsonb("error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { mode: "date" }),
    /** Earliest transaction date we should re-pull on next sync (SimpleFIN start-date). */
    earliestSyncedDate: timestamp("earliest_synced_date", { mode: "date" }),
    disconnectedAt: timestamp("disconnected_at", { mode: "date" }),
    purgeAfter: timestamp("purge_after", { mode: "date" }),
  },
  (t) => [index("connections_user_idx").on(t.userId)],
);

export const financialAccounts = pgTable(
  "financial_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .references(() => connections.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("simplefin"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Provider-side account id (SimpleFIN's account.id). */
    externalAccountId: text("external_account_id").notNull(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    mask: text("mask"),
    /** Best-effort classification: depository | credit | investment | loan | other. */
    type: text("type").notNull(),
    subtype: text("subtype"),
    /** Finer-grained AI-friendly bucket: cash | credit | retirement | brokerage | hsa | loan | other. */
    accountGroup: text("account_group").notNull().default("other"),
    /** User override of the system-assigned group (e.g. user wants a Fidelity brokerage
     *  treated as 'cash' for analysis). Null = use accountGroup. Set via the chat tool
     *  `set_account_group` or the Connections UI. */
    userAccountGroup: text("user_account_group"),
    /** True once the user renames the account; sync then stops overwriting `name`
     *  (the provider's name is kept in officialName so the rename can be reset). */
    nameIsCustom: boolean("name_is_custom").notNull().default(false),
    currentBalance: numeric("current_balance", { precision: 19, scale: 4 }),
    availableBalance: numeric("available_balance", { precision: 19, scale: 4 }),
    isoCurrencyCode: text("iso_currency_code").default("USD"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("financial_accounts_ext_id_idx").on(t.connectionId, t.externalAccountId),
    index("financial_accounts_user_idx").on(t.userId),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Provider-side transaction id (SimpleFIN's transaction.id). */
    externalTxId: text("external_tx_id").notNull(),
    date: timestamp("date", { mode: "date" }).notNull(),
    /** SimpleFIN signed amount: negative = outflow, positive = inflow. */
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    isoCurrencyCode: text("iso_currency_code").default("USD"),
    name: text("name").notNull(),
    merchantName: text("merchant_name"),
    category: text("category"),
    subcategory: text("subcategory"),
    pending: boolean("pending").notNull().default(false),
    memo: text("memo"),
    /**
     * True when this row represents an internal money movement (credit-card payment,
     * transfer between own accounts) rather than real spending or real income.
     * Spending aggregations exclude these to prevent double-counting.
     */
    isTransfer: boolean("is_transfer").notNull().default(false),
    /** AI-derived spending category from a closed taxonomy (e.g. "Food & Dining"). */
    aiCategory: text("ai_category"),
    /** AI-derived more-specific label, free-form (e.g. "doordash" or "spotify"). */
    aiSubcategory: text("ai_subcategory"),
    /** Model self-reported 0..1 confidence. */
    aiConfidence: numeric("ai_confidence", { precision: 4, scale: 3 }),
    /** When the AI last classified this row. Null = not yet processed. */
    aiClassifiedAt: timestamp("ai_classified_at", { mode: "date" }),
    /** User-set category that overrides both AI and raw. */
    overrideCategory: text("override_category"),
    overrideSubcategory: text("override_subcategory"),
    overrideIsTransfer: boolean("override_is_transfer"),
    overrideMerchant: text("override_merchant"),
    userNotes: text("user_notes"),
    /** True if the categorizer thinks this is a recurring (subscription, rent) row. */
    isRecurring: boolean("is_recurring").notNull().default(false),
    /** monthly | weekly | biweekly | quarterly | annual | other */
    recurrenceCadence: text("recurrence_cadence"),
  },
  (t) => [
    uniqueIndex("transactions_ext_id_idx").on(t.accountId, t.externalTxId),
    index("transactions_user_date_idx").on(t.userId, t.date),
    index("transactions_account_date_idx").on(t.accountId, t.date),
  ],
);

export const categoryRules = pgTable(
  "category_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    field: text("field").notNull(), // merchant | name
    matchType: text("match_type").notNull(), // contains | equals
    pattern: text("pattern").notNull(),
    category: text("category").notNull(),
    subcategory: text("subcategory"),
    enabled: boolean("enabled").notNull().default(true),
    appliedCount: integer("applied_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("category_rules_user_idx").on(t.userId)],
);

export const securities = pgTable(
  "securities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider-supplied security id (SimpleFIN doesn't reuse across orgs; key on (connection, id)). */
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalSecurityId: text("external_security_id").notNull(),
    tickerSymbol: text("ticker_symbol"),
    name: text("name"),
    type: text("type"),
    isoCurrencyCode: text("iso_currency_code").default("USD"),
    closePrice: numeric("close_price", { precision: 19, scale: 6 }),
    closePriceAsOf: timestamp("close_price_as_of", { mode: "date" }),
  },
  (t) => [uniqueIndex("securities_ext_id_idx").on(t.connectionId, t.externalSecurityId)],
);

export const holdings = pgTable(
  "holdings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    securityId: uuid("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    costBasis: numeric("cost_basis", { precision: 19, scale: 4 }),
    institutionPrice: numeric("institution_price", { precision: 19, scale: 6 }),
    institutionValue: numeric("institution_value", { precision: 19, scale: 4 }),
    isoCurrencyCode: text("iso_currency_code").default("USD"),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("holdings_account_security_idx").on(t.accountId, t.securityId)],
);

/* ---------- BYO-LLM credentials + MCP tokens ---------- */

export const llmCredentials = pgTable(
  "llm_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // openai-compat | anthropic
    label: text("label").notNull(),
    baseUrl: text("base_url"),
    model: text("model").notNull(),
    apiKeyCipher: text("api_key_cipher"), // nullable for ollama on localhost
    isDefault: boolean("is_default").notNull().default(false),
    /** Which credential the background categorizer / analysis jobs use.
     * Only one row per user should have this true. Falls back to isDefault. */
    useForAnalysis: boolean("use_for_analysis").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("llm_user_idx").on(t.userId)],
);

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(), // first 8 chars for display
    /** "all" or specific scopes: read-tx, read-balances, read-budgets, write-overrides */
    scopes: text("scopes").array().notNull().default(["all"]),
    useCount: integer("use_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (t) => [index("mcp_user_idx").on(t.userId)],
);

/* ---------- Chat history ---------- */

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("chat_threads_user_idx").on(t.userId)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant | tool | system
    content: jsonb("content").notNull(), // AI SDK parts array
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_thread_idx").on(t.threadId, t.createdAt)],
);

/* ---------- Budgets ---------- */

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    monthlyAmount: numeric("monthly_amount", { precision: 19, scale: 4 }).notNull(),
    isoCurrencyCode: text("iso_currency_code").notNull().default("USD"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("budgets_user_cat_idx").on(t.userId, t.category)],
);

/* ---------- Net-worth daily snapshots ---------- */

export const netWorthSnapshots = pgTable(
  "net_worth_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    snapshotDate: timestamp("snapshot_date", { mode: "date" }).notNull(),
    assets: numeric("assets", { precision: 19, scale: 4 }).notNull(),
    liabilities: numeric("liabilities", { precision: 19, scale: 4 }).notNull(),
    netWorth: numeric("net_worth", { precision: 19, scale: 4 }).notNull(),
    byGroup: jsonb("by_group").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("nw_snap_user_day_idx").on(t.userId, t.snapshotDate)],
);

/* ---------- Real assets: homes, vehicles, land, and other property ---------- */

export const realAssets = pgTable(
  "real_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** home | vehicle | land | other */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** active | sold | archived */
    status: text("status").notNull().default("active"),
    /** manual | provider */
    valuationMode: text("valuation_mode").notNull().default("manual"),
    purchasePrice: numeric("purchase_price", { precision: 19, scale: 4 }),
    purchaseDate: timestamp("purchase_date", { mode: "date" }),
    isoCurrencyCode: text("iso_currency_code").notNull().default("USD"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("real_assets_user_status_idx").on(t.userId, t.status)],
);

export const realAssetValues = pgTable(
  "real_asset_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").notNull().references(() => realAssets.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    value: numeric("value", { precision: 19, scale: 4 }).notNull(),
    isoCurrencyCode: text("iso_currency_code").notNull().default("USD"),
    /** manual | rentcast | realie | auto_dev | marketcheck */
    source: text("source").notNull(),
    /** manual_entry | avm | comparable_estimate | direct_vehicle_value */
    sourceKind: text("source_kind").notNull(),
    asOf: timestamp("as_of", { mode: "date" }).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    rangeLow: numeric("range_low", { precision: 19, scale: 4 }),
    rangeHigh: numeric("range_high", { precision: 19, scale: 4 }),
    notes: text("notes"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("real_asset_values_asset_asof_idx").on(t.assetId, t.asOf)],
);

/* ---------- Alerts ---------- */

export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // large_tx | category_overspend | card_due | low_balance
    threshold: numeric("threshold", { precision: 19, scale: 4 }),
    category: text("category"),
    accountId: uuid("account_id").references(() => financialAccounts.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("alert_rules_user_idx").on(t.userId)],
);
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => alertRules.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    meta: jsonb("meta"),
    readAt: timestamp("read_at", { mode: "date" }),
    notifiedAt: timestamp("notified_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("alerts_user_idx").on(t.userId, t.createdAt)],
);

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // ntfy | discord | slack | webhook
    label: text("label").notNull(),
    configCipher: text("config_cipher").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastSuccessAt: timestamp("last_success_at", { mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("notification_channels_user_idx").on(t.userId)],
);

/* ---------- Assistant long-term memory ----------
 *
 * Free-form notes the chat assistant saves about the user across conversations.
 * Read/written exclusively via the `remember` / `recall` / `forget` tools — never
 * auto-injected into the system prompt (the model decides when to look). */

export const assistantMemories = pgTable(
  "assistant_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Optional stable slug. When set, `remember` upserts on (userId, key). */
    key: text("key"),
    content: text("content").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    accessedAt: timestamp("accessed_at", { mode: "date" }),
  },
  (t) => [
    index("assistant_memories_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("assistant_memories_user_key_idx").on(t.userId, t.key),
  ],
);

/* ---------- User-saved charts (custom dashboard tiles) ---------- */

export const savedCharts = pgTable(
  "saved_charts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Original user prompt — kept for re-rendering after schema updates. */
    prompt: text("prompt").notNull(),
    /** Name of a chart_* tool in lib/finance/tools.ts. Validated at render time. */
    toolName: text("tool_name").notNull(),
    /** Args object for the tool — validated against the tool's schema before exec. */
    args: jsonb("args").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("saved_charts_user_idx").on(t.userId, t.position, t.createdAt)],
);

/* ---------- AI insights ---------- */

export const aiInsights = pgTable(
  "ai_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** savings | spending | recurring | anomaly | budget | general */
    kind: text("kind").notNull(),
    /** info | warn | suggest | praise */
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    dataRef: jsonb("data_ref"),
    generatedAt: timestamp("generated_at", { mode: "date" }).notNull().defaultNow(),
    dismissedAt: timestamp("dismissed_at", { mode: "date" }),
    meta: jsonb("meta"),
  },
  (t) => [index("ai_insights_user_idx").on(t.userId, t.generatedAt)],
);

/* ---------- Audit log ---------- */

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // simplefin.sync | chat.complete | mcp.tool | simplefin.disconnect | ...
    actor: text("actor"), // session | mcp:<token-prefix> | webhook | worker
    target: text("target"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("audit_user_idx").on(t.userId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type LlmCredential = typeof llmCredentials.$inferSelect;
export type McpToken = typeof mcpTokens.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type FinancialAccount = typeof financialAccounts.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type CategoryRule = typeof categoryRules.$inferSelect;
export type Holding = typeof holdings.$inferSelect;
export type Security = typeof securities.$inferSelect;
export type RealAsset = typeof realAssets.$inferSelect;
export type RealAssetValue = typeof realAssetValues.$inferSelect;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
