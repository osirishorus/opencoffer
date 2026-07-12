/**
 * Shared row schema + identity derivation for CSV transaction imports.
 * Lives outside the route file so it can be unit-tested (Next route modules
 * may only export handlers).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { isTransferTransaction } from "@/lib/simplefin/client";

export const importRowSchema = z.object({
  date: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Invalid date"),
  amount: z.number().finite(),
  name: z.string().trim().min(1).max(500),
  merchant: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
  subcategory: z.string().trim().max(120).nullable().optional(),
  /** Statement reference / transaction number. When present it participates
   *  in row identity, so same-day same-amount same-name rows never collapse. */
  reference: z.string().trim().max(200).nullable().optional(),
  memo: z.string().trim().max(1000).nullable().optional(),
});

export type ImportRow = z.infer<typeof importRowSchema>;

export const importSchema = z.object({
  accountId: z.string().uuid(),
  rows: z.array(importRowSchema).min(1).max(5000),
});

/**
 * Row identity for idempotent imports. Without a reference the key is the
 * legacy content hash (unchanged so files imported before the reference
 * column existed still dedupe correctly); with a reference the key
 * incorporates it, giving distinct identity to otherwise-identical rows.
 */
export function externalId(row: ImportRow): string {
  const base = `${row.date}|${row.amount}|${row.name.trim()}`;
  const key = row.reference?.trim() ? `${base}|${row.reference.trim()}` : base;
  return `csv_${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * Apply the same deterministic transfer heuristic the SimpleFIN sync applies
 * at ingest, so backfilled CC payments / autopay rows are flagged
 * is_transfer without waiting on (or paying for) the AI categorizer.
 */
export function deriveImportIsTransfer(row: ImportRow, accountType: string): boolean {
  return isTransferTransaction(
    {
      id: "",
      posted: 0,
      amount: String(row.amount),
      description: row.name,
      payee: row.merchant ?? undefined,
      memo: row.memo ?? undefined,
    },
    accountType,
  );
}
