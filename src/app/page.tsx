import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { ArrowRight, Cpu, Plug, Network } from "lucide-react";
import { Logo } from "@/components/Logo";

export default async function Home() {
  const session = await auth();
  if (session) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-surface">
      {/* Top app bar */}
      <header className="flex h-16 items-center justify-between border-b border-outline-variant bg-surface px-8">
        <Link href="/" className="flex items-center gap-3 text-on-surface">
          <Logo size={36} withWordmark priority />
        </Link>
        <nav className="flex items-center gap-2">
          <Link href="/login" className="btn btn-text">
            Sign in
          </Link>
          <Link href="/register" className="btn btn-filled">
            Create account
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-[1240px] px-8 pb-24 pt-20">
        {/* Hero */}
        <section className="grid grid-cols-12 gap-8 lg:grid-cols-12">
          <div className="col-span-12 lg:col-span-8">
            <span className="badge badge-primary mfade mfade-1">v0.1 — preview</span>
            <h1 className="display-l mfade mfade-2 mt-6 max-w-[14ch]">
              Personal finance, on your own machine.
            </h1>
            <p className="body-l mfade mfade-3 mt-6 max-w-[60ch] text-on-surface-variant">
              A self-hosted finance cockpit inspired by ChatGPT-style money analysis. Connect your
              accounts via SimpleFIN, get a clean dashboard, and chat with any model you want —
              OpenAI, Anthropic, OpenRouter, Groq, local Ollama, Hermes, or your own endpoint —
              grounded in your real transactions, holdings and recurring payments. The same data is
              exposed over MCP for any agent you trust.
            </p>
            <div className="mfade mfade-4 mt-10 flex flex-wrap items-center gap-3">
              <Link href="/register" className="btn btn-filled">
                Get started
                <ArrowRight size={18} strokeWidth={2} />
              </Link>
              <Link href="/login" className="btn btn-outlined">
                Sign in
              </Link>
              <span className="body-s ml-2 text-on-surface-variant">
                No telemetry. No accounts. No upsell.
              </span>
            </div>
          </div>

          <aside className="col-span-12 lg:col-span-4">
            <div className="card-elevated mfade mfade-3">
              <div className="eyebrow">Sandbox preview</div>
              <div className="mt-4 space-y-5">
                <Specimen label="Net worth" value="$284,310.22" tone="default" />
                <hr className="divider" />
                <Specimen label="Predicted, next 7 days" value="−$842.17" tone="error" />
                <hr className="divider" />
                <Specimen label="Portfolio, last close" value="+1.24%" tone="success" />
                <hr className="divider" />
                <Specimen label="Active subscriptions" value="14" tone="default" />
              </div>
            </div>
          </aside>
        </section>

        <hr className="divider my-24" />

        {/* Three pillars */}
        <section>
          <div className="eyebrow">What it does</div>
          <h2 className="headline-l mt-2 max-w-[18ch]">
            Three things, done well.
          </h2>

          <div className="mt-12 grid grid-cols-12 gap-6">
            <Pillar
              Icon={Cpu}
              title="Bring your own model"
              body="OpenAI, Anthropic, Groq, Together, OpenRouter, Mistral, a local Ollama, or any endpoint that speaks the OpenAI or Anthropic protocol — including a self-hosted Hermes. Per-user keys, encrypted at rest."
            />
            <Pillar
              Icon={Plug}
              title="SimpleFIN, read-only"
              body="Connect banks and brokerages through a SimpleFIN bridge. Accounts, transactions, holdings, recurring streams. Disconnect at any time — data purges in 30 days, or delete it now."
            />
            <Pillar
              Icon={Network}
              title="MCP, built-in"
              body="The same finance tools the in-app chat uses are exposed over Model Context Protocol. Wire Hermes Agent, Claude Desktop or Cursor in three lines and analyse your data with whatever agent you trust."
            />
          </div>
        </section>

        <hr className="divider my-24" />

        <footer className="flex flex-wrap items-center justify-between gap-4">
          <span className="body-s text-on-surface-variant">Runs anywhere Docker runs</span>
          <span className="body-s text-on-surface-variant">
            v0.1 · {new Date().getFullYear()}
          </span>
        </footer>
      </main>
    </div>
  );
}

function Specimen({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "default" | "error" | "success";
}) {
  const toneClass =
    tone === "error" ? "text-error" : tone === "success" ? "text-success" : "text-on-surface";
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="body-s text-on-surface-variant">{label}</span>
      <span className={`title-l font-mono tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

function Pillar({
  Icon,
  title,
  body,
}: {
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  body: string;
}) {
  return (
    <div className="card col-span-12 md:col-span-6 lg:col-span-4">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
        <Icon size={22} strokeWidth={1.75} />
      </div>
      <h3 className="title-l mt-6">{title}</h3>
      <p className="body-m mt-3 text-on-surface-variant">{body}</p>
    </div>
  );
}
