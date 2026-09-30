<div align="center">

<img src="public/logo.png" alt="OpenCoffer" width="96" height="96" />

# OpenCoffer

**Self-hosted personal finance with bank sync, dashboards, and a BYO-LLM chat that actually reads your numbers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![Postgres](https://img.shields.io/badge/Postgres-16-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed)](https://modelcontextprotocol.io/)

[Quick start](#-quick-start-docker) · [Features](#-features) · [MCP](#-mcp) · [Configuration](#%EF%B8%8F-configuration) · [Security](#-security)

</div>

<p align="center">
  <img src="public/demo.gif" alt="OpenCoffer demo" width="720" />
</p>

OpenCoffer is read-only against your financial accounts. It syncs through [SimpleFIN](https://www.simplefin.org/), stores everything in a Postgres database you own, encrypts sensitive tokens and model keys at rest, and lets you ask finance questions through the in-app chat or any MCP-compatible client. Bring any model you want — OpenAI, Anthropic, OpenRouter, Groq, Together, Ollama, Hermes, ChatGPT subscription auth, or any OpenAI-compatible endpoint.

---

## Features

- **Bank & brokerage sync** via SimpleFIN — one-token setup, encrypted access URLs.
- **Net worth, cash flow, spending, subscriptions, holdings, real assets, budgets, alerts, saved charts** — all deterministic, all generated from your database.
- **Deterministic transaction rules** — create merchant/name matching rules from transactions before AI categorization runs.
- **Recurring charge tracking** — detects billing cadence, normalises to a monthly cost, predicts the next charge, flags lapsed subscriptions and price increases.
- **Alert push notifications** — deliver in-app alerts to ntfy, Discord, Slack, or a generic webhook.
- **Bring your own LLM** — OpenAI, Anthropic, any OpenAI-compatible provider, ChatGPT subscription auth, local Ollama, or a self-hosted endpoint.
- **Persistent chat with finance tools** — model picker, conversation history, category fixes, deterministic chart tools the LLM can call.
- **Background worker** — automatic sync, categorization, insight refresh, and net-worth snapshots on a cron you control.
- **MCP server** at `/api/mcp` exposing the same finance tools used by chat, so any MCP client (Claude Desktop, Hermes, custom agents) can query your data with a bearer token.
- **Docker Compose** deployment with Postgres, web, worker, and optional Ollama.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="public/screenshots/overview.png" alt="Overview" width="320" /><br/><sub><b>Overview</b> — net worth, cash flow, intelligence</sub></td>
    <td align="center"><img src="public/screenshots/charts.png" alt="Charts" width="320" /><br/><sub><b>Charts</b> — deterministic, regenerated on sync</sub></td>
    <td align="center"><img src="public/screenshots/chat.png" alt="Chat" width="320" /><br/><sub><b>Chat</b> — BYO model, persistent history</sub></td>
  </tr>
</table>

## Quick start (Docker)

The fastest path — Postgres, web, and worker running in three commands.

```bash
# 1. Generate secrets
cp .env.example .env
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)" >> .env
echo "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env

# 2. Start Postgres, run migrations, then bring up the full stack
docker compose up -d postgres
docker compose run --rm web pnpm db:migrate
docker compose up -d --build
```

Open <http://localhost:3000>, create an account, then add a SimpleFIN setup token in **Settings → Connections**.

> [!IMPORTANT]
> `APP_ENCRYPTION_KEY` encrypts your SimpleFIN access URLs and LLM API keys at rest. **Back it up.** Rotating it makes existing encrypted secrets unreadable.

## Local development

Requirements: **Node.js 22**, **pnpm** (via Corepack), **Postgres 16+**.

```bash
corepack enable
pnpm install
cp .env.example .env.local

# Point DATABASE_URL at your local Postgres, then:
pnpm db:migrate
pnpm dev          # web on :3000
pnpm worker       # background sync + categorization (second terminal)
```

For production-mode testing (recommended for mobile / LAN testing — `next dev` compiles on demand and is slow over the network):

```bash
pnpm build
pnpm start
pnpm worker
```

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Next.js    │     │  Postgres 16 │     │   Worker     │
│   (web)      │◄───►│  (drizzle)   │◄───►│   (cron)     │
│              │     │              │     │              │
│  /dashboard  │     │  accounts    │     │  • sync      │
│  /chat       │     │  txns        │     │  • categorize│
│  /settings   │     │  insights    │     │  • insights  │
│  /api/mcp ───┼──┐  │  snapshots   │     │  • snapshots │
└──────────────┘  │  │  budgets     │     └──────┬───────┘
                  │  │  chat_msgs   │            │
                  │  │  llm_creds*  │            │
                  │  │  mcp_tokens* │            ▼
                  │  └──────────────┘     ┌──────────────┐
                  │                       │  SimpleFIN   │
                  ▼                       │   bridge     │
         ┌─────────────────┐              └──────────────┘
         │   MCP client    │
         │  (Claude /      │     * encrypted with
         │   Hermes / etc) │       APP_ENCRYPTION_KEY
         └─────────────────┘
```

The **worker is part of the release runtime, not optional dev tooling.** It syncs SimpleFIN connections, categorizes new transactions with your chosen analysis model, refreshes AI insights, writes net-worth snapshots, and purges disconnected connections after their retention window.

## Configuration

All configuration lives in `.env` (Docker) or `.env.local` (dev). See [`.env.example`](.env.example) for the full list.

| Variable | Required | Description |
| --- | :---: | --- |
| `DATABASE_URL` | Yes | Postgres connection string |
| `NEXTAUTH_SECRET` | Yes | Auth.js session secret — `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Yes | Public URL of the web app |
| `DISABLE_REGISTRATION` | No | Set to `1` to block new registrations after the first user exists |
| `APP_ENCRYPTION_KEY` | Yes | 32-byte base64 key for at-rest encryption of secrets |
| `APP_URL` | Yes | Used in MCP setup snippets shown in the UI |
| `OPENCOFFER_SYNC_CRON` | No | Worker sync cadence (default `*/30 * * * *`) |
| `OPENCOFFER_ASSET_REFRESH_CRON` | No | Real-asset market valuation cadence (default weekly) |
| `RENTCAST_API_KEY` | No | Home/land market estimates through RentCast AVM |
| `AUTO_DEV_API_KEY` | No | Vehicle comparable-listing estimates through Auto.dev |
| `MARKETCHECK_API_KEY` | No | Optional direct vehicle valuation through MarketCheck; may incur provider data fees |
| `OLLAMA_BASE_URL` | No | Pre-seeded base URL when using the bundled Ollama profile |
| `ALLOW_DEV_IMPERSONATION` | No | **Dev only.** Set to `1` to enable header-based impersonation for E2E tests. Never set this on a reachable deployment |
| `DEV_IMPERSONATE_SECRET` | No | Required (16+ chars) when impersonation is enabled — requests must present it as `x-dev-impersonate-secret` |
| `DEV_IMPERSONATE_ALLOWED` | No | Comma-separated emails that may be impersonated |

### LLM setup

1. Open **Settings → Models**.
2. Add at least one credential. Any OpenAI-compatible endpoint works — provider, base URL, API key, model name.
3. Mark one model as the **analysis model**. It's used for background categorization and generated insights. Chat lets you pick per-message.

To run Ollama inside the compose network:

```bash
docker compose --profile ollama up -d ollama
```

Then point the app at `http://ollama:11434/v1` (inside Docker) or `http://host.docker.internal:11434/v1` (host Ollama from a container).

### Use your ChatGPT Plus/Pro subscription instead of an API key

OpenCoffer can talk to the same backend the official `codex` CLI uses, so a ChatGPT Plus/Pro/Business subscription works as a model credential — no extra OpenAI API spend.

1. Install the official [Codex CLI](https://github.com/openai/codex) and sign in with your ChatGPT account:

   ```bash
   npm install -g @openai/codex
   codex login
   ```

   This opens a browser, completes the OAuth flow, and writes a token bundle to `~/.codex/auth.json`.

2. In OpenCoffer, go to **Settings → Models → Add credential** and pick **ChatGPT Plus/Pro subscription** as the provider.

3. Paste the entire contents of `~/.codex/auth.json` into the credential field and pick a model (e.g. one of the GPT-5.x options exposed via the codex backend). Leave the base URL blank — OpenCoffer defaults to `https://chatgpt.com/backend-api/codex`.

4. Save. OpenCoffer encrypts the token bundle with `APP_ENCRYPTION_KEY` and automatically refreshes the access token against `auth.openai.com` when it's within 60 seconds of expiry. If a refresh ever fails (you signed out elsewhere, the refresh token rotated, etc.), re-run `codex login` and paste the new `auth.json`.

This works for both the in-app chat and the background analysis model (categorization, insights, snapshots). Same auth, same provider config.

### SimpleFIN

OpenCoffer uses [SimpleFIN](https://www.simplefin.org/) for read-only bank and brokerage data. There are no app-wide credentials — each user pastes their own setup token in **Settings → Connections**. The token is claimed once; the resulting access URL is encrypted with `APP_ENCRYPTION_KEY`.

Disconnecting a connection marks it for purge after 30 days. Hard-delete removes it immediately.

### Notifications and rules

Open **Transactions → Rules** to create deterministic category rules from existing transactions. Rules run before background AI categorization, and matching transactions receive manual override categories.

Open **Settings → Notifications** to add per-user ntfy, Discord, Slack, or webhook channels for alerts. Channel URLs and tokens are encrypted with `APP_ENCRYPTION_KEY`; no extra environment variables are required.

### Real assets

Open **Dashboard → Assets** to add homes, vehicles, land, or other property. Manual values are always supported and are included in net worth immediately. If provider keys are configured, homes and land can refresh from RentCast, vehicles can decode VIN metadata from NHTSA, and vehicle values can refresh from Auto.dev listing comparables or MarketCheck direct valuation.

## MCP

OpenCoffer exposes its finance tools to MCP-compatible clients at `/api/mcp`.

```bash
# 1. Create a token in Settings → MCP
# 2. Wire it into your MCP client (Hermes example):

hermes mcp add opencoffer \
  --transport http \
  --url http://localhost:3000/api/mcp \
  --header "Authorization: Bearer oc_<your-token>"
```

Tool families available over MCP:

```
accounts            recent_transactions    transaction_search
spending_by_category  holdings             recurring_streams
upcoming_payments   net_worth              budgets
alerts              chart_data             category_fixes
```

The LLM writes the commentary; finance totals come from deterministic database-backed tools. No hallucinated balances.

### Token access levels

Tokens are minted **read-only** by default. A read-only token cannot call the tools that change stored data (`set_transaction_category`, `bulk_set_category_by_merchant`, `run_categorization`, `set_account_group`, `remember`, `forget`) — the server rejects them and omits them from `tools/list` entirely, so a connected agent never sees they exist.

Choose **Read & write** in Settings → MCP when you want an agent to be able to fix categories or keep long-term memories. Tokens created before access levels existed remain read-only; issue a new token if one of your agents needs write access.

## Security

- SimpleFIN access URLs and LLM API keys are encrypted at rest with `APP_ENCRYPTION_KEY`.
- MCP bearer tokens are stored as hashes — you see them once at creation — and are read-only unless you explicitly grant write access.
- Dashboard and settings routes require Auth.js sessions; `/api/mcp` uses bearer auth instead of session cookies.
- Failed logins are throttled per (email, source IP) so brute force is expensive without letting anyone lock you out of your own account.
- Never set `ALLOW_DEV_IMPERSONATION` on a deployment anyone else can reach — it is a header-driven auth bypass meant only for local E2E runs.
- Keep `NEXTAUTH_SECRET`, `APP_ENCRYPTION_KEY`, `.env`, database backups, and SimpleFIN setup/access URLs private.

See [SECURITY.md](SECURITY.md) for the full policy and disclosure channel.

## Operations

```bash
docker compose logs -f web
docker compose logs -f worker
docker compose run --rm web pnpm db:migrate    # apply new migrations
docker compose pull && docker compose up --build -d
```

Back up Postgres before upgrades:

```bash
docker compose exec postgres pg_dump -U opencoffer opencoffer > opencoffer.sql
docker compose exec -T postgres psql -U opencoffer opencoffer < opencoffer.sql
```

## Demo GIF

The hero GIF lives at [`public/demo.gif`](public/demo.gif). It's rendered from real app screenshots captured with fake demo data — never real account data.

```bash
# Remotion source (preferred — produces the higher-res GIF)
cd demo/remotion
pnpm install
pnpm run render:gif      # writes ../../public/demo.gif

# Deterministic Python fallback (no Remotion / Chromium required)
python3 scripts/generate-demo-gif.py
```

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local setup and the checks that should pass before opening a PR:

```bash
npx --no-install tsc --noEmit
pnpm lint
pnpm build
```

## License

[MIT](LICENSE) © OpenCoffer contributors.
