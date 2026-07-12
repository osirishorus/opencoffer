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
  enabled: boolean;
  createdAt: string;
};

export function AlertsClient({ initial, rules }: { initial: Alert[]; rules: Rule[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [running, setRunning] = useState(false);
  const [form, setForm] = useState<{ kind: string; threshold?: number; category?: string }>({
    kind: "large_tx",
    threshold: 500,
  });

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

  const addRule = async () => {
    await fetch("/api/alerts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
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
            <li key={r.id} className="grid grid-cols-[1fr_auto] items-center gap-3 py-3">
              <div className="body-m">
                {r.kind === "large_tx" && `Any transaction ≥ $${r.threshold?.toLocaleString()}`}
                {r.kind === "category_overspend" && `${r.category} budget overrun`}
                {r.kind === "low_balance" && `Account balance ≤ $${r.threshold?.toLocaleString()}`}
                {r.kind === "card_dormant" && `Credit card unused for ${r.threshold?.toLocaleString()}+ days (flags annual fees)`}
                {r.kind === "sync_stale" && `Bank sync stale for ${r.threshold?.toLocaleString()}+ hours`}
                {!r.enabled && <span className="badge ml-2">disabled</span>}
              </div>
              <button
                onClick={async () => {
                  await fetch("/api/alerts", {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      id: r.id,
                      kind: r.kind,
                      threshold: r.threshold,
                      category: r.category,
                      enabled: !r.enabled,
                    }),
                  });
                  router.refresh();
                }}
                className="btn btn-text"
              >
                {r.enabled ? "Disable" : "Enable"}
              </button>
            </li>
          ))}
          {rules.length === 0 && (
            <li className="body-m py-6 text-center text-on-surface-variant">No rules yet.</li>
          )}
        </ul>

        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr_180px_auto]">
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
            className="h-12 w-full rounded-2xl border border-outline bg-surface px-4 text-on-surface focus:border-primary focus:outline-none disabled:opacity-50"
          >
            <option value="large_tx">Large transaction</option>
            <option value="category_overspend">Category overspend</option>
            <option value="low_balance">Low balance (per account; configure manually)</option>
            <option value="card_dormant">Card dormancy (unused credit cards)</option>
            <option value="sync_stale">Bank sync health (no fresh data)</option>
          </select>
          <input
            value={form.category ?? ""}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            placeholder="Category (overspend only)"
            disabled={form.kind !== "category_overspend"}
            className="h-12 w-full rounded-2xl border border-outline bg-surface px-4 text-on-surface focus:border-primary focus:outline-none disabled:opacity-50"
          />
          <input
            type="number"
            value={form.threshold ?? ""}
            onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })}
            placeholder={
              form.kind === "card_dormant" ? "Days without a purchase"
              : form.kind === "sync_stale" ? "Hours without fresh data"
              : "Threshold ($)"
            }
            className="h-12 w-full rounded-2xl border border-outline bg-surface px-4 text-on-surface focus:border-primary focus:outline-none disabled:opacity-50"
          />
          <button onClick={addRule} className="btn btn-filled">
            <Plus size={16} /> Add rule
          </button>
        </div>
      </section>
    </div>
  );
}

void Trash2;
