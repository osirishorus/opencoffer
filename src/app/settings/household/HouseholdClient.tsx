"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, UserPlus, LogOut } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmDialog";

type Member = {
  userId: string;
  role: string;
  joinedAt: string;
  email: string | null;
  name: string | null;
};

export function HouseholdClient({
  you,
  household,
  members,
}: {
  you: string;
  household: { id: string; name: string; ownerUserId: string };
  members: Member[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [name, setName] = useState(household.name);
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isOwner = household.ownerUserId === you;

  const rename = async () => {
    setBusy(true);
    await fetch("/api/household", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    router.refresh();
  };

  const newInvite = async () => {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/household/invite", { method: "POST" });
    const j = await r.json();
    setBusy(false);
    if (r.ok) setInvite(j);
    else setErr(j.error ?? "Failed");
  };

  const leave = async () => {
    const ok = await confirm({
      title: "Leave household?",
      body: "Leave this household? You'll be given a fresh personal one.",
      confirmLabel: "Leave",
    });
    if (!ok) return;
    const r = await fetch("/api/household", { method: "DELETE" });
    const j = await r.json();
    if (!r.ok) setErr(j.error ?? "Couldn't leave");
    else router.refresh();
  };

  return (
    <div className="space-y-6">
      <section className="card-elevated mfade mfade-1">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="eyebrow">Household name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="tf" />
          </div>
          <button onClick={rename} disabled={busy} className="btn btn-filled">
            Save
          </button>
        </div>
        <p className="body-s mt-2 text-on-surface-variant">
          Members see the same dashboards, accounts, transactions, budgets and alerts. Personal
          things (chat threads, your own LLM keys, your MCP tokens) stay private.
        </p>
      </section>

      <section className="card-elevated mfade mfade-2">
        <div className="flex items-center justify-between">
          <h2 className="title-l">Members ({members.length})</h2>
          {!isOwner && (
            <button onClick={leave} className="btn btn-text-error">
              <LogOut size={16} /> Leave
            </button>
          )}
        </div>
        <ul className="mt-4 divide-y divide-outline-variant">
          {members.map((m) => (
            <li key={m.userId} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-3">
              <div>
                <div className="body-m text-on-surface">{m.name ?? m.email ?? m.userId}</div>
                {m.email && m.name && (
                  <div className="body-s text-on-surface-variant">{m.email}</div>
                )}
              </div>
              <span className="badge">{m.role}</span>
              <span className="body-s text-on-surface-variant">
                joined {formatDate(m.joinedAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {isOwner && (
        <section className="card-elevated mfade mfade-3">
          <div className="flex items-center justify-between">
            <h2 className="title-l">Invite</h2>
            <button onClick={newInvite} disabled={busy} className="btn btn-filled">
              <UserPlus size={16} /> {busy ? "Generating…" : "New invite link"}
            </button>
          </div>
          {invite && (
            <div className="mt-4 rounded-2xl bg-surface-container p-4">
              <div className="eyebrow">Share this link (valid 7 days, single use)</div>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-lg bg-surface px-3 py-2 font-mono text-sm">
                  {invite.url}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(invite.url)}
                  className="btn btn-text"
                >
                  <Copy size={14} /> Copy
                </button>
              </div>
              <p className="body-s mt-2 text-on-surface-variant">
                The recipient just needs an account on this instance, then visits the link.
              </p>
            </div>
          )}
          {err && <p className="body-s mt-3 text-error">{err}</p>}
        </section>
      )}
    </div>
  );
}
