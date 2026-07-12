# CSV import format — backfilling historical transactions

This document specifies the exact CSV format OpenCoffer imports, so an
assistant (e.g. Claude reading bank/card statements) can produce files that
import cleanly. It reflects the actual parser in `src/lib/csv.ts` and the
import pipeline in `src/app/dashboard/transactions/TransactionsClient.tsx`
→ `POST /api/transactions/import`.

## Where to import

**Dashboard → Transactions → Import (upload icon).** Choose the target
account, upload the CSV, review the column mapping and 10-row preview, then
import. The importer sends parsed JSON to the server; the server enforces
the rules below.

Import into the account the statement belongs to. If the account doesn't
exist in OpenCoffer (e.g. a closed card), create a manual account first
(Settings → Accounts) and import into that.

## Canonical format (produce exactly this)

```csv
date,amount,name,merchant,category,subcategory,reference,memo
2024-03-01,-52.18,"WHOLE FOODS MARKET #10236","Whole Foods","Groceries",,240301001,
2024-03-01,-4.50,"STARBUCKS STORE 08882","Starbucks","Coffee & Cafes",,240301002,
2024-03-01,-4.50,"STARBUCKS STORE 08882","Starbucks","Coffee & Cafes",,240301003,
2024-03-02,2841.77,"ACME CORP PAYROLL PPD","Acme Corp","Income — Salary",,240302001,
2024-03-03,-1200.00,"ZELLE TO J SMITH RENT MARCH",,"Rent & Mortgage",,240303001,"march rent"
2024-03-04,-89.99,"AMAZON.COM*RT4Y72",,"",,240304001,
```

### Columns

| Column | Required | Rules |
| --- | --- | --- |
| `date` | **yes** | Prefer ISO `YYYY-MM-DD`. `MM/DD/YYYY` works if the "US dates" hint is selected at import time; ISO needs no hint and is never ambiguous. One transaction per row. |
| `amount` | **yes** | **Signed decimal. Negative = money out (purchases, fees), positive = money in (payments received, refunds, income).** No currency symbol needed (`$`, commas, and parentheses-for-negative are tolerated, but plain `-52.18` is safest). The import dialog has a sign-flip option, but produce negative-outflow so no one has to remember to use it. |
| `name` | **yes** | The raw statement description, up to 500 chars. **Must make the row unique — see deduplication below.** |
| `merchant` | no | Clean human merchant name if identifiable ("Whole Foods"), else leave empty. |
| `category` | no | Optional. If provided, use OpenCoffer's categories (list below). If left empty, the AI categorizer fills it in after import — leaving it empty is fine and often better. |
| `subcategory` | no | Optional free-form lowercase label ("spotify", "rent"). |
| `reference` | no — **but always provide it when the statement has one** | Statement reference / transaction number, up to 200 chars. Participates in row identity, so identical same-day charges never collapse. If the statement lacks reference numbers, generate a per-file sequence (`240301001`, …) — any stable unique string works. |
| `memo` | no | Extra statement detail (check numbers, notes), up to 1000 chars. Stored on the transaction's memo field. |

Header names are matched case-insensitively; `date`/`amount`/`name` also
match aliases (`posted date`, `transaction date` / `amt`, `debit/credit`,
`value` / `description`, `payee`, `memo`), but use the canonical names above.

### CSV mechanics

- UTF-8 plain text; `\n` or `\r\n` both fine.
- Quote fields containing commas, quotes, or newlines with double quotes;
  escape embedded quotes by doubling (`"say ""hi"""`).
- First row must be the header. Blank lines are ignored.
- Max **5,000 rows per file** (server limit). Split larger backfills into
  multiple files; each import call is deduplicated independently, so
  overlapping files are safe.

## ⚠️ Deduplication

Row identity is **`sha256(date | amount | name [| reference])`** scoped to
the target account; duplicates are silently skipped, which makes
re-importing the same file (or overlapping files) safe.

- **With a `reference` column (recommended): nothing legitimate ever
  collapses.** Two identical same-day $4.50 charges import as two rows
  because their references differ. Keep references stable across re-imports
  of the same statement (use the statement's own numbers, or a deterministic
  sequence — not random values).
- **Without `reference`:** two genuinely different transactions with the
  same date, amount, AND name collapse into one. If you can't provide
  references, uniquify `name` for same-day same-amount rows instead
  (`"STARBUCKS STORE 08882 (2)"`).

The importer reports `inserted` vs `skipped`; on a *fresh* import,
`skipped > 0` means rows collapsed — check for missing references.

## Transfers and credit-card payments

Rows like "PAYMENT THANK YOU" (on a card) or "AUTOPAY TO CHASE CARD" (on
checking) are internal transfers, not income/spending. Import them anyway —
**do not omit or re-sign them.** The import applies the same deterministic
transfer heuristic as the live bank sync (plus the AI categorizer's second
pass), so these rows are excluded from spending/income analytics
automatically. On a credit-card statement the payment appears as a POSITIVE
amount; keep it positive — any inflow on a credit account is treated as a
payment/refund, never income.

## Standard categories (optional `category` column)

Food & Dining · Groceries · Coffee & Cafes · Transportation · Gas · Travel ·
Shopping · Entertainment · Subscriptions · Bills & Utilities ·
Phone & Internet · Healthcare · Insurance · Education · Personal Care ·
Home & Maintenance · Rent & Mortgage · Taxes · Charity & Gifts · Cash & ATM ·
Fees · Investments · Retirement Contributions · Income — Salary ·
Income — Dividend · Income — Refund · Income — Other · Transfer · Other

(The dash in `Income — Salary` is an em-dash. Custom category names are also
accepted, but the standard list keeps dashboards coherent.)

## After import

The server auto-runs AI categorization on new rows and refreshes the
net-worth snapshot. Verify totals on Dashboard → Transactions (filter by
account) against the statement's ending balance math.

## Hygiene

Statement files and generated CSVs must never be committed to this repo —
`.gitignore` blocks `*.csv`, `*.ofx`, `*.qfx`, and the `/import/` folder.
Keep working files in `/import/` (ignored) or outside the repo entirely.
