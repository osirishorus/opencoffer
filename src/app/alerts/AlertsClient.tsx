"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Plus, Play, Trash2 } from "lucide-react";

type Alert = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  createdAt: string;
  readAt: string | null;
};
type Rule = {
  id: string;
  kind: string;
  threshold: number | null;
  category: string | null;
  accountId: string | null;
  enabled: boolean;
  createdAt: string;
};
type AccountOption = { id: string; name: string };
type Form = { kind: string; threshold?: number; category?: string; accountId?: string };

const DEFAULT_THRESHOLD: Record<string, number | undefined> = {
  large_tx: 500,
  category_overspend: undefined,
  low_balance: 100,
  recurring_price_increase: 5,
};

const inputClass =
  "h-12 w-full rounded-2xl border border-outline bg-surface px-4 text-on-surface focus:border-primary focus:outline-none disabled:opacity-50";

export function AlertsClient({
  initial,
  rules,
  accounts,
}: {
  initial: Alert[];
  rules: Rule[];
  accounts: AccountOption[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>({ kind: "large_tx", threshold: 500 });
  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? "account";

  const describe = (r: Rule) => {
    switch (r.kind) {
      case "large_tx":
        return `Any transaction ≥ $${r.threshold?.toLocaleString()}`;
      case "category_overspend":
        return `${r.category} budget overrun`;
      case "low_balance":
        return `${accountName(r.accountId)} balance ≤ $${r.threshold?.toLocaleString()}`;
      case "recurring_price_increase":
        return `Recurring charge goes up ≥ ${r.threshold ?? 5}%`;
      default:
        return r.kind;
    }
  };

  const markAllRead = async () => {
    const unread = items.filter((a) => !a.readAt).map((a) => a.id);
    if (!unread.length) return;
    await fetch("/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: unread }),
    });
    setItems((xs) => xs.map((a) => ({ ...a, readAt: a.readAt ?? new Date().toISOString() })));
  };

  const evaluate = async () => {
    setRunning(true);
    try {
      await fetch("/api/alerts?action=evaluate", { method: "POST" });
      router.refresh();
    } finally {
      setRunning(false);
    }
  };

  const saveRule = async (body: Record<string, unknown>) => {
    setError(null);
    const res = await fetch("/api/alerts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(j?.error ?? "Couldn't save rule");
      return false;
    }
    router.refresh();
    return true;
  };

  const addRule = async () => {
    if (await saveRule(form)) setForm({ kind: form.kind, threshold: DEFAULT_THRESHOLD[form.kind] });
  };

  const deleteRule = async (id: string) => {
    setError(null);
    const res = await fetch(`/api/alerts?ruleId=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) setError("Couldn't delete rule");
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <section className="card-elevated">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="title-l flex items-center gap-2">
            <Bell size={18} /> Notifications
          </h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={evaluate} disabled={running} className="btn btn-outlined">
              <Play size={14} /> {running ? "Evaluating…" : "Run rules now"}
            </button>
            <button onClick={markAllRead} className="btn btn-text">
              Mark all read
            </button>
          </div>
        </div>
        <ul className="mt-4 divide-y divide-outline-variant">
          {items.map((a) => (
            <li
              key={a.id}
              className={`grid grid-cols-[12px_1fr_auto] items-center gap-3 py-3 ${
                a.readAt ? "opacity-60" : ""
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${a.readAt ? "bg-on-surface-variant" : "bg-primary"}`}
              />
              <div className="min-w-0">
                <div className="body-m text-on-surface">{a.title}</div>
                {a.body && <div className="body-s text-on-surface-variant">{a.body}</div>}
              </div>
              <div className="body-s text-on-surface-variant">
                {new Date(a.createdAt).toLocaleString()}
              </div>
            </li>
          ))}
          {items.length === 0 && (
            <li className="body-m py-10 text-center text-on-surface-variant">
              No alerts yet. Add a rule and click <em>Run rules now</em>.
            </li>
          )}
        </ul>
      </section>

      <section className="card-elevated">
        <h2 className="title-l">Rules</h2>
        <p className="body-m mt-1 text-on-surface-variant">
          Rules run after every sync. You can also trigger manually above.
        </p>
        <ul className="mt-4 divide-y divide-outline-variant">
          {rules.map((r) => (
            <li key={r.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 py-3">
              <div className="body-m">
                {describe(r)}
                {!r.enabled && <span className="badge ml-2">disabled</span>}
              </div>
              <button
                onClick={() =>
                  saveRule({
                    id: r.id,
                    kind: r.kind,
                    threshold: r.threshold,
                    category: r.category,
                    accountId: r.accountId,
                    enabled: !r.enabled,
                  })
                }
                className="btn btn-text"
              >
                {r.enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={() => deleteRule(r.id)}
                className="btn btn-text"
                aria-label="Delete rule"
                title="Delete rule"
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
          {rules.length === 0 && (
            <li className="body-m py-6 text-center text-on-surface-variant">No rules yet.</li>
          )}
        </ul>

        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-[220px_1fr_180px_auto]">
          <select
            value={form.kind}
            onChange={(e) =>
              setForm({ kind: e.target.value, threshold: DEFAULT_THRESHOLD[e.target.value] })
            }
            className={inputClass}
          >
            <option value="large_tx">Large transaction</option>
            <option value="category_overspend">Category overspend</option>
            <option value="low_balance">Low balance</option>
            <option value="recurring_price_increase">Subscription price increase</option>
          </select>
          {form.kind === "low_balance" ? (
            <select
              value={form.accountId ?? ""}
              onChange={(e) => setForm({ ...form, accountId: e.target.value || undefined })}
              className={inputClass}
            >
              <option value="">Choose an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={form.category ?? ""}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              placeholder="Category (overspend only)"
              disabled={form.kind !== "category_overspend"}
              className={inputClass}
            />
          )}
          <input
            type="number"
            min={0}
            value={form.threshold ?? ""}
            onChange={(e) =>
              setForm({ ...form, threshold: e.target.value === "" ? undefined : Number(e.target.value) })
            }
            placeholder={form.kind === "recurring_price_increase" ? "Min increase (%)" : "Threshold ($)"}
            disabled={form.kind === "category_overspend"}
            className={inputClass}
          />
          <button onClick={addRule} className="btn btn-filled">
            <Plus size={16} /> Add rule
          </button>
        </div>
        {error && <p className="body-s mt-3 text-error">{error}</p>}
      </section>
    </div>
  );
}
