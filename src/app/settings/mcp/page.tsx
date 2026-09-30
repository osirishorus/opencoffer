import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { mcpTokens } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { McpClient } from "./McpClient";
import { AppBar } from "@/components/AppBar";

export default async function McpPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const tokens = await db
    .select({
      id: mcpTokens.id,
      label: mcpTokens.label,
      tokenPrefix: mcpTokens.tokenPrefix,
      scopes: mcpTokens.scopes,
      createdAt: mcpTokens.createdAt,
      lastUsedAt: mcpTokens.lastUsedAt,
      revokedAt: mcpTokens.revokedAt,
    })
    .from(mcpTokens)
    .where(eq(mcpTokens.userId, session.user.id));

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  return (
    <>
      <AppBar
        title="MCP"
        subtitle="Expose your finance data to Hermes, Claude Desktop, Cursor, or any MCP-capable agent"
      />
      <div className="space-y-6 p-4 pb-24 md:p-8 md:pb-8">
        <McpClient
          initial={tokens.map((t) => ({
            ...t,
            createdAt: t.createdAt.toISOString(),
            lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
            revokedAt: t.revokedAt?.toISOString() ?? null,
          }))}
          endpoint={`${appUrl}/api/mcp`}
        />
      </div>
    </>
  );
}
