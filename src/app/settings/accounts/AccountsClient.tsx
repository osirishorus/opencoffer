"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Amount } from "@/components/Amount";
import { setAccountGroup } from "./actions";
import { Check, RotateCcw, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toaster";
import { ACCOUNT_GROUPS, ACCOUNT_TYPES, type AccountGroup, type AccountType } from "@/lib/manualAccounts";

const GROUPS = ACCOUNT_GROUPS;

type Account = {
  id: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  systemGroup: string;
  userOverride: string | null;
  currentBalance: number;
  currency: string | null;
  source: string;
};

export function AccountsClient({ accounts }: { accounts: Account[] }) {
  const [items, setItems] = useState(accounts);
  const manualAccounts = items.filter((account) => account.source === "manual");

  return (
    <div className="space-y-6">
      <ManualAccountsPanel
        accounts={manualAccounts}
        onCreated={(account) => setItems((current) => [...current, account])}
        onUpdated={(account) => setItems((current) => current.map((item) => (item.id === account.id ? account : item)))}
        onDeleted={(id) => setItems((current) => current.filter((item) => item.id !== id))}
      />

      <div className="card-elevated p-0">
        <div className="divide-y divide-outline-variant">
          {items.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
          {items.length === 0 && (
            <div className="p-6 body-m text-center text-on-surface-variant">
              No accounts connected yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ManualAccountsPanel({
  accounts,
  onCreated,
  onUpdated,
  onDeleted,
}: {
  accounts: Account[];
  onCreated: (account: Account) => void;
  onUpdated: (account: Account) => void;
  onDeleted: (id: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("depository");
  const [group, setGroup] = useState<AccountGroup>("cash");
  const [balance, setBalance] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const response = await fetch("/api/manual-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        type,
        accountGroup: group,
        balance: Number(balance),
        currency,
      }),
    });
    setSaving(false);
    if (!response.ok) {
      toast.error("Manual account not created", "Check the name, balance, and currency.");
      return;
    }
    const account = await response.json();
    onCreated(toClientAccount(account));
    setName("");
    setBalance("");
    setCurrency("USD");
    toast.success("Manual account created");
    router.refresh();
  }

  async function updateBalance(account: Account, nextBalance: string) {
    const response = await fetch(`/api/manual-accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: Number(nextBalance) }),
    });
    if (!response.ok) {
      toast.error("Balance update failed");
      return;
    }
    onUpdated(toClientAccount(await response.json()));
    toast.success("Balance saved");
    router.refresh();
  }

  async function deleteAccount(account: Account) {
    const ok = await confirm({
      title: "Delete manual account?",
      body: `Delete "${account.name}" and its imported transactions? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const response = await fetch(`/api/manual-accounts/${account.id}`, { method: "DELETE" });
    if (!response.ok) {
      toast.error("Delete failed");
      return;
    }
    onDeleted(account.id);
    toast.success("Manual account deleted");
    router.refresh();
  }

  return (
    <section className="card-elevated space-y-4">
      <div>
        <h2 className="title-l">Manual accounts</h2>
        <p className="body-m mt-1 text-on-surface-variant">
          Add cash, crypto, CDs, private loans, or other balances that SimpleFIN cannot sync.
        </p>
      </div>

      <form onSubmit={create} className="grid grid-cols-1 gap-3 lg:grid-cols-6">
        <label className="block lg:col-span-2">
          <span className="eyebrow">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="tf" required maxLength={120} />
        </label>
        <label className="block">
          <span className="eyebrow">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)} className="tf capitalize">
            {ACCOUNT_TYPES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Group</span>
          <select value={group} onChange={(e) => setGroup(e.target.value as AccountGroup)} className="tf capitalize">
            {GROUPS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="eyebrow">Balance</span>
          <input value={balance} onChange={(e) => setBalance(e.target.value)} className="tf" type="number" step="0.01" required />
        </label>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="block">
            <span className="eyebrow">Currency</span>
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className="tf uppercase" maxLength={3} />
          </label>
          <button type="submit" disabled={saving || !name.trim() || !balance.trim()} className="btn btn-filled self-end">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} strokeWidth={2} />}
            Add
          </button>
        </div>
      </form>

      <div className="divide-y divide-outline-variant rounded-2xl bg-surface-low">
        {accounts.map((account) => (
          <ManualAccountRow
            key={account.id}
            account={account}
            onUpdate={onUpdated}
            onSaveBalance={updateBalance}
            onDelete={deleteAccount}
          />
        ))}
        {accounts.length === 0 && (
          <div className="body-m px-4 py-8 text-center text-on-surface-variant">
            No manual accounts yet.
          </div>
        )}
      </div>
    </section>
  );
}

function ManualAccountRow({
  account,
  onUpdate,
  onSaveBalance,
  onDelete,
}: {
  account: Account;
  onUpdate: (account: Account) => void;
  onSaveBalance: (account: Account, balance: string) => Promise<void>;
  onDelete: (account: Account) => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState(account.name);
  const [group, setGroup] = useState<AccountGroup>((account.userOverride ?? account.systemGroup) as AccountGroup);
  const [balance, setBalance] = useState(String(account.currentBalance));
  const [saving, setSaving] = useState<null | "details" | "balance">(null);

  async function saveDetails() {
    setSaving("details");
    const response = await fetch(`/api/manual-accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, accountGroup: group }),
    });
    setSaving(null);
    if (!response.ok) {
      toast.error("Manual account update failed");
      return;
    }
    onUpdate(toClientAccount(await response.json()));
    toast.success("Manual account saved");
  }

  async function saveBalance() {
    setSaving("balance");
    await onSaveBalance(account, balance);
    setSaving(null);
  }

  return (
    <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1.5fr)_11rem_minmax(0,1fr)_auto_auto] lg:items-end">
      <label className="block">
        <span className="eyebrow">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="tf" />
      </label>
      <label className="block">
        <span className="eyebrow">Group</span>
        <select value={group} onChange={(e) => setGroup(e.target.value as AccountGroup)} className="tf capitalize">
          {GROUPS.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="eyebrow">Balance</span>
        <input value={balance} onChange={(e) => setBalance(e.target.value)} className="tf" type="number" step="0.01" />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={saveBalance} disabled={saving != null} className="btn btn-filled">
          {saving === "balance" ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} strokeWidth={2} />}
          Balance
        </button>
        <button type="button" onClick={saveDetails} disabled={saving != null || !name.trim()} className="btn btn-outlined">
          {saving === "details" ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} strokeWidth={2} />}
          Details
        </button>
      </div>
      <button type="button" onClick={() => onDelete(account)} className="btn-icon self-center justify-self-start lg:self-end" title="Delete manual account">
        <Trash2 size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

function AccountRow({ account }: { account: Account }) {
  const effective = (account.userOverride ?? account.systemGroup) as AccountGroup;
  const [group, setGroup] = useState<AccountGroup>(effective);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const overridden = account.userOverride != null;

  function save(next: AccountGroup | "default") {
    setStatus("idle");
    startTransition(async () => {
      try {
        await setAccountGroup(account.id, next);
        if (next !== "default") setGroup(next);
        else setGroup(account.systemGroup as AccountGroup);
        setStatus("saved");
        setTimeout(() => setStatus("idle"), 1500);
      } catch (e) {
        console.error(e);
        setStatus("error");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-4 p-4 md:p-5">
      <div className="min-w-0 flex-1">
        <div className="body-m truncate text-on-surface">
          {account.name}
          {account.source === "manual" && <span className="badge ml-2">Manual</span>}
          {account.mask && (
            <span className="ml-2 font-mono text-xs text-on-surface-variant">
              ··{account.mask}
            </span>
          )}
        </div>
        <div className="body-s text-on-surface-variant">
          {account.type}
          {account.subtype ? ` · ${account.subtype}` : ""}
          <span className="mx-1.5">·</span>
          <span className="font-mono tabular-nums">
            <Amount value={account.currentBalance} currency={account.currency} />
          </span>
          {overridden && (
            <span className="ml-2 rounded-full bg-secondary-container px-2 py-0.5 text-[10px] uppercase tracking-wide text-on-secondary-container">
              custom
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={group}
          disabled={pending}
          onChange={(e) => save(e.target.value as AccountGroup)}
          className="h-10 rounded-full border border-outline bg-surface px-3 text-sm capitalize text-on-surface focus:border-primary focus:outline-none disabled:opacity-50"
        >
          {GROUPS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        {overridden && (
          <button
            type="button"
            disabled={pending}
            onClick={() => save("default")}
            className="btn-icon"
            title={`Reset to system-assigned (${account.systemGroup})`}
            aria-label="Reset to system-assigned group"
          >
            <RotateCcw size={16} strokeWidth={1.75} />
          </button>
        )}
        <span className="w-6">
          {pending ? (
            <Loader2 size={16} className="animate-spin text-on-surface-variant" />
          ) : status === "saved" ? (
            <Check size={16} className="text-success" />
          ) : status === "error" ? (
            <span className="text-xs text-error">!</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function toClientAccount(account: {
  id: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  accountGroup: string;
  userAccountGroup: string | null;
  currentBalance: string | number | null;
  isoCurrencyCode: string | null;
  source: string;
}): Account {
  return {
    id: account.id,
    name: account.name,
    officialName: account.officialName,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    systemGroup: account.accountGroup,
    userOverride: account.userAccountGroup,
    currentBalance: Number(account.currentBalance ?? 0),
    currency: account.isoCurrencyCode,
    source: account.source,
  };
}
