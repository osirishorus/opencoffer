import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { financialAccounts } from "@/lib/db/schema";
import { asc, inArray } from "drizzle-orm";
import { householdUserIds } from "@/lib/household";
import { AppBar } from "@/components/AppBar";
import { AccountsClient } from "./AccountsClient";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const ids = await householdUserIds(session.user.id);

  const rows = await db
    .select({
      id: financialAccounts.id,
      name: financialAccounts.name,
      officialName: financialAccounts.officialName,
      mask: financialAccounts.mask,
      type: financialAccounts.type,
      subtype: financialAccounts.subtype,
      systemGroup: financialAccounts.accountGroup,
      userOverride: financialAccounts.userAccountGroup,
      nameIsCustom: financialAccounts.nameIsCustom,
      currentBalance: financialAccounts.currentBalance,
      currency: financialAccounts.isoCurrencyCode,
      source: financialAccounts.source,
    })
    .from(financialAccounts)
    .where(inArray(financialAccounts.userId, ids))
    .orderBy(asc(financialAccounts.accountGroup), asc(financialAccounts.name));

  return (
    <>
      <AppBar
        title="Accounts"
        subtitle="Rename accounts and override the group each is treated as"
      />
      <div className="space-y-6 p-4 pb-24 md:p-8 md:pb-8">
        <div className="card-elevated mfade mfade-1">
          <h2 className="title-l">How grouping is used</h2>
          <p className="body-m mt-2 text-on-surface-variant">
            Account <em>group</em> drives the savings-rate split, net-worth-by-group chart,
            balances-by-group bar, and any chat question like &ldquo;how much cash do I have&rdquo;.
            We auto-classify each account from its name + type, but you can override here. The
            chat assistant can also do this via <code className="font-mono text-xs">set_account_group</code>.
          </p>
        </div>
        <AccountsClient
          accounts={rows.map((r) => ({
            ...r,
            currentBalance: Number(r.currentBalance ?? 0),
          }))}
        />
      </div>
    </>
  );
}
