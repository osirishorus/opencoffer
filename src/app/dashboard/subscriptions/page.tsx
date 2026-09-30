import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { findTool, type RecurringMerchant } from "@/lib/finance/tools";
import { formatDate } from "@/lib/utils";
import { Amount } from "@/components/Amount";
import { DataTable, Th, Td, Tr, Thead } from "@/components/DataTable";
import { AppBar } from "@/components/AppBar";

const CADENCE_LABEL: Record<RecurringMerchant["cadence"], string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Yearly",
  irregular: "Irregular",
};

const UPCOMING_DAYS = 30;

export default async function SubscriptionsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const tool = findTool("get_recurring_merchants")!;
  const rows = (await tool.execute({ days: 365 }, { userId: session.user.id })) as RecurringMerchant[];

  const active = rows.filter((r) => r.active);
  const monthlyEstimate = active.reduce((s, r) => s + r.monthlyEquivalent, 0);

  const now = Date.now();
  const horizon = now + UPCOMING_DAYS * 86_400_000;
  const upcoming = active
    .filter((r) => r.nextExpected && new Date(r.nextExpected).getTime() <= horizon)
    .sort((a, b) => new Date(a.nextExpected!).getTime() - new Date(b.nextExpected!).getTime());
  const upcomingTotal = upcoming.reduce((s, r) => s + r.typicalAmount, 0);
  const priceChanges = active.filter((r) => r.priceChange);

  return (
    <>
      <AppBar
        title="Recurring outflows"
        subtitle="Heuristically detected from transaction history"
      />
      <div className="space-y-6 p-4 pb-24 md:p-8 md:pb-8">
        <div className="card-elevated mfade mfade-1 grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div>
            <div className="eyebrow">Per month · active</div>
            <div className="figure mt-3 text-[48px]"><Amount value={monthlyEstimate} /></div>
            <div className="body-s mt-1 text-on-surface-variant">
              <Amount value={monthlyEstimate * 12} /> a year
            </div>
          </div>
          <div>
            <div className="eyebrow">Due next {UPCOMING_DAYS} days</div>
            <div className="figure mt-3 text-[48px]"><Amount value={upcomingTotal} /></div>
            <div className="body-s mt-1 text-on-surface-variant">
              {upcoming.length} expected {upcoming.length === 1 ? "charge" : "charges"}
            </div>
          </div>
          <div>
            <div className="eyebrow">Merchants</div>
            <div className="figure mt-3 text-[48px]">{active.length}</div>
            <div className="body-s mt-1 text-on-surface-variant">
              active · {rows.length - active.length} lapsed
            </div>
          </div>
        </div>

        {priceChanges.length > 0 && (
          <section className="card mfade mfade-2">
            <div className="eyebrow">Price changes</div>
            <ul className="mt-3 divide-y divide-outline-variant">
              {priceChanges.map((r) => {
                const pc = r.priceChange!;
                const up = pc.to > pc.from;
                return (
                  <li key={r.merchant} className="grid grid-cols-[1fr_auto] items-center gap-4 py-3">
                    <div className="min-w-0">
                      <div className="body-m truncate text-on-surface">{r.merchant}</div>
                      <div className="body-s text-on-surface-variant">
                        was <Amount value={pc.from} />, now <Amount value={pc.to} />
                      </div>
                    </div>
                    <span className={`title-s font-mono tabular-nums ${up ? "text-error" : "text-success"}`}>
                      {up ? "+" : ""}
                      {pc.pct.toFixed(1)}%
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {upcoming.length > 0 && (
          <section className="card mfade mfade-2">
            <div className="eyebrow">Upcoming</div>
            <ul className="mt-3 divide-y divide-outline-variant">
              {upcoming.map((r) => {
                const overdue = new Date(r.nextExpected!).getTime() < now;
                return (
                  <li key={r.merchant} className="grid grid-cols-[1fr_auto] items-center gap-4 py-3">
                    <div className="min-w-0">
                      <div className="body-m truncate text-on-surface">{r.merchant}</div>
                      <div className="body-s text-on-surface-variant">
                        {CADENCE_LABEL[r.cadence]} · {overdue ? "expected" : "due"}{" "}
                        {formatDate(r.nextExpected!)}
                        {overdue && <span className="badge ml-2">late</span>}
                      </div>
                    </div>
                    <span className="title-s font-mono tabular-nums">
                      <Amount value={r.typicalAmount} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <DataTable className="mfade mfade-3">
          <Thead>
            <Tr>
              <Th>Merchant</Th>
              <Th>Cadence</Th>
              <Th align="right">Charges</Th>
              <Th>Last charge</Th>
              <Th>Next</Th>
              <Th align="right">Typical</Th>
              <Th align="right">Per month</Th>
            </Tr>
          </Thead>
          <tbody>
            {rows.map((r, i) => (
              <Tr key={i} className={r.active ? undefined : "opacity-60"}>
                <Td>
                  {r.merchant}
                  {!r.active && <span className="badge ml-2">lapsed</span>}
                </Td>
                <Td className="text-on-surface-variant">{CADENCE_LABEL[r.cadence]}</Td>
                <Td align="right" mono>{r.totalCharges}</Td>
                <Td mono className="text-on-surface-variant">{formatDate(r.lastDate)}</Td>
                <Td mono className="text-on-surface-variant">
                  {r.active && r.nextExpected ? formatDate(r.nextExpected) : "—"}
                </Td>
                <Td align="right" mono>
                  <Amount value={r.typicalAmount} />
                </Td>
                <Td align="right" mono>
                  {r.active ? <Amount value={r.monthlyEquivalent} /> : "—"}
                </Td>
              </Tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="body-m px-4 py-16 text-center text-on-surface-variant">
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
