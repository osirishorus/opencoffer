import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { alerts as alertsTable, alertRules } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { AppBar } from "@/components/AppBar";
import { findTool } from "@/lib/finance/tools";
import { AlertsClient } from "./AlertsClient";

export default async function AlertsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const [rows, rules, accounts] = await Promise.all([
    db
      .select()
      .from(alertsTable)
      .where(eq(alertsTable.userId, session.user.id))
      .orderBy(desc(alertsTable.createdAt))
      .limit(200),
    db.select().from(alertRules).where(eq(alertRules.userId, session.user.id)),
    findTool("get_accounts")!.execute({}, { userId: session.user.id }) as Promise<
      Array<{ id: string; name: string; mask: string | null }>
    >,
  ]);
  return (
    <>
      <AppBar title="Alerts" subtitle="Large spends, budget overruns, low balances, price increases" />
      <div className="space-y-6 p-4 pb-24 md:p-8 md:pb-8">
        <AlertsClient
          initial={rows.map((a) => ({
            ...a,
            createdAt: a.createdAt.toISOString(),
            readAt: a.readAt?.toISOString() ?? null,
          }))}
          rules={rules.map((r) => ({
            ...r,
            threshold: r.threshold ? Number(r.threshold) : null,
            createdAt: r.createdAt.toISOString(),
          }))}
          accounts={accounts.map((a) => ({ id: a.id, name: a.mask ? `${a.name} ··${a.mask}` : a.name }))}
        />
      </div>
    </>
  );
}
