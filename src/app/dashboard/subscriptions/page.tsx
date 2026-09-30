import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { findTool } from "@/lib/finance/tools";
import { formatDate } from "@/lib/utils";
import { Amount } from "@/components/Amount";
import { DataTable, Th, Td, Tr, Thead } from "@/components/DataTable";
import { AppBar } from "@/components/AppBar";

export default async function SubscriptionsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const tool = findTool("get_recurring_merchants")!;
  const rows = (await tool.execute({ days: 365 }, { userId: session.user.id })) as Array<{
    merchant: string;
    months: number;
    typicalAmount: number;
    lastDate: Date;
    totalCharges: number;
  }>;

  // Estimate monthly: typical amount for merchants seen most months
  const monthlyEstimate = rows
    .filter((r) => r.months >= 2)
    .reduce((s, r) => s + r.typicalAmount, 0);

  return (
    <>
      <AppBar
        title="Recurring outflows"
        subtitle="Heuristically detected from transaction history"
      />
      <div className="space-y-6 p-4 pb-24 md:p-8 md:pb-8">
        <div className="card-elevated mfade mfade-1 flex items-baseline justify-between">
          <div>
            <div className="eyebrow">Estimated monthly</div>
            <div className="figure mt-3 text-[56px]"><Amount value={monthlyEstimate} /></div>
          </div>
          <div className="text-right">
            <div className="eyebrow">Merchants detected</div>
            <div className="figure mt-3 text-[40px]">{rows.length}</div>
          </div>
        </div>

        <DataTable className="mfade mfade-2">
          <Thead>
            <Tr>
              <Th>Merchant</Th>
              <Th align="right">Months seen</Th>
              <Th align="right">Total charges</Th>
              <Th>Last charge</Th>
              <Th align="right">Typical</Th>
            </Tr>
          </Thead>
          <tbody>
            {rows.map((r, i) => (
              <Tr key={i}>
                <Td>{r.merchant}</Td>
                <Td align="right" mono>{r.months}</Td>
                <Td align="right" mono>{r.totalCharges}</Td>
                <Td mono className="text-on-surface-variant">{formatDate(r.lastDate)}</Td>
                <Td align="right" mono>
                  <Amount value={r.typicalAmount} />
                </Td>
              </Tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="body-m px-4 py-16 text-center text-on-surface-variant">
                  Nothing detected yet — needs 2+ months of transaction history.
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      </div>
    </>
  );
}
