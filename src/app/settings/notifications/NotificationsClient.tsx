"use client";

import { useState } from "react";
import { BellRing, Plus, Send, Trash2 } from "lucide-react";
import { DataTable, Th, Td, Tr, Thead } from "@/components/DataTable";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toaster";

type Channel = {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
  urlHint?: string | null;
};

export function NotificationsClient({ initial }: { initial: Channel[] }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [channels, setChannels] = useState(initial);
  const emptyForm = {
    kind: "ntfy",
    label: "",
    url: "",
    topic: "",
    authToken: "",
    userKey: "",
    digest: false,
  };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const r = await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!r.ok) {
      toast.error("Channel creation failed", (await r.json().catch(() => null))?.error ?? "Check the URL.");
      return;
    }
    const created = await r.json();
    setChannels((cs) => [created, ...cs]);
    setForm(emptyForm);
    toast.success("Notification channel added");
  };

  const toggle = async (channel: Channel) => {
    const r = await fetch(`/api/notifications/${channel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !channel.enabled }),
    });
    if (!r.ok) {
      toast.error("Channel update failed");
      return;
    }
    const updated = await r.json();
    setChannels((cs) => cs.map((c) => (c.id === channel.id ? { ...c, ...updated } : c)));
  };

  const test = async (channel: Channel) => {
    setTesting(channel.id);
    const r = await fetch(`/api/notifications/${channel.id}/test`, { method: "POST" });
    setTesting(null);
    const json = await r.json().catch(() => null);
    if (!r.ok || !json?.ok) {
      const message = json?.error ?? "Test failed";
      setChannels((cs) => cs.map((c) => (c.id === channel.id ? { ...c, lastError: message } : c)));
      toast.error("Test failed", message);
      return;
    }
    setChannels((cs) =>
      cs.map((c) =>
        c.id === channel.id
          ? { ...c, lastSuccessAt: new Date().toISOString(), lastError: null }
          : c,
      ),
    );
    toast.success("Test sent");
  };

  const del = async (channel: Channel) => {
    const ok = await confirm({
      title: "Delete channel?",
      body: `Delete ${channel.label}?`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const r = await fetch(`/api/notifications/${channel.id}`, { method: "DELETE" });
    if (!r.ok) {
      toast.error("Delete failed");
      return;
    }
    setChannels((cs) => cs.filter((c) => c.id !== channel.id));
    toast.success("Channel deleted");
  };

  const isPushover = form.kind === "pushover";
  const needsTopic = form.kind === "ntfy";
  const needsToken = form.kind === "ntfy";
  const needsUrl = !isPushover;

  return (
    <div className="space-y-8">
      <section className="card-elevated">
        <div className="flex items-start gap-3">
          <BellRing size={22} strokeWidth={2} className="mt-1 text-primary" />
          <div>
            <h2 className="title-l">Channels</h2>
            <p className="body-m mt-1 text-on-surface-variant">
              URLs and tokens are AES-256-GCM encrypted at rest.
            </p>
          </div>
        </div>

        <div className="mt-6 -mx-6 -mb-6">
          <DataTable className="rounded-none rounded-b-2xl bg-transparent">
            <Thead>
              <Tr>
                <Th>Label</Th>
                <Th>Kind</Th>
                <Th>URL</Th>
                <Th>Status</Th>
                <Th align="right"></Th>
              </Tr>
            </Thead>
            <tbody>
              {channels.map((channel) => (
                <Tr key={channel.id}>
                  <Td>{channel.label}</Td>
                  <Td mono className="text-on-surface-variant">{channel.kind}</Td>
                  <Td mono className="text-xs text-on-surface-variant">{channel.urlHint ?? "redacted"}</Td>
                  <Td>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={channel.enabled}
                        onChange={() => toggle(channel)}
                        className="h-5 w-5 accent-[hsl(var(--md-primary))]"
                      />
                      <span className="body-s text-on-surface-variant">
                        {channel.lastError
                          ? channel.lastError.slice(0, 80)
                          : channel.lastSuccessAt
                            ? "Last test succeeded"
                            : "Ready"}
                      </span>
                    </label>
                  </Td>
                  <Td align="right">
                    <button onClick={() => test(channel)} disabled={testing === channel.id} className="btn btn-text">
                      <Send size={14} strokeWidth={2} />
                      {testing === channel.id ? "Sending…" : "Send test"}
                    </button>
                    <button onClick={() => del(channel)} className="btn btn-text-error">
                      <Trash2 size={14} strokeWidth={2} />
                      Delete
                    </button>
                  </Td>
                </Tr>
              ))}
              {channels.length === 0 && (
                <tr>
                  <td colSpan={5} className="body-m px-4 py-12 text-center text-on-surface-variant">
                    No notification channels yet.
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </div>
      </section>

      <section className="card-elevated">
        <h2 className="title-l">Add channel</h2>
        <form onSubmit={submit} className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="tf">
            <select
              id="kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="tf-input appearance-none pr-10"
            >
              <option value="ntfy">ntfy</option>
              <option value="pushover">Pushover</option>
              <option value="discord">Discord</option>
              <option value="slack">Slack</option>
              <option value="webhook">Webhook</option>
            </select>
            <label htmlFor="kind" className="tf-label">Kind</label>
          </div>
          <div className="tf">
            <input
              id="label"
              required
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder=" "
              className="tf-input"
            />
            <label htmlFor="label" className="tf-label">Label</label>
          </div>
          {needsUrl && (
            <div className="tf md:col-span-2">
              <input
                id="url"
                required
                type="url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder=" "
                className="tf-input"
              />
              <label htmlFor="url" className="tf-label">URL</label>
            </div>
          )}
          {isPushover && (
            <>
              <div className="tf">
                <input
                  id="pushoverToken"
                  required
                  type="password"
                  value={form.authToken}
                  onChange={(e) => setForm({ ...form, authToken: e.target.value })}
                  placeholder=" "
                  className="tf-input"
                />
                <label htmlFor="pushoverToken" className="tf-label">Application token</label>
              </div>
              <div className="tf">
                <input
                  id="pushoverUser"
                  required
                  value={form.userKey}
                  onChange={(e) => setForm({ ...form, userKey: e.target.value })}
                  placeholder=" "
                  className="tf-input"
                />
                <label htmlFor="pushoverUser" className="tf-label">User key</label>
              </div>
            </>
          )}
          {needsTopic && (
            <div className="tf">
              <input
                id="topic"
                value={form.topic}
                onChange={(e) => setForm({ ...form, topic: e.target.value })}
                placeholder=" "
                className="tf-input"
              />
              <label htmlFor="topic" className="tf-label">Topic</label>
            </div>
          )}
          {needsToken && (
            <div className="tf">
              <input
                id="token"
                type="password"
                value={form.authToken}
                onChange={(e) => setForm({ ...form, authToken: e.target.value })}
                placeholder=" "
                className="tf-input"
              />
              <label htmlFor="token" className="tf-label">Auth token</label>
            </div>
          )}
          <label className="flex items-center gap-3 md:col-span-2">
            <input
              type="checkbox"
              checked={form.digest}
              onChange={(e) => setForm({ ...form, digest: e.target.checked })}
              className="h-4 w-4"
            />
            <span className="body-m text-on-surface-variant">
              Also send scheduled digest summaries to this channel
            </span>
          </label>
          <div className="md:col-span-2">
            <button type="submit" disabled={saving} className="btn btn-filled">
              <Plus size={18} strokeWidth={2} />
              {saving ? "Saving…" : "Save channel"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
