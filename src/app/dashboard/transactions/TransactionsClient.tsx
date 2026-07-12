"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DataTable, Th, Td, Tr, Thead } from "@/components/DataTable";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Download, Pencil, Plus, Search, Trash2, Upload, Wand2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toaster";
import { parseCsv } from "@/lib/csv";

type Row = {
  id: string;
  date: string;
  amount: number;
  name: string;
  merchant: string | null;
  overrideMerchant: string | null;
  category: string | null;
  aiCategory: string | null;
  overrideCategory: string | null;
  aiSubcategory: string | null;
  overrideSubcategory: string | null;
  isTransfer: boolean;
  overrideIsTransfer: boolean | null;
  isRecurring: boolean;
  userNotes: string | null;
  pending: boolean;
  accountId: string | null;
  currency: string | null;
  accountName: string | null;
  accountMask: string | null;
  accountSource: string | null;
};

type Rule = {
  id: string;
  field: string;
  matchType: string;
  pattern: string;
  category: string;
  subcategory: string | null;
  enabled: boolean;
  appliedCount: number;
  createdAt: string;
};

type AccountOption = {
  id: string;
  name: string;
  type: string;
  source: string;
  currency: string | null;
};

const CATEGORIES = [
  "Food & Dining", "Groceries", "Coffee & Cafes", "Transportation", "Gas", "Travel",
  "Shopping", "Entertainment", "Subscriptions", "Bills & Utilities", "Phone & Internet",
  "Healthcare", "Insurance", "Education", "Personal Care", "Home & Maintenance",
  "Rent & Mortgage", "Taxes", "Charity & Gifts", "Cash & ATM", "Fees",
  "Investments", "Retirement Contributions",
  "Income — Salary", "Income — Dividend", "Income — Refund", "Income — Other",
  "Transfer", "Other",
];
const INITIAL_VISIBLE = 40;
const VISIBLE_STEP = 40;

export function TransactionsClient({
  rows,
  initialRules,
  accounts,
}: {
  rows: Row[];
  initialRules: Rule[];
  accounts: AccountOption[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [editing, setEditing] = useState<Row | null>(null);
  const [ruleSource, setRuleSource] = useState<Row | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [items, setItems] = useState(rows);
  const [rules, setRules] = useState(initialRules);
  const exportHref = useMemo(() => {
    const params = new URLSearchParams();
    if (filter.trim()) params.set("search", filter.trim());
    return `/api/transactions/export${params.toString() ? `?${params.toString()}` : ""}`;
  }, [filter]);

  const filtered = useMemo(() => {
    if (!deferredFilter) return items;
    const f = deferredFilter.toLowerCase();
    return items.filter(
      (r) =>
        (r.merchant ?? r.name ?? "").toLowerCase().includes(f) ||
        (r.overrideCategory ?? r.aiCategory ?? r.category ?? "").toLowerCase().includes(f) ||
        (r.accountName ?? "").toLowerCase().includes(f),
    );
  }, [items, deferredFilter]);
  useEffect(() => setVisibleCount(INITIAL_VISIBLE), [deferredFilter]);
  const visible = filtered.slice(0, visibleCount);
  const canLoadMore = visibleCount < filtered.length;

  const toggleRule = async (rule: Rule) => {
    const r = await fetch(`/api/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    if (!r.ok) {
      toast.error("Rule update failed");
      return;
    }
    const json = await r.json();
    setRules((rs) => rs.map((item) => (item.id === rule.id ? json.rule : item)));
    toast.success(json.rule.enabled ? "Rule enabled" : "Rule disabled");
  };

  const deleteRule = async (rule: Rule) => {
    const ok = await confirm({
      title: "Delete rule?",
      body: `Delete the rule for "${rule.pattern}"? Existing transaction overrides will stay in place.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const r = await fetch(`/api/rules/${rule.id}`, { method: "DELETE" });
    if (!r.ok) {
      toast.error("Delete failed");
      return;
    }
    setRules((rs) => rs.filter((item) => item.id !== rule.id));
    toast.success("Rule deleted");
  };

  return (
    <div className="space-y-4">
      <section className="card-elevated">
        <details>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
            <div>
              <h2 className="title-m">Rules</h2>
              <p className="body-s text-on-surface-variant">
                Deterministic merchant and transaction-name categorization.
              </p>
            </div>
            <span className="badge">{rules.length}</span>
          </summary>
          <div className="mt-4 space-y-3">
            {rules.length === 0 ? (
              <div className="body-m rounded-2xl bg-surface-low px-4 py-6 text-center text-on-surface-variant">
                No rules yet. Create one from a transaction row.
              </div>
            ) : (
              rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-col gap-3 rounded-2xl bg-surface-low p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="title-s truncate text-on-surface">
                      {rule.field} {rule.matchType} <span aria-hidden>&quot;</span>{rule.pattern}<span aria-hidden>&quot;</span>
                    </div>
                    <div className="body-s mt-1 text-on-surface-variant">
                      {rule.category}
                      {rule.subcategory ? ` / ${rule.subcategory}` : ""} · applied {rule.appliedCount}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => toggleRule(rule)}
                        className="h-5 w-5 accent-[hsl(var(--md-primary))]"
                      />
                      <span className="body-s text-on-surface-variant">Enabled</span>
                    </label>
                    <button onClick={() => deleteRule(rule)} className="btn-icon" title="Delete rule">
                      <Trash2 size={16} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </details>
      </section>

      <div className="flex items-center gap-3">
        <div className="relative max-w-md flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by merchant, category, account…"
            className="tf pl-9"
          />
        </div>
        <a href={exportHref} className="btn btn-outlined">
          <Download size={16} strokeWidth={2} />
          Export CSV
        </a>
        <button type="button" onClick={() => setShowImport((value) => !value)} className="btn btn-filled">
          <Upload size={16} strokeWidth={2} />
          Import CSV
        </button>
      </div>

      {showImport && (
        <ImportPanel
          accounts={accounts}
          onImported={(inserted, skipped) => {
            toast.success(
              `Imported ${inserted} transaction${inserted === 1 ? "" : "s"}`,
              `${skipped} duplicate${skipped === 1 ? "" : "s"} skipped.`,
            );
            setShowImport(false);
            router.refresh();
          }}
        />
      )}

      <div className="md:hidden">
        {visible.length > 0 ? (
          <ul className="space-y-3">
            {visible.map((r) => (
              <TransactionCard
                key={r.id}
                row={r}
                onEdit={() => setEditing(r)}
                onCreateRule={() => setRuleSource(r)}
              />
            ))}
          </ul>
        ) : (
          <div className="body-m rounded-2xl bg-surface-low px-4 py-12 text-center text-on-surface-variant">
            No transactions match.
          </div>
        )}
      </div>

      <div className="hidden md:block">
        <DataTable>
          <Thead>
            <Tr>
              <Th>Date</Th>
              <Th>Merchant</Th>
              <Th>Category</Th>
              <Th>Account</Th>
              <Th align="right">Amount</Th>
              <Th align="right"></Th>
            </Tr>
          </Thead>
          <tbody>
            {visible.map((r) => {
              const eff = effectiveCategory(r);
              const merch = effectiveMerchant(r);
              const xfer = effectiveTransfer(r);
              const amt = r.amount;
              return (
                <Tr key={r.id} className={xfer ? "opacity-60" : ""}>
                  <Td mono className="text-on-surface-variant">{formatDate(r.date)}</Td>
                  <Td>
                    <div className="max-w-[36ch] truncate">
                      <span className="text-on-surface">{merch}</span>
                      <TransactionBadges row={r} />
                    </div>
                    {r.userNotes && (
                      <div className="body-s text-on-surface-variant">{r.userNotes}</div>
                    )}
                  </Td>
                  <Td className="text-on-surface-variant">{eff}</Td>
                  <Td className="text-on-surface-variant">
                    {r.accountName}
                    {r.accountSource === "manual" && <span className="badge ml-2">Manual</span>}
                    {r.accountMask && (
                      <span className="ml-1 font-mono text-xs">··{r.accountMask}</span>
                    )}
                  </Td>
                  <Td align="right" mono className="text-on-surface">
                    {amt > 0 ? "+" : amt < 0 ? "−" : ""}
                    {formatCurrency(Math.abs(amt), r.currency ?? "USD")}
                  </Td>
                  <Td align="right">
                    <button
                      onClick={() => setRuleSource(r)}
                      className="btn-icon mr-1"
                      aria-label={`Create rule for ${merch}`}
                      title="Create rule"
                    >
                      <Wand2 size={16} strokeWidth={2} />
                    </button>
                    <button
                      onClick={() => setEditing(r)}
                      className="btn-icon"
                      aria-label={`Edit ${merch}`}
                      title="Edit transaction"
                    >
                      <Pencil size={16} strokeWidth={2} />
                    </button>
                  </Td>
                </Tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="body-m px-4 py-16 text-center text-on-surface-variant">
                  No transactions match.
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-col items-center justify-between gap-3 rounded-2xl bg-surface-low px-4 py-3 sm:flex-row">
          <div className="body-s text-on-surface-variant">
            Showing {visible.length} of {filtered.length} transactions
          </div>
          {canLoadMore && (
            <button
              className="btn btn-outlined w-full sm:w-auto"
              onClick={() => setVisibleCount((n) => n + VISIBLE_STEP)}
            >
              Load more
            </button>
          )}
        </div>
      )}

      {editing && (
        <EditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(updated) => {
            setItems((xs) => xs.map((x) => (x.id === updated.id ? updated : x)));
            setEditing(null);
          }}
        />
      )}
      {ruleSource && (
        <RuleModal
          row={ruleSource}
          onClose={() => setRuleSource(null)}
          onSave={(rule, affected) => {
            setRules((rs) => [rule, ...rs]);
            setRuleSource(null);
            toast.success("Rule created", `${affected} transaction${affected === 1 ? "" : "s"} updated.`);
          }}
        />
      )}
    </div>
  );
}

type MappingKey = "date" | "amount" | "name" | "merchant" | "category" | "subcategory" | "reference" | "memo";
type SignConvention = "negative-outflow" | "positive-outflow";
type DateHint = "auto" | "ymd" | "mdy" | "dmy";

function guessMapping(headers: string[]): Record<MappingKey, string> {
  return {
    date: findHeader(headers, ["date", "posted", "posted date", "transaction date"]),
    amount: findHeader(headers, ["amount", "amt", "debit/credit", "value"]),
    name: findHeader(headers, ["name", "description", "payee", "memo"]),
    merchant: findHeader(headers, ["merchant", "payee"]),
    category: findHeader(headers, ["category", "type"]),
    subcategory: findHeader(headers, ["subcategory", "sub-category"]),
    reference: findHeader(headers, ["reference", "ref", "reference number", "transaction id", "fitid"]),
    memo: findHeader(headers, ["memo", "notes", "note"]),
  };
}

function findHeader(headers: string[], aliases: string[]) {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  for (const alias of aliases) {
    const index = normalized.indexOf(alias);
    if (index >= 0) return headers[index];
  }
  return "";
}

function buildImportRows(
  rows: string[][],
  headers: string[],
  mapping: Record<MappingKey, string>,
  signConvention: SignConvention,
  dateHint: DateHint,
) {
  const dateIndex = headers.indexOf(mapping.date);
  const amountIndex = headers.indexOf(mapping.amount);
  const nameIndex = headers.indexOf(mapping.name);
  const merchantIndex = headers.indexOf(mapping.merchant);
  const categoryIndex = headers.indexOf(mapping.category);
  const subcategoryIndex = headers.indexOf(mapping.subcategory);
  const referenceIndex = headers.indexOf(mapping.reference);
  const memoIndex = headers.indexOf(mapping.memo);

  if (dateIndex < 0 || amountIndex < 0 || nameIndex < 0) return [];

  return rows.flatMap((row) => {
    const date = parseImportDate(row[dateIndex], dateHint);
    const amount = parseImportAmount(row[amountIndex]);
    const name = row[nameIndex]?.trim();
    if (!date || amount == null || !name) return [];
    return [{
      date,
      amount: signConvention === "positive-outflow" ? -amount : amount,
      name,
      merchant: merchantIndex >= 0 ? row[merchantIndex]?.trim() || null : null,
      category: categoryIndex >= 0 ? row[categoryIndex]?.trim() || null : null,
      subcategory: subcategoryIndex >= 0 ? row[subcategoryIndex]?.trim() || null : null,
      reference: referenceIndex >= 0 ? row[referenceIndex]?.trim() || null : null,
      memo: memoIndex >= 0 ? row[memoIndex]?.trim() || null : null,
    }];
  });
}

function parseImportAmount(value: string | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const numeric = Number(trimmed.replace(/[,$()\s]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return negative ? -numeric : numeric;
}

function parseImportDate(value: string | undefined, hint: DateHint) {
  if (!value) return null;
  const trimmed = value.trim();
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (ymd && (hint === "auto" || hint === "ymd")) {
    return toIsoDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed);
  if (slash && (hint === "mdy" || hint === "dmy")) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = normalizeYear(Number(slash[3]));
    return hint === "dmy" ? toIsoDate(year, second, first) : toIsoDate(year, first, second);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeYear(year: number) {
  return year < 100 ? 2000 + year : year;
}

function toIsoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function ImportPanel({
  accounts,
  onImported,
}: {
  accounts: AccountOption[];
  onImported: (inserted: number, skipped: number) => void;
}) {
  const toast = useToast();
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<MappingKey, string>>({
    date: "",
    amount: "",
    name: "",
    merchant: "",
    category: "",
    subcategory: "",
    reference: "",
    memo: "",
  });
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [signConvention, setSignConvention] = useState<SignConvention>("negative-outflow");
  const [dateHint, setDateHint] = useState<DateHint>("auto");
  const [importing, setImporting] = useState(false);

  async function loadFile(file: File | null) {
    if (!file) return;
    const parsed = parseCsv(await file.text());
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setMapping(guessMapping(parsed.headers));
  }

  const previewRows = useMemo(
    () => buildImportRows(rows, headers, mapping, signConvention, dateHint).slice(0, 10),
    [rows, headers, mapping, signConvention, dateHint],
  );

  const importRows = useMemo(
    () => buildImportRows(rows, headers, mapping, signConvention, dateHint),
    [rows, headers, mapping, signConvention, dateHint],
  );

  async function submitImport() {
    if (!accountId || importRows.length === 0) {
      toast.error("Nothing to import", "Choose an account and map date, amount, and name.");
      return;
    }
    setImporting(true);
    const response = await fetch("/api/transactions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, rows: importRows }),
    });
    setImporting(false);
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast.error("Import failed", json.error ?? "Check the mapping and account.");
      return;
    }
    onImported(json.inserted ?? 0, json.skipped ?? 0);
  }

  return (
    <section className="card-elevated space-y-4">
      <div>
        <h2 className="title-m">Import transactions</h2>
        <p className="body-s mt-1 text-on-surface-variant">
          Imported transactions appear in history and analytics; update the account balance separately.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <label className="block lg:col-span-2">
          <span className="overline">CSV file</span>
          <input type="file" accept=".csv,text/csv" onChange={(event) => loadFile(event.target.files?.[0] ?? null)} className="tf" />
        </label>
        <label className="block lg:col-span-2">
          <span className="overline">Target account</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="tf">
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} {account.source === "manual" ? "(Manual)" : ""} · {account.type}
              </option>
            ))}
          </select>
        </label>
      </div>

      {headers.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {(["date", "amount", "name", "merchant", "category", "subcategory", "reference", "memo"] as MappingKey[]).map((key) => (
              <label key={key} className="block">
                <span className="overline capitalize">{key}</span>
                <select
                  value={mapping[key]}
                  onChange={(event) => setMapping((current) => ({ ...current, [key]: event.target.value }))}
                  className="tf"
                >
                  <option value="">Unmapped</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>{header}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="block">
              <span className="overline">Sign convention</span>
              <select value={signConvention} onChange={(event) => setSignConvention(event.target.value as SignConvention)} className="tf">
                <option value="negative-outflow">Negative = outflow</option>
                <option value="positive-outflow">Positive = outflow</option>
              </select>
            </label>
            <label className="block">
              <span className="overline">Date format</span>
              <select value={dateHint} onChange={(event) => setDateHint(event.target.value as DateHint)} className="tf">
                <option value="auto">Auto</option>
                <option value="ymd">YYYY-MM-DD</option>
                <option value="mdy">MM/DD/YYYY</option>
                <option value="dmy">DD/MM/YYYY</option>
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={submitImport}
                disabled={importing || importRows.length === 0 || !accountId}
                className="btn btn-filled w-full"
              >
                <Upload size={16} strokeWidth={2} />
                {importing ? "Importing..." : `Import ${importRows.length}`}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl bg-surface-low">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-outline-variant text-xs uppercase text-on-surface-variant">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Merchant</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, index) => (
                  <tr key={`${row.date}-${row.name}-${index}`} className="border-b border-outline-variant last:border-0">
                    <td className="px-4 py-3 font-mono text-sm text-on-surface-variant">{row.date}</td>
                    <td className="px-4 py-3 text-on-surface">{row.name}</td>
                    <td className="px-4 py-3 text-on-surface-variant">{row.merchant ?? ""}</td>
                    <td className="px-4 py-3 text-on-surface-variant">{row.category ?? ""}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{row.amount}</td>
                  </tr>
                ))}
                {previewRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="body-m px-4 py-8 text-center text-on-surface-variant">
                      Map date, amount, and name to preview import rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function effectiveCategory(row: Row) {
  return row.overrideCategory ?? row.aiCategory ?? row.category ?? "—";
}

function effectiveMerchant(row: Row) {
  return row.overrideMerchant ?? row.merchant ?? row.name;
}

function effectiveTransfer(row: Row) {
  return row.overrideIsTransfer ?? row.isTransfer;
}

function TransactionBadges({ row }: { row: Row }) {
  const xfer = effectiveTransfer(row);
  return (
    <>
      {row.pending && <span className="badge ml-2">pending</span>}
      {xfer && <span className="badge ml-2">transfer</span>}
      {row.isRecurring && <span className="badge ml-2">recurring</span>}
    </>
  );
}

function TransactionCard({
  row,
  onEdit,
  onCreateRule,
}: {
  row: Row;
  onEdit: () => void;
  onCreateRule: () => void;
}) {
  const amt = row.amount;
  const xfer = effectiveTransfer(row);
  const amountClass = amt >= 0 ? "text-success" : xfer ? "text-on-surface-variant" : "text-on-surface";
  return (
    <li className={`rounded-2xl bg-surface-low p-4 shadow-sm ${xfer ? "opacity-75" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="body-s font-mono text-on-surface-variant">{formatDate(row.date)}</div>
          <div className="title-m mt-1 truncate text-on-surface">{effectiveMerchant(row)}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="badge badge-primary">{effectiveCategory(row)}</span>
            {row.pending && <span className="badge">pending</span>}
            {xfer && <span className="badge">transfer</span>}
            {row.isRecurring && <span className="badge">recurring</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`title-m font-mono tabular-nums ${amountClass}`}>
            {amt > 0 ? "+" : amt < 0 ? "−" : ""}
            {formatCurrency(Math.abs(amt), row.currency ?? "USD")}
          </div>
          <div className="mt-1 flex justify-end gap-1">
            <button onClick={onCreateRule} className="btn-icon" aria-label={`Create rule for ${effectiveMerchant(row)}`}>
              <Wand2 size={16} strokeWidth={2} />
            </button>
            <button onClick={onEdit} className="btn-icon" aria-label={`Edit ${effectiveMerchant(row)}`}>
              <Pencil size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
      <div className="body-s mt-3 truncate text-on-surface-variant">
        {row.accountName ?? "Account"}
        {row.accountSource === "manual" && <span className="badge ml-2">Manual</span>}
        {row.accountMask && <span className="ml-1 font-mono">··{row.accountMask}</span>}
      </div>
      {row.userNotes && (
        <div className="body-s mt-2 rounded-xl bg-surface-container px-3 py-2 text-on-surface-variant">
          {row.userNotes}
        </div>
      )}
    </li>
  );
}

function RuleModal({
  row,
  onClose,
  onSave,
}: {
  row: Row;
  onClose: () => void;
  onSave: (rule: Rule, affected: number) => void;
}) {
  const toast = useToast();
  const preferredMerchant = row.overrideMerchant ?? row.merchant;
  const [field, setField] = useState<"merchant" | "name">(preferredMerchant ? "merchant" : "name");
  const [matchType, setMatchType] = useState<"contains" | "equals">("contains");
  const [pattern, setPattern] = useState(preferredMerchant ?? row.name);
  const [category, setCategory] = useState(row.overrideCategory ?? row.aiCategory ?? row.category ?? "Other");
  const [subcategory, setSubcategory] = useState(row.overrideSubcategory ?? row.aiSubcategory ?? "");
  const [applyRetroactively, setApplyRetroactively] = useState(true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const r = await fetch("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field,
        matchType,
        pattern,
        category,
        subcategory: subcategory || null,
        applyRetroactively,
      }),
    });
    setSaving(false);
    if (!r.ok) {
      toast.error("Rule creation failed", (await r.json().catch(() => null))?.error ?? "Check the rule details.");
      return;
    }
    const json = await r.json();
    onSave(json.rule, json.affected);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="card-elevated w-full max-w-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="title-l">Create rule</h2>
        <div className="body-s text-on-surface-variant">{effectiveMerchant(row)}</div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="overline">Field</span>
            <select value={field} onChange={(e) => setField(e.target.value as "merchant" | "name")} className="tf">
              <option value="merchant">Merchant</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label className="block">
            <span className="overline">Match</span>
            <select
              value={matchType}
              onChange={(e) => setMatchType(e.target.value as "contains" | "equals")}
              className="tf"
            >
              <option value="contains">Contains</option>
              <option value="equals">Equals</option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="overline">Pattern</span>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="tf" />
          </label>
          <label className="block">
            <span className="overline">Category</span>
            <input
              list="rule-cats"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="tf"
            />
            <datalist id="rule-cats">
              {CATEGORIES.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="overline">Subcategory</span>
            <input value={subcategory} onChange={(e) => setSubcategory(e.target.value)} className="tf" />
          </label>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={applyRetroactively}
              onChange={(e) => setApplyRetroactively(e.target.checked)}
              className="h-5 w-5 accent-[hsl(var(--md-primary))]"
            />
            <span className="body-m">Apply to existing matching transactions</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn btn-text">Cancel</button>
          <button onClick={save} disabled={saving || pattern.trim().length === 0} className="btn btn-filled">
            <Plus size={16} strokeWidth={2} />
            {saving ? "Saving…" : "Create rule"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditModal({
  row,
  onClose,
  onSave,
}: {
  row: Row;
  onClose: () => void;
  onSave: (r: Row) => void;
}) {
  const [cat, setCat] = useState(row.overrideCategory ?? row.aiCategory ?? row.category ?? "");
  const [sub, setSub] = useState(row.overrideSubcategory ?? row.aiSubcategory ?? "");
  const [merch, setMerch] = useState(row.overrideMerchant ?? row.merchant ?? row.name ?? "");
  const [notes, setNotes] = useState(row.userNotes ?? "");
  const [xfer, setXfer] = useState<boolean>(row.overrideIsTransfer ?? row.isTransfer);

  const save = async () => {
    const patch = {
      overrideCategory: cat || null,
      overrideSubcategory: sub || null,
      overrideMerchant: merch || null,
      overrideIsTransfer: xfer,
      userNotes: notes || null,
    };
    const r = await fetch(`/api/transactions/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return;
    onSave({
      ...row,
      ...patch,
    } as Row);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="card-elevated w-full max-w-xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="title-l">Edit transaction</h2>
        <div className="body-s text-on-surface-variant">{row.name}</div>

        <div className="grid grid-cols-1 gap-3">
          <label className="block">
            <span className="overline">Category</span>
            <input
              list="cats"
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              className="tf"
            />
            <datalist id="cats">
              {CATEGORIES.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="overline">Subcategory</span>
            <input value={sub} onChange={(e) => setSub(e.target.value)} className="tf" />
          </label>
          <label className="block">
            <span className="overline">Merchant</span>
            <input value={merch} onChange={(e) => setMerch(e.target.value)} className="tf" />
          </label>
          <label className="block">
            <span className="overline">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="tf"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={xfer}
              onChange={(e) => setXfer(e.target.checked)}
              className="h-5 w-5 accent-[hsl(var(--md-primary))]"
            />
            <span className="body-m">Treat as transfer (exclude from spend/income totals)</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn btn-text">Cancel</button>
          <button onClick={save} className="btn btn-filled">Save</button>
        </div>
      </div>
    </div>
  );
}
