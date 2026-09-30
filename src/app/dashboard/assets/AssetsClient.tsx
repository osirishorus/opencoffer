"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Car, Gem, Home, Landmark, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { Amount } from "@/components/Amount";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toaster";

type AssetValueRow = {
  id: string;
  value: number;
  currency: string;
  source: string;
  sourceKind: string;
  asOf: string;
  rangeLow: number | null;
  rangeHigh: number | null;
  confidence: number | null;
  notes: string | null;
};

export type AssetRow = {
  id: string;
  kind: string;
  name: string;
  status: string;
  valuationMode: string;
  purchasePrice: number | null;
  purchaseDate: string | null;
  currency: string;
  metadata: Record<string, unknown>;
  currentValue: AssetValueRow | null;
  values: AssetValueRow[];
};

type AssetForm = {
  kind: "home" | "vehicle" | "land" | "other";
  name: string;
  currentValue: string;
  valuationMode: "manual" | "provider";
  metadata: Record<string, string>;
};

const emptyForm: AssetForm = {
  kind: "home",
  name: "",
  currentValue: "",
  valuationMode: "manual",
  metadata: {},
};

const KIND_LABELS: Record<string, string> = {
  home: "Homes",
  vehicle: "Vehicles",
  land: "Land",
  other: "Other",
};

export function AssetsClient({ assets }: { assets: AssetRow[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [rows, setRows] = useState(assets);
  const [form, setForm] = useState<AssetForm>(emptyForm);
  const [pending, startTransition] = useTransition();
  const [nameError, setNameError] = useState<string | null>(null);

  const summary = useMemo(() => {
    const byKind = { home: 0, vehicle: 0, land: 0, other: 0 };
    let total = 0;
    for (const asset of rows) {
      if (asset.status !== "active" || !asset.currentValue) continue;
      const value = asset.currentValue.value;
      total += value;
      const key = asset.kind in byKind ? (asset.kind as keyof typeof byKind) : "other";
      byKind[key] += value;
    }
    return { total, byKind };
  }, [rows]);

  function setMeta(key: string, value: string) {
    setForm((current) => ({ ...current, metadata: { ...current.metadata, [key]: value } }));
  }

  function createAsset(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    const value = Number(form.currentValue);
    if (!form.name.trim()) {
      setNameError("Enter an asset name.");
      return;
    }
    startTransition(async () => {
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: form.kind,
          name: form.name.trim(),
          valuationMode: form.valuationMode,
          metadata: compactMetadata(form.metadata),
          currentValue: Number.isFinite(value) && value > 0 ? value : null,
        }),
      });
      if (!response.ok) {
        toast.error("Could not save asset", await responseError(response, "Could not save asset."));
        return;
      }
      const created = (await response.json()) as AssetRow;
      setRows((current) => [...current, normalizeAsset(created)]);
      setForm(emptyForm);
      toast.success("Asset saved");
      router.refresh();
    });
  }

  function replaceAsset(asset: AssetRow) {
    setRows((current) => current.map((row) => (row.id === asset.id ? normalizeAsset(asset) : row)));
  }

  async function reloadAssets() {
    const response = await fetch("/api/assets");
    if (response.ok) {
      const nextRows = (await response.json()) as AssetRow[];
      setRows(nextRows.map(normalizeAsset));
    }
  }

  async function removeAsset(id: string) {
    const ok = await confirm({
      title: "Delete asset?",
      body: "Delete this asset and its value history?",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    startTransition(async () => {
      const response = await fetch(`/api/assets/${id}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error("Could not delete asset", await responseError(response, "Could not delete asset."));
        return;
      }
      setRows((current) => current.filter((row) => row.id !== id));
      toast.success("Asset deleted");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile label="Real assets" value={summary.total} />
        <SummaryTile label="Homes" value={summary.byKind.home} />
        <SummaryTile label="Vehicles" value={summary.byKind.vehicle} />
        <SummaryTile label="Other" value={summary.byKind.land + summary.byKind.other} />
      </section>

      <section className="card-elevated mfade mfade-1">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="eyebrow">Add asset</div>
            <h2 className="coffer-serif mt-1 text-2xl">New holding</h2>
          </div>
          {pending && <Loader2 size={18} className="animate-spin text-on-surface-variant" />}
        </div>
        <form onSubmit={createAsset} className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-12">
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as AssetForm["kind"], metadata: {} })}
            className="tf lg:col-span-2"
            aria-label="Asset kind"
          >
            <option value="home">Home</option>
            <option value="vehicle">Vehicle</option>
            <option value="land">Land</option>
            <option value="other">Other</option>
          </select>
          <input
            value={form.name}
            onChange={(e) => {
              setForm({ ...form, name: e.target.value });
              if (nameError) setNameError(null);
            }}
            placeholder="Name"
            className="tf lg:col-span-3"
            aria-label="Asset name"
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? "asset-name-error" : undefined}
          />
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.currentValue}
            onChange={(e) => setForm({ ...form, currentValue: e.target.value })}
            placeholder="Current value"
            className="tf lg:col-span-2"
            aria-label="Current value"
          />
          <select
            value={form.valuationMode}
            onChange={(e) => setForm({ ...form, valuationMode: e.target.value as AssetForm["valuationMode"] })}
            className="tf lg:col-span-2"
            aria-label="Valuation mode"
          >
            <option value="manual">Manual</option>
            <option value="provider">Market</option>
          </select>
          <button type="submit" disabled={pending} className="btn btn-filled lg:col-span-3">
            <Plus size={18} strokeWidth={2} /> Add asset
          </button>
          <MetadataFields form={form} setMeta={setMeta} />
        </form>
        {nameError && <div id="asset-name-error" className="body-s mt-3 text-error">{nameError}</div>}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {rows.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            replaceAsset={replaceAsset}
            reloadAssets={reloadAssets}
            removeAsset={removeAsset}
            toast={toast}
          />
        ))}
        {rows.length === 0 && (
          <div className="card-elevated body-m text-center text-on-surface-variant lg:col-span-2">
            No assets yet.
          </div>
        )}
      </section>
    </div>
  );
}

function MetadataFields({ form, setMeta }: { form: AssetForm; setMeta: (key: string, value: string) => void }) {
  if (form.kind === "home" || form.kind === "land") {
    return (
      <>
        <input value={form.metadata.address ?? ""} onChange={(e) => setMeta("address", e.target.value)} placeholder="Address" className="tf lg:col-span-5" aria-label="Address" />
        <input value={form.metadata.propertyType ?? ""} onChange={(e) => setMeta("propertyType", e.target.value)} placeholder="Property type" className="tf lg:col-span-2" aria-label="Property type" />
        <input type="number" value={form.metadata.bedrooms ?? ""} onChange={(e) => setMeta("bedrooms", e.target.value)} placeholder="Beds" className="tf lg:col-span-1" aria-label="Bedrooms" />
        <input type="number" value={form.metadata.bathrooms ?? ""} onChange={(e) => setMeta("bathrooms", e.target.value)} placeholder="Baths" className="tf lg:col-span-1" aria-label="Bathrooms" />
        <input type="number" value={form.metadata.squareFootage ?? ""} onChange={(e) => setMeta("squareFootage", e.target.value)} placeholder="Sq ft" className="tf lg:col-span-3" aria-label="Square footage" />
      </>
    );
  }
  if (form.kind === "vehicle") {
    return (
      <>
        <input value={form.metadata.vin ?? ""} onChange={(e) => setMeta("vin", e.target.value.toUpperCase())} placeholder="VIN" className="tf lg:col-span-4" aria-label="VIN" />
        <input value={form.metadata.year ?? ""} onChange={(e) => setMeta("year", e.target.value)} placeholder="Year" className="tf lg:col-span-1" aria-label="Year" />
        <input value={form.metadata.make ?? ""} onChange={(e) => setMeta("make", e.target.value)} placeholder="Make" className="tf lg:col-span-2" aria-label="Make" />
        <input value={form.metadata.model ?? ""} onChange={(e) => setMeta("model", e.target.value)} placeholder="Model" className="tf lg:col-span-2" aria-label="Model" />
        <input value={form.metadata.trim ?? ""} onChange={(e) => setMeta("trim", e.target.value)} placeholder="Trim" className="tf lg:col-span-1" aria-label="Trim" />
        <input value={form.metadata.mileage ?? ""} onChange={(e) => setMeta("mileage", e.target.value)} placeholder="Mileage" className="tf lg:col-span-1" aria-label="Mileage" />
        <input value={form.metadata.zip ?? ""} onChange={(e) => setMeta("zip", e.target.value)} placeholder="ZIP" className="tf lg:col-span-1" aria-label="ZIP" />
      </>
    );
  }
  return (
    <input
      value={form.metadata.description ?? ""}
      onChange={(e) => setMeta("description", e.target.value)}
      placeholder="Description"
      className="tf lg:col-span-12"
      aria-label="Description"
    />
  );
}

function AssetCard({
  asset,
  replaceAsset,
  reloadAssets,
  removeAsset,
  toast,
}: {
  asset: AssetRow;
  replaceAsset: (asset: AssetRow) => void;
  reloadAssets: () => Promise<void>;
  removeAsset: (id: string) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [manualValue, setManualValue] = useState("");
  const Icon = asset.kind === "home" ? Home : asset.kind === "vehicle" ? Car : asset.kind === "land" ? Landmark : Gem;
  const inactive = asset.status !== "active";

  function patchAsset(patch: Record<string, unknown>) {
    startTransition(async () => {
      const response = await fetch(`/api/assets/${asset.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        toast.error("Could not update asset", await responseError(response, "Could not update asset."));
        return;
      }
      const updated = (await response.json()) as Partial<AssetRow>;
      replaceAsset({ ...asset, ...updated, currentValue: asset.currentValue, values: asset.values });
      toast.success("Asset saved");
      router.refresh();
    });
  }

  function addManualValue(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(manualValue);
    if (!Number.isFinite(value) || value <= 0) return;
    startTransition(async () => {
      const response = await fetch(`/api/assets/${asset.id}/values`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!response.ok) {
        toast.error("Could not save value", await responseError(response, "Could not save value."));
        return;
      }
      setManualValue("");
      await reloadAssets();
      toast.success("Asset value saved");
      router.refresh();
    });
  }

  function refreshValue() {
    startTransition(async () => {
      const response = await fetch(`/api/assets/${asset.id}/refresh`, { method: "POST" });
      const body = await response.json().catch(() => null) as { ok?: boolean; provider?: { message?: string }; error?: string } | null;
      if (!response.ok || !body?.ok) {
        toast.error("Could not refresh market value", body?.provider?.message ?? body?.error ?? "No market value returned.");
        return;
      }
      await reloadAssets();
      toast.success("Market value refreshed");
      router.refresh();
    });
  }

  return (
    <article className={`card-elevated coffer-card-hover ${inactive ? "opacity-65" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
              <Icon size={18} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h3 className="title-m truncate text-on-surface">{asset.name}</h3>
              <div className="body-s text-on-surface-variant">
                {KIND_LABELS[asset.kind] ?? "Other"} · {asset.status}
              </div>
              {inactive && <span className="badge mt-1 capitalize">{asset.status}</span>}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="figure text-[28px]">
            {asset.currentValue ? <Amount value={asset.currentValue.value} currency={asset.currentValue.currency} /> : "—"}
          </div>
          <div className="body-s capitalize text-on-surface-variant">
            {asset.currentValue?.source.replace("_", " ") ?? "no value"}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <select
          value={asset.valuationMode}
          onChange={(e) => patchAsset({ valuationMode: e.target.value })}
          disabled={pending}
          className="h-10 rounded-full border border-outline bg-surface px-3 body-s capitalize text-on-surface"
          aria-label={`${asset.name} valuation mode`}
        >
          <option value="manual">Manual</option>
          <option value="provider">Market</option>
        </select>
        <select
          value={asset.status}
          onChange={(e) => patchAsset({ status: e.target.value })}
          disabled={pending}
          className="h-10 rounded-full border border-outline bg-surface px-3 body-s capitalize text-on-surface"
          aria-label={`${asset.name} status`}
        >
          <option value="active">Active</option>
          <option value="sold">Sold</option>
          <option value="archived">Archived</option>
        </select>
        <button type="button" onClick={refreshValue} disabled={pending || asset.kind === "other"} className="btn btn-tonal">
          {pending ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} strokeWidth={2} />}
          Refresh
        </button>
        <button type="button" onClick={() => removeAsset(asset.id)} disabled={pending} className="btn btn-text-error">
          <Trash2 size={16} strokeWidth={2} />
        </button>
      </div>

      <AssetMetadata asset={asset} />

      <form onSubmit={addManualValue} className="mt-4 grid grid-cols-[1fr_auto] gap-2">
        <input
          type="number"
          min={0}
          step="0.01"
          value={manualValue}
          onChange={(e) => setManualValue(e.target.value)}
          placeholder="Manual value"
          className="tf"
          aria-label={`Manual value for ${asset.name}`}
        />
        <button type="submit" disabled={pending} className="btn btn-outlined">
          <Save size={16} strokeWidth={2} />
          Save
        </button>
      </form>

      <div className="mt-4 divide-y divide-outline-variant">
        {asset.values.slice(0, 4).map((value) => (
          <div key={value.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="body-s capitalize text-on-surface">{value.source.replace("_", " ")}</div>
              <div className="body-s text-on-surface-variant">{formatDate(value.asOf)}</div>
            </div>
            <div className="title-s font-mono tabular-nums">
              <Amount value={value.value} currency={value.currency} />
            </div>
          </div>
        ))}
        {asset.values.length === 0 && (
          <div className="body-s py-3 text-on-surface-variant">No value history.</div>
        )}
      </div>
    </article>
  );
}

function AssetMetadata({ asset }: { asset: AssetRow }) {
  const meta = asset.metadata;
  const bits =
    asset.kind === "vehicle"
      ? [meta.year, meta.make, meta.model, meta.trim, meta.mileage ? `${meta.mileage} mi` : null].filter(Boolean)
      : asset.kind === "home" || asset.kind === "land"
        ? [meta.address, meta.propertyType, meta.squareFootage ? `${meta.squareFootage} sq ft` : null].filter(Boolean)
        : [meta.description].filter(Boolean);
  if (bits.length === 0) return null;
  return (
    <div className="body-s mt-4 rounded-xl bg-surface-container px-3 py-2 text-on-surface-variant">
      {bits.join(" · ")}
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="card-elevated p-4">
      <div className="eyebrow">{label}</div>
      <div className="figure mt-2 text-[28px]"><Amount value={value} /></div>
    </div>
  );
}

function compactMetadata(metadata: Record<string, string>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!value.trim()) continue;
    const numericKeys = new Set(["bedrooms", "bathrooms", "squareFootage", "year", "mileage", "latitude", "longitude"]);
    result[key] = numericKeys.has(key) ? Number(value) : value.trim();
  }
  return result;
}

function normalizeAsset(asset: AssetRow): AssetRow {
  return {
    ...asset,
    values: asset.values ?? [],
    currentValue: asset.currentValue ?? null,
    metadata: asset.metadata ?? {},
  };
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}
