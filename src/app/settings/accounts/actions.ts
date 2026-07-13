"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { financialAccounts } from "@/lib/db/schema";
import { householdUserIds } from "@/lib/household";

const ALLOWED_GROUPS = ["cash", "credit", "retirement", "brokerage", "hsa", "loan", "other"] as const;
type Group = (typeof ALLOWED_GROUPS)[number];

export async function setAccountGroup(accountId: string, group: Group | "default") {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  if (group !== "default" && !ALLOWED_GROUPS.includes(group)) {
    throw new Error(`invalid group: ${group}`);
  }
  const ids = await householdUserIds(session.user.id);
  const value: Group | null = group === "default" ? null : group;

  const r = await db
    .update(financialAccounts)
    .set({ userAccountGroup: value })
    .where(and(inArray(financialAccounts.userId, ids), eq(financialAccounts.id, accountId)))
    .returning({ id: financialAccounts.id });

  if (r.length === 0) throw new Error("account not found");

  revalidateAccountViews();
  return { ok: true };
}

export async function renameAccount(accountId: string, name: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) throw new Error("name must be 1-120 characters");
  const ids = await householdUserIds(session.user.id);

  const r = await db
    .update(financialAccounts)
    .set({ name: trimmed, nameIsCustom: true, updatedAt: new Date() })
    .where(and(inArray(financialAccounts.userId, ids), eq(financialAccounts.id, accountId)))
    .returning({ id: financialAccounts.id });

  if (r.length === 0) throw new Error("account not found");

  revalidateAccountViews();
  return { ok: true, name: trimmed };
}

/** Restore the provider-supplied name. If the provider name hasn't been captured
 *  yet (older rows), the current name is kept and the next sync restores it. */
export async function resetAccountName(accountId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  const ids = await householdUserIds(session.user.id);

  const r = await db
    .update(financialAccounts)
    .set({
      name: sql`coalesce(${financialAccounts.officialName}, ${financialAccounts.name})`,
      nameIsCustom: false,
      updatedAt: new Date(),
    })
    .where(and(inArray(financialAccounts.userId, ids), eq(financialAccounts.id, accountId)))
    .returning({ name: financialAccounts.name });

  if (r.length === 0) throw new Error("account not found");

  revalidateAccountViews();
  return { ok: true, name: r[0].name };
}

function revalidateAccountViews() {
  revalidatePath("/settings/accounts");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/investments");
  revalidatePath("/dashboard/charts");
}
