import { NextResponse } from "next/server";
import { authenticateMcpToken, handleMcpRequest } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cors(headers: Headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Session-Id");
  headers.set("Access-Control-Expose-Headers", "MCP-Session-Id");
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  cors(res.headers);
  return res;
}

export async function GET() {
  // Some MCP clients open SSE here; we respond Method Not Allowed because
  // we only support the single-response POST variant of Streamable HTTP.
  return NextResponse.json({ error: "use POST" }, { status: 405 });
}

export async function POST(req: Request) {
  const ctx = await authenticateMcpToken(req.headers.get("authorization"));
  if (!ctx) {
    const r = NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } },
      { status: 401 },
    );
    cors(r.headers);
    return r;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const r = NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { status: 400 },
    );
    cors(r.headers);
    return r;
  }

  // Batch or single
  const requests = Array.isArray(body) ? body : [body];
  const results = await Promise.all(
    requests.map((m) =>
      handleMcpRequest(m as Parameters<typeof handleMcpRequest>[0], {
        userId: ctx.userId,
        tokenPrefix: ctx.tokenPrefix,
        scopes: ctx.scopes,
      }),
    ),
  );
  const responses = results.filter((r): r is NonNullable<typeof r> => r !== null);

  // A batch of only notifications produces no body.
  if (responses.length === 0) {
    const r = new NextResponse(null, { status: 204 });
    cors(r.headers);
    return r;
  }

  const r = NextResponse.json(Array.isArray(body) ? responses : responses[0]);
  cors(r.headers);
  return r;
}
