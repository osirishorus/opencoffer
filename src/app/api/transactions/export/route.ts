import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { financialAccounts, transactions } from "@/lib/db/schema";
import { escapeCsvField } from "@/lib/csv";
import { parseTransactionFilters, transactionWhere } from "@/lib/finance/transactionFilters";

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  // Same builder the transactions page uses, so the CSV always matches the
  // rows the user was looking at when they clicked Export.
  const where = await transactionWhere(session.user.id, parseTransactionFilters(url.searchParams));

  const rows = await db
    .select({
      date: transactions.date,
      amount: transactions.amount,
      currency: transactions.isoCurrencyCode,
      name: transactions.name,
      merchant: transactions.merchantName,
      overrideMerchant: transactions.overrideMerchant,
      category: transactions.category,
      aiCategory: transactions.aiCategory,
      overrideCategory: transactions.overrideCategory,
      subcategory: transactions.subcategory,
      aiSubcategory: transactions.aiSubcategory,
      overrideSubcategory: transactions.overrideSubcategory,
      accountName: financialAccounts.name,
      pending: transactions.pending,
      isTransfer: transactions.isTransfer,
      overrideIsTransfer: transactions.overrideIsTransfer,
      notes: transactions.userNotes,
    })
    .from(transactions)
    .leftJoin(financialAccounts, eq(financialAccounts.id, transactions.accountId))
    .where(where)
    .orderBy(desc(transactions.date));

  const header = [
    "date",
    "amount",
    "currency",
    "name",
    "merchant",
    "category",
    "subcategory",
    "account name",
    "pending",
    "is_transfer",
    "notes",
  ];
  const lines = [
    header.map(escapeCsvField).join(","),
    ...rows.map((row) =>
      [
        ymd(row.date),
        row.amount,
        row.currency ?? "USD",
        row.name,
        row.overrideMerchant ?? row.merchant ?? "",
        row.overrideCategory ?? row.aiCategory ?? row.category ?? "",
        row.overrideSubcategory ?? row.aiSubcategory ?? row.subcategory ?? "",
        row.accountName ?? "",
        row.pending ? "true" : "false",
        row.overrideIsTransfer ?? row.isTransfer ? "true" : "false",
        row.notes ?? "",
      ]
        .map(escapeCsvField)
        .join(","),
    ),
  ];

  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="opencoffer-transactions-${ymd(new Date())}.csv"`,
    },
  });
}
