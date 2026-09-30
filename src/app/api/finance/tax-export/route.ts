import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { transactions, financialAccounts } from "@/lib/db/schema";
import { effectiveCategorySQL } from "@/lib/finance/tools";
import { householdUserIds } from "@/lib/household";

/**
 * Download a CSV of tax-relevant transactions for a given tax year. Includes:
 *   - Dividends, interest, refunds, taxes paid
 *   - Investment cost-basis / sales (when category = "Investments")
 * The user is expected to refine in a spreadsheet. This isn't a tax form, just
 * a head start.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const year = Number(url.searchParams.get("year") ?? new Date().getFullYear() - 1);
  const start = new Date(`${year}-01-01T00:00:00Z`);
  const end = new Date(`${year + 1}-01-01T00:00:00Z`);

  const effectiveCategory = effectiveCategorySQL();
  // Household members file together and share accounts, so the tax CSV must
  // cover the same scope the dashboard reports.
  const ids = await householdUserIds(session.user.id);
  const rows = await db
    .select({
      date: transactions.date,
      amount: transactions.amount,
      account: financialAccounts.name,
      accountGroup: financialAccounts.accountGroup,
      name: transactions.name,
      merchant: transactions.merchantName,
      category: effectiveCategory,
      subcategory: sql<string>`coalesce(${transactions.overrideSubcategory}, ${transactions.aiSubcategory})`,
    })
    .from(transactions)
    .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
    .where(
      and(
        inArray(transactions.userId, ids),
        gte(transactions.date, start),
        lte(transactions.date, end),
        sql`${effectiveCategory} IN
            ('Income — Dividend','Income — Refund','Taxes','Investments','Charity & Gifts','Retirement Contributions','Healthcare','Education')`,
      ),
    )
    .orderBy(desc(transactions.date));

  const csv = [
    ["date", "account", "group", "category", "subcategory", "merchant", "name", "amount"]
      .map(quote)
      .join(","),
    ...rows.map((r) =>
      [
        r.date.toISOString().slice(0, 10),
        r.account ?? "",
        r.accountGroup ?? "",
        r.category,
        r.subcategory ?? "",
        r.merchant ?? "",
        r.name,
        Number(r.amount).toFixed(2),
      ]
        .map(quote)
        .join(","),
    ),
  ].join("\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="opencoffer-tax-${year}.csv"`,
    },
  });
}

function quote(s: string | number | null | undefined): string {
  const str = s == null ? "" : String(s);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
