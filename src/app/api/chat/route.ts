import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { generateText, streamText } from "ai";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { llmCredentials, auditLog, chatThreads, chatMessages } from "@/lib/db/schema";
import {
  cleanGeneratedTitle,
  textFromMessageContent,
  titleFromMessage,
  titlePromptForConversation,
} from "@/lib/chat/history";
import { getModel, toAiSdkTools } from "@/lib/llm/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SYSTEM_PROMPT = `You are a helpful personal-finance assistant for the user. You have tools that
read the user's real, connected financial data and tools that render charts inline.

Sign convention: a NEGATIVE transaction amount is an outflow (money leaving the account);
POSITIVE is an inflow. Aggregation tools (get_spending_by_category, get_top_merchants,
get_cash_flow, etc.) already return positive numbers for readability.

Outflow kinds (very important — answer the right question):
  consumption — real living expenses (food, rent, subs, bills) → THE THING people mean by "spending"
  savings    — money moved into wealth: 401k contributions, brokerage deposits, HSA, IRA
  income     — paychecks, dividends, refunds, Zelle FROM people
  transfer   — internal moves (CC payments, account-to-account) — already excluded
When the user says "how much did I spend", they almost always mean CONSUMPTION (the default
of get_spending_by_category, get_top_merchants direction='outflow', chart_*). Use kind='savings'
or kind='all' only when they ask explicitly. For "am I saving enough" / "savings rate" call
get_consumption_vs_savings.

Account groups (auto-assigned, more useful than raw \`type\` for analysis):
  cash        — spendable checking + savings
  credit      — credit cards (debt, balance is negative)
  retirement  — 401k, 403b, IRA, Roth, RSP, pension, savings incentive plan
  brokerage   — taxable investment accounts
  hsa         — health savings accounts
  loan        — mortgages, student loans, auto loans
Use \`group\` from get_accounts/get_balances_by_group rather than \`type\` when answering
"how much cash do I have", "what's in retirement", etc. The user can override the
assignment per-account with \`set_account_group\` (e.g. treat a Fidelity brokerage as
'cash' if they hold it like savings) — the override flows through all balance/group
analysis. \`get_accounts\` surfaces \`systemGroup\` and \`userGroupOverride\` so you can
see what's been customized.

Long-term memory (cross-conversation):
  remember(content, key?, pinned)  — save a fact about the user
  recall(query?, limit)            — search/list saved memories
  forget(id? | key?)               — delete by id or key
Memories are NOT auto-injected — call \`recall\` when context might exist (user says
"as I told you", "remember when", references prior decisions, or you're about to
personalize an answer about goals/preferences). Save with \`remember\` whenever the
user states a preference or fact they'd want carried forward (treat-X-as-Y rules,
savings goals, household details). Keep entries short.

Transfer dedup: every transaction has an \`is_transfer\` flag that's TRUE for credit-card
payments and internal account-to-account moves. All spending/cash-flow tools already
EXCLUDE these — you don't need to filter manually. A $500 CC payment shows up in the raw
data on both sides but counts as $0 in spending and $0 in income (because it isn't either).

Categories: each transaction can have a user override, an LLM-derived category, and a raw
aggregator category. All category tools use the same precedence:
  manual override > AI category > raw category > Uncategorized
If the user asks about "subscriptions", "food", "rent", etc., these work even when the
underlying SimpleFIN data has null categories. New transactions get auto-categorized
after every sync, and manual overrides are authoritative across dashboard, charts,
budgets, and chat.

Tool families:
- Account/identity:   get_accounts, get_net_worth, get_balances_by_group, get_portfolio_summary
- Transactions:       get_recent_transactions, search_transactions, get_largest_transactions
- Spending analysis:  get_spending_by_category, get_top_merchants, get_recurring_merchants
- Cash flow:          get_cash_flow, compare_periods
- Investments:        get_holdings, get_portfolio_summary
- Visual (renders inline as a chart in the chat UI):
    chart_spending_trend       — outflow per week/month over a window
    chart_category_breakdown   — pie of outflow by category
    chart_savings_destinations — pie of retained cash + savings destinations
    chart_cash_flow            — paired bar: inflow vs outflow per period
    chart_recurring_merchants  — bar of detected recurring consumption merchants
    chart_top_merchants        — bar of top consumption merchants
    chart_budget_status        — bar of budget progress this month
    chart_balances_by_type     — bar of total balance by raw type
    chart_balances_by_group    — bar of total balance by group (use this by default)
    chart_consumption_vs_savings — consumption vs savings per period
    chart_net_worth_history    — line chart of net worth snapshots over time
- Categories (write tools — only call when the user asks):
    list_categories              — show what categories exist
    set_transaction_category     — fix one row
    bulk_set_category_by_merchant — re-tag everything matching a substring
    run_categorization           — run background AI categorization/recategorization
  Categories are open-set: the user can introduce ANY new name (e.g. "Side Hustle",
  "Date Night", "Kids"). If they say "make a category for X", just use it via
  set_transaction_category or bulk_set_category_by_merchant — no separate "create"
  step needed. Only call run_categorization when the user explicitly asks to
  categorize or recategorize transactions.

Guidelines:
- Always call a tool rather than guessing. Prefer the most specific tool (e.g. get_top_merchants
  over get_recent_transactions for "biggest merchants").
- When the user asks to see/graph/visualize/chart/plot something, ALWAYS call the matching
  chart_* tool. The result auto-renders as a chart — your text reply should add brief
  interpretation (callouts, anomalies, trends) rather than reading the data back. Mention
  the chart's time window and exclusions (for example: excludes transfers, income,
  retirement contributions, and investment outflows for consumption views).
- For comparison questions ("more or less than last month"), call compare_periods.
- For "what are my subscriptions", call get_recurring_merchants — it detects repeating outflows
  heuristically from transaction history.
- Cite concrete numbers, dates, merchant names from tool results.
- Be concise. Lead with the answer; tables/lists only when they pay their way.
- You are read-only. You cannot move money, change accounts, or pay bills; explain that if asked.
- If the user has no connected accounts yet, point them to /settings/connections.`;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    messages: unknown[];
    credentialId?: string;
    threadId?: string;
  };

  // Resolve credential: requested ID > user default > first one.
  let cred =
    body.credentialId &&
    (
      await db
        .select()
        .from(llmCredentials)
        .where(
          and(eq(llmCredentials.id, body.credentialId), eq(llmCredentials.userId, session.user.id)),
        )
        .limit(1)
    )[0];
  if (!cred) {
    const all = await db
      .select()
      .from(llmCredentials)
      .where(eq(llmCredentials.userId, session.user.id));
    cred = all.find((c) => c.isDefault) ?? all[0];
  }
  if (!cred) {
    return NextResponse.json(
      { error: "No LLM credential configured. Add one at /settings/llm." },
      { status: 400 },
    );
  }

  // Persist / find thread
  let threadId = body.threadId;
  let createdThread = false;
  if (!threadId) {
    const [t] = await db
      .insert(chatThreads)
      .values({ userId: session.user.id })
      .returning({ id: chatThreads.id });
    threadId = t.id;
    createdThread = true;
  } else {
    const [thread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, session.user.id)))
      .limit(1);
    if (!thread) return NextResponse.json({ error: "chat thread not found" }, { status: 404 });
  }

  const model = await getModel(cred);
  const tools = toAiSdkTools(session.user.id);

  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: body.messages as any,
    tools,
    // 12 steps: multi-account investigations (e.g. per-card activity sweeps
    // across a dozen accounts) legitimately need more than 6 tool rounds.
    maxSteps: 12,
    onError: ({ error }) => {
      const e = error as {
        name?: string; message?: string; statusCode?: number; url?: string;
        responseBody?: string; responseHeaders?: Record<string, string>; cause?: unknown; stack?: string;
      };
      console.error("[chat] streamText error:", {
        provider: cred!.provider, model: cred!.model,
        name: e.name, message: e.message, statusCode: e.statusCode, url: e.url,
        responseBody: e.responseBody?.slice(0, 2000), responseHeaders: e.responseHeaders, cause: e.cause,
      });
      if (e.stack) console.error(e.stack);
    },
    onFinish: async ({ usage, finishReason, text }) => {
      await db.insert(auditLog).values({
        userId: session.user!.id,
        kind: "chat.complete",
        actor: "session",
        target: cred!.id,
        meta: {
          provider: cred!.provider,
          model: cred!.model,
          usage,
          finishReason,
          threadId,
        },
      });
      // Persist the last user message + the new assistant turn.
      try {
        const msgs = body.messages as Array<{ role: string; content: unknown }>;
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        const fallbackTitle = titleFromMessage(lastUser?.content);
        if (lastUser) {
          await db.insert(chatMessages).values({
            threadId: threadId!,
            role: "user",
            content: lastUser.content as object,
          });
        }
        let title = fallbackTitle;
        if (createdThread) {
          try {
            const generated = await generateText({
              model,
              prompt: titlePromptForConversation({
                user: textFromMessageContent(lastUser?.content),
                assistant: text,
              }),
              maxTokens: 24,
              temperature: 0.2,
            });
            title = cleanGeneratedTitle(generated.text, fallbackTitle);
          } catch (e) {
            console.error("chat title generation failed", e);
          }
        }
        await db
          .update(chatThreads)
          .set({
            title: createdThread ? title : undefined,
            updatedAt: new Date(),
          })
          .where(eq(chatThreads.id, threadId!));
        // Streamed assistant content is persisted client-side via /api/chat/persist.
      } catch (e) {
        console.error("persist user msg failed", e);
      }
    },
  });

  return result.toDataStreamResponse({
    headers: { "x-thread-id": threadId },
    getErrorMessage: (error) => {
      const e = error as { message?: string; statusCode?: number; responseBody?: string };
      return e.responseBody
        ? `${e.statusCode ?? ""} ${e.message ?? ""} — ${e.responseBody.slice(0, 500)}`
        : e.message ?? String(error);
    },
  });
}
