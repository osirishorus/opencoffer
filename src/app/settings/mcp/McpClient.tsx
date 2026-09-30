"use client";

import { useState } from "react";
import { DataTable, Th, Td, Tr, Thead } from "@/components/DataTable";
import { Plus, Copy, Check } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";

type Token = {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function canWrite(scopes: string[] | null) {
  return (scopes ?? []).includes("write");
}

export function McpClient({ initial, endpoint }: { initial: Token[]; endpoint: string }) {
  const confirm = useConfirm();
  const [tokens, setTokens] = useState(initial);
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [revealed, setRevealed] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await fetch("/api/settings/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, access }),
    });
    if (!r.ok) return;
    const { token, row } = await r.json();
    setTokens((ts) => [...ts, row]);
    setRevealed(token);
    setLabel("");
    setAccess("read");
  };

  const revoke = async (id: string) => {
    const ok = await confirm({
      title: "Revoke token?",
      body: "Revoke this token? Any agent using it will lose access immediately.",
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    await fetch(`/api/settings/mcp/${id}`, { method: "DELETE" });
    setTokens((ts) =>
      ts.map((t) => (t.id === id ? { ...t, revokedAt: new Date().toISOString() } : t)),
    );
  };

  const sampleToken = revealed ?? "oc_<PASTE_TOKEN_HERE>";
  const hermesSnippet = `# Add OpenCoffer as an MCP server in Hermes Agent
hermes mcp add opencoffer \\
  --transport http \\
  --url ${endpoint} \\
  --header "Authorization: Bearer ${sampleToken}"

# Then ask Hermes anything:
hermes "Summarise my last month of spending and flag anything unusual."`;
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        opencoffer: {
          type: "http",
          url: endpoint,
          headers: { Authorization: `Bearer ${sampleToken}` },
        },
      },
    },
    null,
    2,
  );
  const cursorSnippet = JSON.stringify(
    {
      mcpServers: {
        opencoffer: { url: endpoint, headers: { Authorization: `Bearer ${sampleToken}` } },
      },
    },
    null,
    2,
  );

  const READ_TOOLS = [
    ["get_accounts", "list connected accounts + balances"],
    ["get_recent_transactions", "last N days, optional account/category filter"],
    ["search_transactions", "text search merchants/desc, date+amount filters"],
    ["get_spending_by_category", "outflows aggregated by category and period"],
    ["get_holdings", "investment holdings + value"],
    ["get_recurring_merchants", "recurring charges: cadence, next charge, price changes"],
    ["get_net_worth", "assets − liabilities"],
    ["get_cash_flow / compare_periods", "income vs outflow over time, period deltas"],
    ["chart_*", "deterministic chart specs the agent can render"],
  ];
  const WRITE_TOOLS = [
    ["set_transaction_category", "override the category on one transaction"],
    ["bulk_set_category_by_merchant", "override every transaction for a merchant"],
    ["run_categorization", "kick off an AI categorization pass"],
    ["set_account_group", "reclassify an account (cash, brokerage, …)"],
    ["remember / forget", "write or delete assistant long-term memories"],
  ];

  return (
    <div className="space-y-6">
      {revealed && (
        <div className="card-elevated mfade mfade-1 border border-primary/30">
          <div className="eyebrow text-primary">Copy now — won&apos;t be shown again</div>
          <div className="mt-3 flex items-center gap-3">
            <code className="flex-1 overflow-x-auto rounded-lg bg-surface px-4 py-3 font-mono text-sm">
              {revealed}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(revealed)}
              className="btn btn-tonal"
            >
              <Copy size={16} strokeWidth={2} />
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Endpoint summary */}
      <div className="card-elevated mfade mfade-1">
        <div className="eyebrow">MCP endpoint</div>
        <code className="mt-3 block rounded-lg bg-surface px-4 py-3 font-mono text-sm text-primary">
          {endpoint}
        </code>
        <p className="body-m mt-3 text-on-surface-variant">
          Send a bearer-token request to this URL from any MCP-capable client. Tools execute
          against <em>your</em> data only.
        </p>
      </div>

      {/* Tokens */}
      <section className="card-elevated mfade mfade-2">
        <h2 className="title-l">Bearer tokens</h2>
        <form onSubmit={create} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <div className="tf flex-1">
            <input
              id="label"
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder=" "
              className="tf-input"
            />
            <label htmlFor="label" className="tf-label">
              Label (e.g. hermes-laptop)
            </label>
          </div>
          <div className="tf sm:w-56">
            <select
              id="access"
              value={access}
              onChange={(e) => setAccess(e.target.value as "read" | "write")}
              className="tf-input"
            >
              <option value="read">Read-only</option>
              <option value="write">Read &amp; write</option>
            </select>
            <label htmlFor="access" className="tf-label">
              Access
            </label>
          </div>
          <button type="submit" className="btn btn-filled self-start" style={{ height: 56 }}>
            <Plus size={18} strokeWidth={2} />
            Generate
          </button>
        </form>
        <p className="body-s mt-3 text-on-surface-variant">
          Read-only tokens cannot see or call the tools that change your data — the server refuses
          them, and they are omitted from <code className="font-mono">tools/list</code>.
        </p>

        <div className="mt-6 -mx-6 -mb-6">
          <DataTable className="rounded-none rounded-b-2xl bg-transparent">
            <Thead>
              <Tr>
                <Th>Label</Th>
                <Th>Prefix</Th>
                <Th>Access</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th align="right"></Th>
              </Tr>
            </Thead>
            <tbody>
              {tokens.map((t) => (
                <Tr key={t.id}>
                  <Td>{t.label}</Td>
                  <Td mono className="text-primary">{t.tokenPrefix}…</Td>
                  <Td>
                    <span className={canWrite(t.scopes) ? "badge badge-primary" : "badge"}>
                      {canWrite(t.scopes) ? "read & write" : "read-only"}
                    </span>
                  </Td>
                  <Td mono className="text-on-surface-variant">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </Td>
                  <Td mono className="text-on-surface-variant">
                    {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}
                  </Td>
                  <Td align="right">
                    {t.revokedAt ? (
                      <span className="badge">revoked</span>
                    ) : (
                      <button onClick={() => revoke(t.id)} className="btn btn-text-error">
                        Revoke
                      </button>
                    )}
                  </Td>
                </Tr>
              ))}
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={6} className="body-m px-4 py-12 text-center text-on-surface-variant">
                    No tokens yet. Generate one to expose your data to external agents.
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </div>
      </section>

      {/* Tools */}
      <section className="card-elevated mfade mfade-3">
        <h2 className="title-l">Tools exposed</h2>
        <p className="body-m mt-1 text-on-surface-variant">
          Always scoped to the bearer-token owner (and their household, where data is shared).
        </p>

        <div className="eyebrow mt-6">Available to every token</div>
        <ul className="mt-2 divide-y divide-outline-variant">
          {READ_TOOLS.map(([name, desc]) => (
            <li key={name} className="grid grid-cols-12 gap-4 py-3">
              <code className="title-s col-span-12 font-mono text-primary sm:col-span-4">
                {name}
              </code>
              <span className="body-m col-span-12 text-on-surface-variant sm:col-span-8">
                {desc}
              </span>
            </li>
          ))}
        </ul>

        <div className="eyebrow mt-8">Requires a read &amp; write token</div>
        <ul className="mt-2 divide-y divide-outline-variant">
          {WRITE_TOOLS.map(([name, desc]) => (
            <li key={name} className="grid grid-cols-12 gap-4 py-3">
              <code className="title-s col-span-12 font-mono text-tertiary sm:col-span-4">
                {name}
              </code>
              <span className="body-m col-span-12 text-on-surface-variant sm:col-span-8">
                {desc}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Snippets */}
      <section className="card-elevated mfade mfade-4">
        <h2 className="title-l">Wire it up</h2>
        <div className="mt-6 space-y-6">
          <Snippet
            tag="01"
            title="Hermes Agent (Nous Research)"
            subtitle={
              <>
                Hermes picks up MCP servers via <code className="font-mono">hermes mcp add</code>.
                Once added, any chat or skill can call OpenCoffer tools.
              </>
            }
            code={hermesSnippet}
          />
          <Snippet
            tag="02"
            title="Claude Desktop"
            subtitle={
              <>
                Add to{" "}
                <code className="font-mono">
                  ~/Library/Application Support/Claude/claude_desktop_config.json
                </code>{" "}
                on macOS — then restart Claude.
              </>
            }
            code={claudeDesktop}
          />
          <Snippet
            tag="03"
            title="Cursor / VS Code"
            subtitle={
              <>
                Add to <code className="font-mono">.cursor/mcp.json</code> in your workspace.
              </>
            }
            code={cursorSnippet}
          />
        </div>
      </section>
    </div>
  );
}

function Snippet({
  tag,
  title,
  subtitle,
  code,
}: {
  tag: string;
  title: string;
  subtitle: React.ReactNode;
  code: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid grid-cols-12 gap-x-6 gap-y-4 rounded-2xl bg-surface-container p-6">
      <div className="col-span-12 md:col-span-4">
        <div className="badge badge-primary">{tag}</div>
        <div className="title-m mt-3">{title}</div>
        <div className="body-m mt-2 text-on-surface-variant">{subtitle}</div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="btn btn-tonal mt-5"
        >
          {copied ? <Check size={16} strokeWidth={2.5} /> : <Copy size={16} strokeWidth={2} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="col-span-12 overflow-x-auto rounded-xl bg-surface p-4 font-mono text-xs leading-relaxed text-on-surface md:col-span-8">
        {code}
      </pre>
    </div>
  );
}
