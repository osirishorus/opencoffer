import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { alerts, alertRules, financialAccounts } from "@/lib/db/schema";
import { ALERT_KINDS, evaluateAlerts } from "@/lib/finance/alerts";
import { householdUserIds } from "@/lib/household";
import { z } from "zod";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await db
    .select()
    .from(alerts)
    .where(eq(alerts.userId, session.user.id))
    .orderBy(desc(alerts.createdAt))
    .limit(100);
  const unread = rows.filter((r) => !r.readAt).length;
  return NextResponse.json({ alerts: rows, unread });
}

const markRead = z.object({ ids: z.array(z.string().uuid()) });

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  if (url.searchParams.get("action") === "evaluate") {
    await evaluateAlerts(session.user.id);
    return NextResponse.json({ ok: true });
  }
  const parsed = markRead.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  await db
    .update(alerts)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(alerts.userId, session.user.id),
        inArray(alerts.id, parsed.data.ids),
        isNull(alerts.readAt),
      ),
    );
  return NextResponse.json({ ok: true });
}

// ---- rules: PUT upserts, DELETE removes ----

const ruleBody = z
  .object({
    id: z.string().uuid().optional(),
    kind: z.enum(ALERT_KINDS),
    threshold: z.number().finite().nonnegative().nullish(),
    category: z.string().trim().min(1).max(100).nullish(),
    accountId: z.string().uuid().nullish(),
    enabled: z.boolean().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.kind === "large_tx" && b.threshold == null)
      ctx.addIssue({ code: "custom", path: ["threshold"], message: "threshold required" });
    if (b.kind === "category_overspend" && !b.category)
      ctx.addIssue({ code: "custom", path: ["category"], message: "category required" });
    if (b.kind === "low_balance" && (b.threshold == null || !b.accountId))
      ctx.addIssue({ code: "custom", path: ["accountId"], message: "account and threshold required" });
  });

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = ruleBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  const body = parsed.data;

  // Only household accounts may back a low-balance rule.
  if (body.accountId) {
    const ids = await householdUserIds(session.user.id);
    const [acct] = await db
      .select({ id: financialAccounts.id })
      .from(financialAccounts)
      .where(and(eq(financialAccounts.id, body.accountId), inArray(financialAccounts.userId, ids)))
      .limit(1);
    if (!acct) return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const values = {
    kind: body.kind,
    threshold: body.threshold != null ? String(body.threshold) : null,
    category: body.kind === "category_overspend" ? (body.category ?? null) : null,
    accountId: body.kind === "low_balance" ? (body.accountId ?? null) : null,
    enabled: body.enabled !== false,
  };
  if (body.id) {
    const updated = await db
      .update(alertRules)
      .set(values)
      .where(and(eq(alertRules.id, body.id), eq(alertRules.userId, session.user.id)))
      .returning({ id: alertRules.id });
    if (!updated.length) return NextResponse.json({ error: "not found" }, { status: 404 });
  } else {
    await db.insert(alertRules).values({ userId: session.user.id, ...values });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = z.string().uuid().safeParse(new URL(req.url).searchParams.get("ruleId"));
  if (!id.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  await db
    .delete(alertRules)
    .where(and(eq(alertRules.id, id.data), eq(alertRules.userId, session.user.id)));
  return NextResponse.json({ ok: true });
}
