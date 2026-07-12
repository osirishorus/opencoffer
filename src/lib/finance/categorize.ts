/**
 * Background LLM categorizer.
 *
 * Finds transactions that haven't been AI-classified yet, batches them, and
 * asks the user's default LLM to assign:
 *   - category    — closed list (Food & Dining, Groceries, Rent, ...)
 *   - subcategory — free-form, more specific (e.g. "doordash", "spotify")
 *   - is_transfer — model's second opinion vs our regex heuristic
 *   - confidence  — 0..1 self-reported
 *
 * The result lands in transactions.ai_* columns. Spending tools then prefer
 * ai_category over the raw category from the aggregator (which is null for
 * SimpleFIN anyway). Idempotent: only touches rows where ai_classified_at IS NULL.
 *
 * Triggered from:
 *   - End of every syncConnection (fire-and-forget so the API call returns fast).
 *   - Manual POST /api/finance/categorize.
 *   - Worker cron.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { transactions, financialAccounts, llmCredentials } from "@/lib/db/schema";
import { applyCategoryRules } from "@/lib/finance/rules";
import { getModel } from "@/lib/llm/providers";
import { streamText } from "ai";

export const CATEGORIES = [
  "Food & Dining",
  "Groceries",
  "Coffee & Cafes",
  "Transportation",
  "Gas",
  "Travel",
  "Shopping",
  "Entertainment",
  "Subscriptions",
  "Bills & Utilities",
  "Phone & Internet",
  "Healthcare",
  "Insurance",
  "Education",
  "Personal Care",
  "Home & Maintenance",
  "Rent & Mortgage",
  "Taxes",
  "Charity & Gifts",
  "Cash & ATM",
  "Fees",
  "Investments",
  "Retirement Contributions",
  "Income — Salary",
  "Income — Dividend",
  "Income — Refund",
  "Income — Other",
  "Transfer",
  "Other",
] as const;
type Category = (typeof CATEGORIES)[number];
const CATEGORY_SET = new Set<string>(CATEGORIES);

const BATCH_SIZE = 25;

type Row = {
  id: string;
  date: Date;
  amount: string;
  name: string;
  merchantName: string | null;
  isTransfer: boolean;
  accountName: string;
  accountType: string;
};

type Verdict = {
  id: string;
  category: Category;
  subcategory: string | null;
  is_transfer: boolean;
  is_recurring: boolean;
  recurrence_cadence: string | null;
  confidence: number;
};

export type CategorizeReport = {
  scanned: number;
  classified: number;
  failedBatches: number;
  flippedToTransfer: number;
};

export type CategorizeStatus = {
  total: number;
  classified: number;
  manualOverrides: number;
  uncategorized: number;
};

export async function getCategorizeStatus(userId: string): Promise<CategorizeStatus> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      classified: sql<number>`count(*) filter (where ${transactions.aiClassifiedAt} is not null)::int`,
      manualOverrides: sql<number>`count(*) filter (where ${transactions.overrideCategory} is not null)::int`,
      uncategorized: sql<number>`count(*) filter (where ${transactions.aiClassifiedAt} is null and ${transactions.overrideCategory} is null)::int`,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId));

  return {
    total: row?.total ?? 0,
    classified: row?.classified ?? 0,
    manualOverrides: row?.manualOverrides ?? 0,
    uncategorized: row?.uncategorized ?? 0,
  };
}

export async function categorizeUncategorized(
  userId: string,
  opts: { limit?: number; credentialId?: string } = {},
): Promise<CategorizeReport> {
  await applyCategoryRules(userId);

  // Pick a credential: explicit override > useForAnalysis > isDefault > first.
  const creds = await db.select().from(llmCredentials).where(eq(llmCredentials.userId, userId));
  const cred = opts.credentialId
    ? creds.find((c) => c.id === opts.credentialId)
    : creds.find((c) => c.useForAnalysis) ??
      creds.find((c) => c.isDefault) ??
      creds[0];
  if (!cred) {
    console.warn("[categorize] no LLM credential for user", userId);
    return { scanned: 0, classified: 0, failedBatches: 0, flippedToTransfer: 0 };
  }
  console.log(`[categorize] using ${cred.label} (${cred.provider}/${cred.model})`);

  // Pull unclassified rows joined with account context so the model has enough signal.
  const rows: Row[] = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      name: transactions.name,
      merchantName: transactions.merchantName,
      isTransfer: transactions.isTransfer,
      accountName: financialAccounts.name,
      accountType: financialAccounts.type,
    })
    .from(transactions)
    .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
    // Skip rows the user manually overrode — they're authoritative.
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.aiClassifiedAt),
        isNull(transactions.overrideCategory),
      ),
    )
    .limit(opts.limit ?? 1000)
    .then((r) =>
      r.map((x) => ({
        id: x.id,
        date: x.date,
        amount: x.amount,
        name: x.name,
        merchantName: x.merchantName,
        isTransfer: x.isTransfer,
        accountName: x.accountName ?? "Unknown",
        accountType: x.accountType ?? "other",
      })),
    );

  const report: CategorizeReport = {
    scanned: rows.length,
    classified: 0,
    failedBatches: 0,
    flippedToTransfer: 0,
  };
  if (rows.length === 0) return report;

  const model = await getModel(cred);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const prompt = buildPrompt(batch);
    let raw = "";
    try {
      const result = streamText({ model, prompt });
      for await (const delta of result.textStream) raw += delta;
    } catch (e) {
      console.error("[categorize] LLM stream failed:", (e as Error).message);
      report.failedBatches++;
      continue;
    }

    const verdicts = parseVerdicts(raw);
    if (verdicts.length === 0) {
      console.warn("[categorize] could not parse LLM output, raw:", raw.slice(0, 300));
      report.failedBatches++;
      continue;
    }

    // Persist
    const now = new Date();
    for (const v of verdicts) {
      const row = batch.find((r) => r.id === v.id);
      if (!row) continue;
      const newIsTransfer = row.isTransfer || v.is_transfer === true; // never un-flag
      if (!row.isTransfer && newIsTransfer) report.flippedToTransfer++;
      await db
        .update(transactions)
        .set({
          aiCategory: v.category,
          aiSubcategory: v.subcategory,
          aiConfidence: String(Math.max(0, Math.min(1, v.confidence ?? 0))),
          aiClassifiedAt: now,
          isTransfer: newIsTransfer,
          isRecurring: v.is_recurring === true,
          recurrenceCadence: v.is_recurring ? (v.recurrence_cadence ?? "monthly") : null,
        })
        .where(eq(transactions.id, v.id));
      report.classified++;
    }
  }
  return report;
}

function buildPrompt(batch: Row[]): string {
  const txJson = batch.map((r) => ({
    id: r.id,
    date: r.date.toISOString().slice(0, 10),
    amount: Number(r.amount),
    description: r.name,
    merchant: r.merchantName,
    account: r.accountName,
    account_type: r.accountType,
    flagged_as_transfer: r.isTransfer,
  }));

  return `You are categorizing personal-finance transactions.

Sign convention: NEGATIVE amount = money OUT of the user (spending). POSITIVE amount = money IN (income, transfer-in, refund).

Account types: depository=checking/savings, credit=credit card, investment=brokerage/401k/HSA, loan=mortgage/student/auto.

For each transaction below, return one JSON object with:
  - "id": exact id string from input
  - "category": one of EXACTLY these values: ${CATEGORIES.map((c) => JSON.stringify(c)).join(", ")}
  - "subcategory": a short lower-case label like "doordash", "spotify", "verizon", "rent", "paycheck", or null
  - "is_transfer": true ONLY if this is an internal movement (credit-card payment, transfer between user's own accounts, brokerage core-position pass-through, etc) — NOT real spending or real income. If unsure, copy the "flagged_as_transfer" value.
  - "is_recurring": true if you recognize this as a recurring/subscription pattern (Spotify, Netflix, Verizon, rent, gym, insurance auto-debit, recurring 401k contribution, etc.). False for one-off purchases.
  - "recurrence_cadence": if is_recurring, one of "monthly" | "weekly" | "biweekly" | "quarterly" | "annual" | "other"; else null.
  - "confidence": number 0..1

Examples:
  Paycheck deposit → "Income — Salary"
  Zelle FROM a person → likely "Income — Other" (rent split, payback, etc)
  Zelle TO a person for "rent" → "Rent & Mortgage"
  Dividend received → "Income — Dividend"
  Tax refund from State → "Income — Refund"
  401k or 403b contribution debited on the investment account → "Retirement Contributions" (NOT transfer)
  Spotify, Netflix, Twilio monthly → "Subscriptions"
  Doordash, Uber Eats, restaurant → "Food & Dining"
  Whole Foods, Trader Joe's → "Groceries"
  ATM withdrawal, branch withdrawal → "Cash & ATM"
  ATT/Verizon phone bill → "Phone & Internet"
  Progressive/Geico → "Insurance"
  Volkswagen Credit / car loan / student loan → "Bills & Utilities" (or "Other" if you must)
  IRS payment → "Taxes"

Respond with a JSON array of objects, ONE per input. No prose, no markdown fences, JSON only.

INPUT:
${JSON.stringify(txJson, null, 2)}
`;
}

export function parseVerdicts(raw: string): Verdict[] {
  // Strip possible markdown fences and any leading prose.
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Find first '[' and last ']'.
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    const out: Verdict[] = [];
    for (const v of arr) {
      if (!v || typeof v !== "object") continue;
      const id = String(v.id ?? "");
      const cat = String(v.category ?? "");
      if (!id || !CATEGORY_SET.has(cat)) continue;
      out.push({
        id,
        category: cat as Category,
        subcategory: v.subcategory == null ? null : String(v.subcategory).slice(0, 64),
        is_transfer: v.is_transfer === true,
        is_recurring: v.is_recurring === true,
        recurrence_cadence: v.recurrence_cadence == null ? null : String(v.recurrence_cadence).slice(0, 16),
        confidence: typeof v.confidence === "number" ? v.confidence : 0.5,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Re-categorize EVERY transaction (wipes ai_classified_at first). */
export async function recategorizeAll(
  userId: string,
  opts: { credentialId?: string; limit?: number; onProgress?: (report: CategorizeReport) => void | Promise<void> } = {},
): Promise<CategorizeReport> {
  await db
    .update(transactions)
    .set({ aiClassifiedAt: null, aiCategory: null, aiSubcategory: null, aiConfidence: null })
    .where(eq(transactions.userId, userId));

  const total: CategorizeReport = {
    scanned: 0,
    classified: 0,
    failedBatches: 0,
    flippedToTransfer: 0,
  };

  while (true) {
    const pass = await categorizeUncategorized(userId, {
      credentialId: opts.credentialId,
      limit: opts.limit ?? 1000,
    });
    if (pass.scanned === 0) break;

    total.scanned += pass.scanned;
    total.classified += pass.classified;
    total.failedBatches += pass.failedBatches;
    total.flippedToTransfer += pass.flippedToTransfer;
    await opts.onProgress?.({ ...total });

    // Avoid retrying the same failing rows forever if the model/API cannot
    // produce usable output for the remaining batch.
    if (pass.classified === 0) break;
  }

  return total;
}
