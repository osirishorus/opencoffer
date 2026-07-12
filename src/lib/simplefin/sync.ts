import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  connections,
  financialAccounts,
  transactions,
  holdings,
  securities,
  auditLog,
} from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { fetchAccounts, classifyAccount, classifyAccountGroup, isTransferTransaction } from "./client";

function n(v: string | number | null | undefined) {
  return v == null || v === "" ? null : String(v);
}

/**
 * Sync one SimpleFIN connection.
 *
 * On first sync we pull a wide window (default 2 years back) so we have
 * historical spending for trend questions. Subsequent syncs only pull
 * forward from `earliestSyncedDate - 30d` to catch any late-posted
 * transactions banks backdate.
 */
export async function syncConnection(
  connectionId: string,
  opts: { initialDays?: number; runAnalysis?: boolean } = {},
) {
  const [conn] = await db.select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  if (!conn || conn.status === "disconnected") return;
  const accessUrl = decrypt(conn.accessUrlCipher);

  // Bridge tiers cap the start-date window (typically 90 days on the beta/free
  // tier, longer on paid). 90d keeps us inside every tier; we'll continue to
  // pull forward on each subsequent sync.
  const initialDays = opts.initialDays ?? 90;
  const isFirst = !conn.earliestSyncedDate;
  const startDate = isFirst
    ? new Date(Date.now() - initialDays * 24 * 60 * 60 * 1000)
    : new Date(conn.earliestSyncedDate!.getTime() - 30 * 24 * 60 * 60 * 1000);

  const data = await fetchAccounts(accessUrl, { startDate });

  let txAdded = 0;
  let txModified = 0;
  let accountsTouched = 0;

  // Discover the FULL set of institutions this bridge is delivering data for.
  // A single SimpleFIN connection commonly covers multiple banks/brokers, so we
  // store all of them; orgName remains the first for legacy display.
  if (data.accounts.length > 0) {
    const seen = new Map<string, { name: string; domain: string | null; accounts: number }>();
    for (const a of data.accounts) {
      const name = a.org?.name ?? "Unknown";
      const key = (a.org?.domain ?? name).toLowerCase();
      const cur = seen.get(key) ?? { name, domain: a.org?.domain ?? null, accounts: 0 };
      cur.accounts++;
      seen.set(key, cur);
    }
    const institutions = [...seen.values()].sort((a, b) => b.accounts - a.accounts);
    await db
      .update(connections)
      .set({
        orgDomain: institutions[0].domain,
        orgName: institutions[0].name,
        institutions,
      })
      .where(eq(connections.id, conn.id));
  }

  for (const a of data.accounts) {
    accountsTouched++;
    const { type, subtype } = classifyAccount(a);
    const accountGroup = classifyAccountGroup(a, type);

    const [acct] = await db
      .insert(financialAccounts)
      .values({
        connectionId: conn.id,
        userId: conn.userId,
        externalAccountId: a.id,
        name: a.name,
        officialName: null,
        mask: null,
        type,
        subtype,
        accountGroup,
        currentBalance: n(a.balance),
        availableBalance: n(a["available-balance"] ?? a.balance),
        isoCurrencyCode: a.currency?.trim() || "USD",
      })
      .onConflictDoUpdate({
        target: [financialAccounts.connectionId, financialAccounts.externalAccountId],
        set: {
          name: a.name,
          type,
          subtype,
          accountGroup,
          currentBalance: n(a.balance),
          availableBalance: n(a["available-balance"] ?? a.balance),
          isoCurrencyCode: a.currency?.trim() || "USD",
          updatedAt: new Date(),
        },
      })
      .returning({ id: financialAccounts.id });

    for (const t of a.transactions ?? []) {
      const isTransfer = isTransferTransaction(t, type);
      // Pending transactions come with posted=0 — using it verbatim files them
      // under 1970-01-01. Prefer transacted_at, then fall back to "now".
      const postedSeconds = t.posted > 0 ? t.posted : (t.transacted_at ?? 0);
      const txDate = postedSeconds > 0 ? new Date(postedSeconds * 1000) : new Date();
      const inserted = await db
        .insert(transactions)
        .values({
          accountId: acct.id,
          userId: conn.userId,
          externalTxId: t.id,
          date: txDate,
          amount: t.amount,
          isoCurrencyCode: a.currency ?? "USD",
          name: t.description ?? t.payee ?? "(no description)",
          merchantName: t.payee ?? null,
          category: t.category ?? null,
          subcategory: null,
          pending: t.pending ?? false,
          memo: t.memo ?? null,
          isTransfer,
        })
        .onConflictDoUpdate({
          target: [transactions.accountId, transactions.externalTxId],
          set: {
            // Include date so a pending row's placeholder date heals once the
            // transaction actually posts (posted flips from 0 to real time)…
            // …but only overwrite forward: never regress a real date to "now"
            // for a still-pending row on every sync.
            ...(postedSeconds > 0 ? { date: txDate } : {}),
            amount: t.amount,
            name: t.description ?? t.payee ?? "(no description)",
            merchantName: t.payee ?? null,
            category: t.category ?? null,
            pending: t.pending ?? false,
            memo: t.memo ?? null,
            isTransfer,
          },
        })
        .returning({ id: transactions.id });
      if (inserted.length) {
        // crude: we can't easily tell new from updated with onConflictDoUpdate.
        // Tally as "added" on first ever sync, "modified" otherwise.
        if (isFirst) txAdded++;
        else txModified++;
      }
    }

    for (const h of a.holdings ?? []) {
      const [sec] = await db
        .insert(securities)
        .values({
          connectionId: conn.id,
          externalSecurityId: h.id,
          tickerSymbol: h.symbol ?? null,
          name: h.description ?? null,
          type: null,
          isoCurrencyCode: h.currency ?? a.currency ?? "USD",
          closePrice: h.purchase_price ? null : null, // SimpleFIN doesn't reliably expose close
        })
        .onConflictDoUpdate({
          target: [securities.connectionId, securities.externalSecurityId],
          set: {
            tickerSymbol: h.symbol ?? null,
            name: h.description ?? null,
          },
        })
        .returning({ id: securities.id });

      if (!h.shares) continue;
      const price =
        h.market_value && h.shares && Number(h.shares) !== 0
          ? String(Number(h.market_value) / Number(h.shares))
          : null;
      await db
        .insert(holdings)
        .values({
          accountId: acct.id,
          userId: conn.userId,
          securityId: sec.id,
          quantity: h.shares,
          costBasis: n(h.cost_basis),
          institutionPrice: price,
          institutionValue: n(h.market_value),
          isoCurrencyCode: h.currency ?? a.currency ?? "USD",
        })
        .onConflictDoUpdate({
          target: [holdings.accountId, holdings.securityId],
          set: {
            quantity: h.shares,
            costBasis: n(h.cost_basis),
            institutionPrice: price,
            institutionValue: n(h.market_value),
            updatedAt: new Date(),
          },
        });
    }
  }

  // SimpleFIN's `errors` array mixes hard failures (auth, institution down)
  // with soft warnings (date-range capped, account temporarily unavailable).
  // Match known soft patterns; anything else is a hard error.
  const SOFT_PATTERNS = [/capped/i, /temporarily unavailable/i, /verify/i, /no data/i];
  const hardErrors = data.errors.filter((e) => !SOFT_PATTERNS.some((re) => re.test(e)));
  const isHardError = hardErrors.length > 0;

  await db
    .update(connections)
    .set({
      lastSyncedAt: new Date(),
      earliestSyncedDate: isFirst ? startDate : conn.earliestSyncedDate,
      status: isHardError ? "error" : "active",
      error: data.errors.length ? data.errors : null,
    })
    .where(eq(connections.id, conn.id));

  // Pair-detection pass: flag opposite-amount/same-window pairs across the
  // user's own accounts as transfers. Catches things the description regex
  // misses (Fidelity↔BoA MoneyLine moves, OVERDRAFT TRANSFERs, etc).
  await detectTransferPairs(conn.userId);

  // Snapshot today's net worth (idempotent per day) so trends accumulate.
  // On a user's first-ever sync we also backfill 180 days of history from
  // the freshly-pulled transaction record so the chart isn't empty.
  try {
    const m = await import("@/lib/finance/netWorthSnapshot");
    await m.snapshotNetWorthForUser(conn.userId);
  } catch (e) {
    console.error("[sync] snapshot failed:", e);
  }
  import("@/lib/finance/netWorthBackfill")
    .then(async (m) => {
      const has = await m.hasAnySnapshots(conn.userId);
      if (!has || isFirst) {
        const r = await m.backfillNetWorth(conn.userId, 180);
        console.log("[sync] backfilled net worth:", r);
      }
    })
    .catch((e) => console.error("[sync] backfill failed:", e));

  const runAnalysis = opts.runAnalysis ?? true;
  if (runAnalysis) {
    // Fire-and-forget: have the user's default LLM categorize any newly-pulled
    // transactions. Runs in the background so the sync API call returns fast.
    // Failures are logged and never break the sync.
    import("@/lib/finance/categorize")
      .then((m) => m.categorizeUncategorized(conn.userId))
      .then((r) => console.log("[sync] categorize:", r))
      .catch((e) => console.error("[sync] categorize failed:", e));
  }

  // Evaluate alert rules against the newly synced data.
  import("@/lib/finance/alerts")
    .then((m) => m.evaluateAlerts(conn.userId))
    .catch((e) => console.error("[sync] alerts failed:", e));

  if (runAnalysis) {
    // Generate fresh AI insights (waits a bit so categorize can run first).
    setTimeout(() => {
      import("@/lib/finance/insights")
        .then((m) => m.generateInsights(conn.userId))
        .then((r) => console.log("[sync] insights:", r))
        .catch((e) => console.error("[sync] insights failed:", e));
    }, 8000);
  }

  await db.insert(auditLog).values({
    userId: conn.userId,
    kind: "simplefin.sync",
    actor: "server",
    target: conn.id,
    meta: { txAdded, txModified, accountsTouched, simplefinErrors: data.errors },
  });
}

/**
 * Find opposite-sign / similar-amount / nearby-date transactions across the
 * SAME user's different accounts and flag both as transfers.
 *
 * This is the high-confidence way to detect internal money movements: if you
 * see -$6000 on BoA and +$6000 on Fidelity within 3 days, that's a transfer,
 * not real spending or real income.
 *
 * Tolerances:
 *   - Amount within 1 cent (handles wire-fee deductions etc would need >1¢ but
 *     practically same-account-network transfers come through exact-equal)
 *   - Date within ±3 days (handles ACH float)
 *
 * Idempotent: only sets is_transfer=true, never unflags.
 */
export async function detectTransferPairs(userId: string) {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      date: transactions.date,
      isTransfer: transactions.isTransfer,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId));

  // Index by rounded amount (absolute, cents) for O(n) matching.
  type Row = (typeof rows)[number];
  const byAbsAmount = new Map<number, Row[]>();
  for (const r of rows) {
    const cents = Math.round(Math.abs(Number(r.amount)) * 100);
    if (cents === 0) continue;
    if (!byAbsAmount.has(cents)) byAbsAmount.set(cents, []);
    byAbsAmount.get(cents)!.push(r);
  }

  const toFlag = new Set<string>();
  const THREE_DAYS = 3 * 86400_000;
  for (const list of byAbsAmount.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.accountId === b.accountId) continue;
        const aAmt = Number(a.amount);
        const bAmt = Number(b.amount);
        if (Math.sign(aAmt) === Math.sign(bAmt)) continue; // need opposite signs
        if (Math.abs(a.date.getTime() - b.date.getTime()) > THREE_DAYS) continue;
        toFlag.add(a.id);
        toFlag.add(b.id);
      }
    }
  }

  if (toFlag.size > 0) {
    await db
      .update(transactions)
      .set({ isTransfer: true })
      .where(inArray(transactions.id, [...toFlag]));
  }
  return toFlag.size;
}

export async function syncAllForUser(userId: string) {
  const items = await db
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.status, "active")));
  for (const it of items) await syncConnection(it.id);
  return { synced: items.length };
}
