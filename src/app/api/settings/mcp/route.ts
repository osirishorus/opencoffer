import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { mcpTokens } from "@/lib/db/schema";
import { generateToken } from "@/lib/crypto";

const body = z.object({
  label: z.string().min(1),
  /** "read" mints a read-only token; "write" additionally allows mutating tools. */
  access: z.enum(["read", "write"]).default("read"),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const { token, hash, prefix } = generateToken();
  const [row] = await db
    .insert(mcpTokens)
    .values({
      userId: session.user.id,
      label: parsed.data.label,
      tokenHash: hash,
      tokenPrefix: prefix,
      scopes: parsed.data.access === "write" ? ["all", "write"] : ["all"],
    })
    .returning({
      id: mcpTokens.id,
      label: mcpTokens.label,
      tokenPrefix: mcpTokens.tokenPrefix,
      scopes: mcpTokens.scopes,
      createdAt: mcpTokens.createdAt,
      lastUsedAt: mcpTokens.lastUsedAt,
      revokedAt: mcpTokens.revokedAt,
    });
  return NextResponse.json({
    token,
    row: {
      ...row,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    },
  });
}
