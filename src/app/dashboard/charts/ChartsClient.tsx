"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Plus, Trash2, X, Sparkles, Loader2 } from "lucide-react";
import { ChartMetadata, ChatChart, type ChartSpec } from "@/components/ChatChart";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toaster";
import { addSavedChart, deleteSavedChart } from "./actions";

export type ChartCard = {
  key: string;
  /** DB id present only for user-saved cards. */
  id?: string;
  title: string;
  blurb: string;
  /** wide = full row on lg; half = 1/2 on lg */
  span: "wide" | "half";
  section?: "primary" | "secondary";
  spec: ChartSpec;
  callout?: string;
  savedAt?: string;
  error?: string;
};

function hasData(spec: ChartSpec): boolean {
  if (!spec) return false;
  return Array.isArray(spec.data) && spec.data.length > 0;
}

export function ChartsClient({
  defaultCards,
  savedCards,
}: {
  defaultCards: ChartCard[];
  savedCards: ChartCard[];
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const primaryCards = defaultCards.filter((c) => c.section !== "secondary");
  const secondaryCards = defaultCards.filter((c) => c.section === "secondary");

  function refreshAnalysis() {
    startRefresh(async () => {
      await fetch("/api/insights", { method: "POST" });
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 pb-28 md:space-y-8 md:p-8 md:pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Chart command center</div>
          <h2 className="coffer-serif mt-2 text-3xl leading-tight md:text-4xl">Primary views</h2>
          <p className="body-m mt-2 max-w-2xl text-on-surface-variant">
            Current wealth, monthly flow, and category mix.
          </p>
        </div>
        <button
          type="button"
          onClick={refreshAnalysis}
          disabled={refreshing}
          className="btn btn-tonal"
        >
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          Refresh analysis
        </button>
      </div>

      <div className="grid grid-cols-12 gap-4 md:gap-6">
        {primaryCards.map((c) => (
          <CardShell key={c.key} card={c} />
        ))}
      </div>

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="coffer-serif text-2xl">More analysis</h2>
          <span className="body-s text-on-surface-variant">
            {secondaryCards.length} views
          </span>
        </div>
        <div className="grid grid-cols-12 gap-4 md:gap-6">
          {secondaryCards.map((c) => (
            <CardShell key={c.key} card={c} />
          ))}
        </div>
      </section>

      {/* User-saved charts */}
      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="coffer-serif text-2xl">Your charts</h2>
          <span className="body-s text-on-surface-variant">
            {savedCards.length} saved
          </span>
        </div>
        <div className="grid grid-cols-12 gap-4 md:gap-6">
          {savedCards.map((c) => (
            <CardShell key={c.key} card={c} deletable />
          ))}
          <AddChartCard />
        </div>
      </section>

      <div className="flex justify-end pb-2 pt-2">
        <Link href="/chat" className="btn btn-text">
          Build a one-off chart in chat
          <ArrowUpRight size={16} strokeWidth={2} />
        </Link>
      </div>
    </div>
  );
}

function CardShell({ card, deletable }: { card: ChartCard; deletable?: boolean }) {
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const toast = useToast();

  async function remove() {
    if (!card.id) return;
    const ok = await confirm({
      title: "Delete chart?",
      body: `Delete chart "${card.title}"?`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    startTransition(async () => {
      try {
        await deleteSavedChart(card.id!);
      } catch (e) {
        toast.error("Couldn't delete chart", (e as Error).message);
      }
    });
  }
  return (
    <section
      className={
        card.span === "wide" ? "col-span-12" : "col-span-12 lg:col-span-6"
      }
    >
      <div
        className="card-elevated coffer-card-hover overflow-hidden p-0"
        style={{ contentVisibility: "auto", containIntrinsicSize: card.span === "wide" ? "420px" : "360px" }}
      >
        <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-2 md:px-6 md:pt-6">
          <div className="min-w-0">
            <h3 className="coffer-serif truncate text-2xl">{card.title}</h3>
            <p className="body-s mt-1 line-clamp-2 text-on-surface-variant">{card.blurb}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Link
              href={`/chat?q=${encodeURIComponent(`Explain this chart: ${card.title}. ${card.blurb}`)}`}
            className="inline-flex h-10 items-center gap-1 rounded-full px-3 text-primary transition-colors hover:bg-primary/[0.08] body-s"
              title="Ask chat about this chart"
            >
              Ask
              <ArrowUpRight size={14} strokeWidth={2} />
            </Link>
            {deletable && (
              <button
                onClick={remove}
                disabled={pending}
                className="btn-icon"
                aria-label="Delete chart"
                title="Delete chart"
              >
                {pending ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Trash2 size={16} strokeWidth={1.75} />
                )}
              </button>
            )}
          </div>
        </header>
        <div className="px-5 pb-2 md:px-6">
          <ChartMetadata freshness={card.spec.freshness} />
          {card.callout && (
            <div className="mt-3 rounded-r-2xl border-l-2 border-primary bg-primary/10 px-3 py-2 body-s text-on-surface">
              {card.callout}
            </div>
          )}
        </div>
        {card.error ? (
          <div className="px-5 pb-5 md:px-6 md:pb-6">
            <div className="rounded-xl bg-error-container px-3 py-2 body-s text-on-error-container">
              Couldn&apos;t render: {card.error}
            </div>
          </div>
        ) : hasData(card.spec) ? (
          <div className="px-3 pb-4 md:px-5 md:pb-5">
            <ChatChart
              spec={card.spec}
              bare
              height={card.section === "primary" ? (card.span === "wide" ? 360 : 320) : card.span === "wide" ? 320 : 270}
            />
          </div>
        ) : (
          <div className="grid h-56 place-items-center px-6 pb-6">
            <div className="body-m max-w-sm text-center text-on-surface-variant">
              {card.spec.emptyReason ?? "No data yet for this view."}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const EXAMPLES = [
  "Cash flow trend for the last 6 months",
  "Spending mix this year",
  "Net worth change over the last 12 months",
  "Recurring spend by merchant",
  "Savings rate for the last 90 days",
  "Where my savings went over the last 6 months",
  "Top merchants this month",
  "Budget progress",
];

function AddChartCard() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    const p = prompt.trim();
    if (p.length < 4) {
      setErr("Describe the chart in a few words at least.");
      return;
    }
    setErr(null);
    startTransition(async () => {
      try {
        await addSavedChart(p);
        setPrompt("");
        setOpen(false);
      } catch (e) {
        setErr((e as Error).message);
      }
    });
  }

  return (
    <section className="col-span-12 lg:col-span-6">
      {open ? (
        <div className="card-elevated coffer-card-hover">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="coffer-serif flex items-center gap-2 text-2xl">
                <Sparkles size={18} strokeWidth={2} className="text-primary" />
                Add a chart
              </h3>
              <p className="body-s mt-1 text-on-surface-variant">
                Describe what you want to see. The model picks the right chart and parameters.
              </p>
            </div>
            <button
              onClick={() => { setOpen(false); setErr(null); }}
              className="btn-icon"
              aria-label="Cancel"
            >
              <X size={18} strokeWidth={1.75} />
            </button>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Last 6 months of grocery spending"
            disabled={pending}
            rows={3}
            autoFocus
            className="mt-4 w-full rounded-2xl border border-outline bg-surface px-4 py-3 text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none disabled:opacity-50"
          />
          {err && (
            <div className="mt-2 rounded-xl bg-error-container px-3 py-2 body-s text-on-error-container">
              {err}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={pending}
                onClick={() => setPrompt(ex)}
                className="rounded-full bg-surface-container px-3 py-1.5 text-xs text-on-surface-variant transition-colors hover:bg-on-surface/[0.08] hover:text-on-surface disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={() => { setOpen(false); setErr(null); }}
              className="btn btn-text"
              disabled={pending}
            >
              Cancel
            </button>
            <button onClick={submit} className="btn btn-filled" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Plus size={16} strokeWidth={2} /> Add
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="coffer-card-hover flex h-full min-h-[200px] w-full flex-col items-center justify-center gap-3 rounded-[20px] border border-dashed border-outline-variant bg-surface-container-low text-on-surface-variant transition-colors hover:border-primary hover:bg-primary/[0.04] hover:text-primary"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
            <Plus size={22} strokeWidth={2} />
          </div>
          <div className="title-s">Add a chart</div>
          <div className="body-s max-w-[240px] text-center text-on-surface-variant">
            Describe what you want to see in plain English.
          </div>
        </button>
      )}
    </section>
  );
}
