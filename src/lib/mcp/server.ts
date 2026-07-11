import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mcpTokens, auditLog } from "@/lib/db/schema";
import { hashToken } from "@/lib/crypto";
import { financeTools, findTool } from "@/lib/finance/tools";

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
    case "ZodNullable":
      // Advertise the inner type; the validator accepts null (and, for
      // nullish fields, omission), so clients get a real type hint instead
      // of an empty {} schema.
      return zodToJsonSchema((s as unknown as z.ZodNullable<z.ZodTypeAny>).unwrap());
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

const TOOL_LIST = financeTools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: zodToJsonSchema(t.schema),
}));

/* ---------- Dispatcher ---------- */

export async function handleMcpRequest(
  msg: JsonRpcRequest,
  ctx: { userId: string; tokenPrefix: string },
): Promise<JsonRpcResponse | null> {
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
          "OpenCoffer MCP server: query the user's connected financial accounts, transactions, holdings, recurring streams, and net worth. All tools are read-only and scoped to the bearer-token's owner.",
      });

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: TOOL_LIST });

    case "tools/call": {
      const params = msg.params as { name?: string; arguments?: unknown } | undefined;
      const name = params?.name;
      if (!name) return err(-32602, "missing tool name");
      const tool = findTool(name);
      if (!tool) return err(-32601, `unknown tool: ${name}`);
      const parsed = tool.schema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return err(-32602, "invalid arguments", parsed.error.issues);
      }
      try {
        const result = await tool.execute(parsed.data, { userId: ctx.userId });
        await db.insert(auditLog).values({
          userId: ctx.userId,
          kind: "mcp.tool",
          actor: `mcp:${ctx.tokenPrefix}`,
          target: name,
          meta: { args: parsed.data },
        });
        // Spec: structuredContent must be a JSON object. Many tools return
        // arrays — strict clients (e.g. the Python MCP SDK) reject the whole
        // response if we put an array here, so omit it and rely on the text
        // block, which always carries the full JSON.
        const structured =
          result && typeof result === "object" && !Array.isArray(result)
            ? { structuredContent: result as Record<string, unknown> }
            : {};
        return ok({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          ...structured,
        });
      } catch (e) {
        return err(-32000, e instanceof Error ? e.message : "tool execution failed");
      }
    }

    default:
      return err(-32601, `method not found: ${msg.method}`);
  }
}
