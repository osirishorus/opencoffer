import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mcpTokens, auditLog } from "@/lib/db/schema";
import { hashToken } from "@/lib/crypto";
import { financeTools, findTool } from "@/lib/finance/tools";
import { sanitizeToolResult } from "@/lib/finance/sanitize";

/* ---------- JSON-RPC envelope ---------- */

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
};
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const PROTOCOL_VERSION = "2024-11-05";

/* ---------- Token auth ---------- */

export async function authenticateMcpToken(authHeader: string | null) {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) return null;
  const hash = hashToken(m[1]);
  const [row] = await db
    .select()
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hash), isNull(mcpTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  // best-effort last-used + use_count bump (no await on response)
  db.update(mcpTokens)
    .set({ lastUsedAt: new Date(), useCount: (row.useCount ?? 0) + 1 })
    .where(eq(mcpTokens.id, row.id))
    .catch(() => {});
  return {
    userId: row.userId,
    tokenId: row.id,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes ?? ["all"],
  };
}

/* ---------- Zod → JSON Schema (minimal) ---------- */
// We avoid pulling zod-to-json-schema by walking only the shapes we actually use.

function zodToJsonSchema(s: z.ZodTypeAny): Record<string, unknown> {
  const def = (s as unknown as { _def: { typeName: string } })._def;
  switch (def.typeName) {
    case "ZodString": {
      const schema: Record<string, unknown> = { type: "string" };
      const checks = (s as unknown as { _def: { checks?: Array<{ kind: string }> } })._def.checks;
      if (checks?.some((c) => c.kind === "date")) schema.format = "date";
      return schema;
    }
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return {
        type: "string",
        enum: (s as unknown as { _def: { values: string[] } })._def.values,
      };
    case "ZodOptional":
      return zodToJsonSchema((s as unknown as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case "ZodDefault":
      return zodToJsonSchema(
        (s as unknown as z.ZodDefault<z.ZodTypeAny>).removeDefault(),
      );
    case "ZodObject": {
      const shape = (s as unknown as z.ZodObject<z.ZodRawShape>).shape;
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        props[k] = zodToJsonSchema(v);
        const isOptional =
          (v as unknown as { _def: { typeName: string } })._def.typeName === "ZodOptional" ||
          (v as unknown as { _def: { typeName: string } })._def.typeName === "ZodDefault";
        if (!isOptional) required.push(k);
      }
      return {
        type: "object",
        properties: props,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
    default:
      return {};
  }
}

/**
 * Tokens carry a scope list. Historically every token was minted with ["all"],
 * while the UI promised "read-only" — so "all" is deliberately read-only here
 * and mutating tools require an explicit "write" scope. Existing tokens keep
 * working for reads and cannot silently gain write access.
 */
export function tokenCanWrite(scopes: readonly string[]): boolean {
  return scopes.includes("write");
}

function toolsFor(scopes: readonly string[]) {
  const canWrite = tokenCanWrite(scopes);
  return financeTools
    .filter((t) => canWrite || !t.mutates)
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    }));
}

/* ---------- Dispatcher ---------- */

export async function handleMcpRequest(
  msg: JsonRpcRequest,
  ctx: { userId: string; tokenPrefix: string; scopes?: readonly string[] },
): Promise<JsonRpcResponse | null> {
  const scopes = ctx.scopes ?? ["all"];
  const canWrite = tokenCanWrite(scopes);
  const id = msg.id ?? null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string, data?: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  });

  // Notifications (no id) get no response.
  if (msg.id === undefined) {
    if (msg.method === "notifications/initialized" || msg.method.startsWith("notifications/")) {
      return null;
    }
  }

  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "opencoffer", version: "0.1.0" },
        instructions:
          "OpenCoffer MCP server: query the user's connected financial accounts, transactions, holdings, recurring streams, and net worth. Every tool is scoped to the bearer-token's owner (and their household, where data is shared). " +
          (canWrite
            ? "This token also carries the 'write' scope: it may edit transaction categories, account groups, and assistant memories."
            : "This token is read-only — tools that would modify stored data are not exposed."),
      });

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: toolsFor(scopes) });

    case "tools/call": {
      const params = msg.params as { name?: string; arguments?: unknown } | undefined;
      const name = params?.name;
      if (!name) return err(-32602, "missing tool name");
      const tool = findTool(name);
      if (!tool) return err(-32601, `unknown tool: ${name}`);
      if (tool.mutates && !canWrite) {
        return err(-32001, `tool '${name}' modifies data and this token is read-only`);
      }
      const parsed = tool.schema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return err(-32602, "invalid arguments", parsed.error.issues);
      }
      try {
        // Same reasoning as the chat path: merchant/memo text originates
        // outside the user's control, so scrub it before an agent reads it.
        const result = sanitizeToolResult(
          await tool.execute(parsed.data, { userId: ctx.userId }),
        );
        await db.insert(auditLog).values({
          userId: ctx.userId,
          kind: "mcp.tool",
          actor: `mcp:${ctx.tokenPrefix}`,
          target: name,
          meta: { args: parsed.data },
        });
        return ok({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        return err(-32000, e instanceof Error ? e.message : "tool execution failed");
      }
    }

    default:
      return err(-32601, `method not found: ${msg.method}`);
  }
}
