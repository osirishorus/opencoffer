import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { notificationChannels } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";

const body = z
  .object({
    kind: z.enum(["ntfy", "discord", "slack", "webhook", "pushover"]),
    label: z.string().trim().min(1).max(80),
    // Pushover has a fixed API endpoint, so the URL is optional there.
    url: z.string().url().max(500).optional().or(z.literal("")),
    topic: z.string().trim().max(120).optional(),
    authToken: z.string().trim().max(500).optional(),
    userKey: z.string().trim().max(120).optional(),
    digest: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "pushover") {
      if (!v.authToken) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pushover requires an application token." });
      if (!v.userKey) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pushover requires a user key." });
    } else if (!v.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "URL is required." });
    }
  });

function isPrivateHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local");
}

function validateUrl(kind: string, url: string): string | null {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && (kind === "ntfy" || isPrivateHost(parsed.hostname))) return null;
  return "Notification URL must use https, except ntfy or local self-hosted http endpoints.";
}

function urlHint(configCipher: string) {
  try {
    const config = JSON.parse(decrypt(configCipher)) as { url?: string };
    return config.url ? new URL(config.url).hostname : null;
  } catch {
    return null;
  }
}

function serializeChannel(row: typeof notificationChannels.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    urlHint: urlHint(row.configCipher),
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.userId, session.user.id))
    .orderBy(desc(notificationChannels.createdAt));
  return NextResponse.json(rows.map(serializeChannel));
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? parsed.error.message;
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const url =
    parsed.data.kind === "pushover"
      ? parsed.data.url || "https://api.pushover.net/1/messages.json"
      : parsed.data.url!;
  const urlError = validateUrl(parsed.data.kind, url);
  if (urlError) return NextResponse.json({ error: urlError }, { status: 400 });

  const [row] = await db
    .insert(notificationChannels)
    .values({
      userId: session.user.id,
      kind: parsed.data.kind,
      label: parsed.data.label,
      configCipher: encrypt(
        JSON.stringify({
          url,
          topic: parsed.data.topic || undefined,
          authToken: parsed.data.authToken || undefined,
          userKey: parsed.data.userKey || undefined,
          digest: parsed.data.digest || undefined,
        }),
      ),
      enabled: parsed.data.enabled ?? true,
    })
    .returning();
  return NextResponse.json(serializeChannel(row));
}
