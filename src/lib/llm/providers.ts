import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool, type LanguageModel } from "ai";
import { decrypt } from "@/lib/crypto";
import { financeTools } from "@/lib/finance/tools";
import { sanitizeToolResult } from "@/lib/finance/sanitize";
import type { LlmCredential } from "@/lib/db/schema";
import {
  CHATGPT_BACKEND_BASE,
  getValidChatGPTBundle,
} from "@/lib/llm/chatgpt-subscription";

export async function getModel(cred: LlmCredential): Promise<LanguageModel> {
  switch (cred.provider) {
    case "openai-compat": {
      const apiKey = cred.apiKeyCipher ? decrypt(cred.apiKeyCipher) : "ollama";
      const openai = createOpenAI({
        apiKey,
        baseURL: cred.baseUrl || "https://api.openai.com/v1",
        compatibility: cred.baseUrl?.includes("openai.com") ? "strict" : "compatible",
      });
      return openai(cred.model);
    }
    case "anthropic": {
      const apiKey = cred.apiKeyCipher ? decrypt(cred.apiKeyCipher) : "";
      const anthropic = createAnthropic({
        apiKey,
        baseURL: cred.baseUrl || undefined,
      });
      return anthropic(cred.model);
    }
    case "chatgpt-subscription": {
      // Talk to chatgpt.com/backend-api/codex/responses with the user's
      // subscription bearer token. Verified-working request shape:
      //   POST /responses  (no /v1)
      //   headers: Authorization, originator=codex_cli_rs, ChatGPT-Account-ID,
      //            OpenAI-Beta=responses=experimental
      //   body: { instructions, input, stream:true, store:false, ... }
      //
      // Vercel AI SDK's openai.responses() builds most of this but doesn't
      // know about the codex backend's three required deltas:
      //   1. `stream` MUST be true (even for non-streaming generateText)
      //   2. `instructions` MUST be present
      //   3. `store` MUST be false
      // We patch the outgoing JSON body via a fetch interceptor.
      const bundle = await getValidChatGPTBundle(cred.id);
      const headers: Record<string, string> = {
        originator: "codex_cli_rs",
        "User-Agent": `codex_cli_rs/0.27.0 (${process.platform}; node)`,
        "OpenAI-Beta": "responses=experimental",
      };
      if (bundle.account_id) headers["ChatGPT-Account-ID"] = bundle.account_id;

      const codexFetch: typeof fetch = async (input, init) => {
        if (init?.body && typeof init.body === "string") {
          try {
            const body = JSON.parse(init.body);
            body.stream = true;
            body.store = false;
            if (!body.instructions || (typeof body.instructions === "string" && body.instructions.length === 0)) {
              body.instructions = "You are a helpful assistant.";
            }
            // codex backend rejects these fields that the AI SDK adds by default:
            delete body.max_output_tokens;
            delete body.max_tokens;
            delete body.temperature;
            delete body.top_p;
            delete body.presence_penalty;
            delete body.frequency_penalty;
            init = { ...init, body: JSON.stringify(body) };
          } catch {
            /* not JSON, pass through */
          }
        }
        return fetch(input as Parameters<typeof fetch>[0], init);
      };

      const openai = createOpenAI({
        apiKey: bundle.access_token,
        baseURL: cred.baseUrl || CHATGPT_BACKEND_BASE,
        compatibility: "strict",
        headers,
        fetch: codexFetch,
      });
      return openai.responses(cred.model);
    }
    default:
      throw new Error(`Unknown LLM provider: ${cred.provider}`);
  }
}

export function toAiSdkTools(userId: string) {
  return Object.fromEntries(
    financeTools.map((t) => [
      t.name,
      tool({
        description: t.description,
        parameters: t.schema,
        // Merchant names and memos are written by whoever sent the money, so
        // tool output is untrusted text — scrub it before the model sees it.
        execute: async (args) =>
          sanitizeToolResult(await t.execute(args, { userId })) as unknown,
      }),
    ]),
  );
}

/** Simple connectivity test for a credential — used by the Settings "Test" button. */
export async function testCredential(cred: LlmCredential): Promise<{ ok: boolean; error?: string }> {
  try {
    const model = await getModel(cred);
    // Use streamText so SSE-only backends (codex) are handled correctly. The
    // codex backend rejects non-streaming requests, so generateText() would
    // fail with "Invalid JSON" trying to parse SSE as JSON.
    const { streamText } = await import("ai");
    const r = streamText({
      model,
      prompt: "Reply with the single word: pong",
    });
    let text = "";
    for await (const delta of r.textStream) {
      text += delta;
      if (text.length > 64) break; // cap; we only need to confirm tokens arrive
    }
    return { ok: text.length > 0 };
  } catch (e) {
    // Surface as much as possible. AI SDK errors usually carry `responseBody`,
    // `statusCode`, `url`, `responseHeaders`. Log full detail to stderr.
    const err = e as {
      name?: string;
      message?: string;
      statusCode?: number;
      url?: string;
      responseBody?: string;
      responseHeaders?: Record<string, string>;
      cause?: unknown;
      stack?: string;
    };
    console.error("[testCredential] failed for", {
      provider: cred.provider,
      model: cred.model,
      baseUrl: cred.baseUrl,
    });
    console.error("[testCredential] error:", {
      name: err.name,
      message: err.message,
      statusCode: err.statusCode,
      url: err.url,
      responseBody: err.responseBody?.slice(0, 2000),
      responseHeaders: err.responseHeaders,
      cause: err.cause,
    });
    if (err.stack) console.error(err.stack);
    const detail = err.responseBody
      ? `${err.statusCode ?? ""} ${err.message ?? ""} — ${err.responseBody.slice(0, 500)}`
      : err.message ?? String(e);
    return { ok: false, error: detail };
  }
}
