import { config } from "../config.js";
import { log } from "../log.js";
import { envNumber } from "../util.js";
import { recordLlm, recordSpend } from "../stats.js";
import type { Prompts } from "./prompts.js";

// Thin wrapper over the Bankr LLM Gateway (an OpenAI-compatible /chat/completions
// endpoint, billed to the Bankr wallet). `setPrompts` is called once at startup
// with the prompts assembled from config/; `agentSystem` returns the system prompt
// for a turn, choosing the admin or public variant and prefixing today's date.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

let _prompts: Prompts | null = null;

// ─── inference cost tracking ────────────────────────────────────────────────────
//
// Each completion response carries a `usage` block (prompt/completion/cached token
// counts). The Bankr LLM Gateway publishes per-model pricing (USD per 1M tokens) at
// /v1/models, so we can cost every request exactly and record it as inference spend —
// far more precise than inferring spend from credit-balance jumps.

// One base URL for the whole gateway client — pricing AND completions, so a
// BANKR_LLM_URL override can't price from one gateway while chatting with another.
const LLM_URL = process.env.BANKR_LLM_URL || "https://llm.bankr.bot";
// Bound on a single completion call, so a hung gateway request can't stall a
// mention's reply pipeline forever.
const LLM_TIMEOUT_MS = envNumber("LLM_TIMEOUT_MS", 120_000);

type ModelPricing = { input: number; output: number; cacheRead: number };

let _pricing: ModelPricing | null = null;
let _pricingInFlight: Promise<ModelPricing | null> | null = null;

async function fetchModelPricing(): Promise<ModelPricing | null> {
  const key = process.env.BANKR_LLM_KEY || config.bankrApiKey;
  try {
    const res = await fetch(`${LLM_URL}/v1/models`, {
      headers: { "X-API-Key": key, "User-Agent": "yappr/0.1" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id: string; pricing?: any }> };
    const p = (body.data ?? []).find((m) => m.id === config.llmModel)?.pricing;
    if (!p || p.unit !== "million_tokens") return null;
    const input = Number(p.input) || 0;
    return { input, output: Number(p.output) || 0, cacheRead: p.cache_read != null ? Number(p.cache_read) : input };
  } catch {
    return null;
  }
}

// Per-model pricing, fetched once and cached. Concurrent callers share one in-flight
// fetch; a failed fetch leaves the cache empty so a later call transparently retries.
async function modelPricing(): Promise<ModelPricing | null> {
  if (_pricing) return _pricing;
  if (!_pricingInFlight) {
    _pricingInFlight = fetchModelPricing().then((p) => { _pricing = p; _pricingInFlight = null; return p; });
  }
  return _pricingInFlight;
}

// Exact USD cost of one completion from its token usage + the model's per-1M pricing.
// Cached input tokens bill at the cheaper cache_read rate; completion tokens (which
// already include any reasoning tokens) bill at the output rate.
function inferenceCostUsd(usage: any, p: ModelPricing): number {
  const prompt = Number(usage?.prompt_tokens ?? 0);
  const completion = Number(usage?.completion_tokens ?? 0);
  const cached = Number(usage?.prompt_tokens_details?.cached_tokens ?? 0);
  const freshInput = Math.max(0, prompt - cached);
  return (freshInput * p.input + cached * p.cacheRead + completion * p.output) / 1_000_000;
}

// Warm the pricing cache at boot and log it (or warn if unavailable). Optional — chat()
// lazy-loads pricing too — but prefetching keeps the first reply from paying the
// /v1/models round-trip and surfaces a missing-pricing condition up front.
export async function loadModelPricing(): Promise<void> {
  const p = await modelPricing();
  if (p) log.info({ model: config.llmModel, pricing: p }, "LLM pricing loaded (USD per 1M tokens)");
  else log.warn({ model: config.llmModel }, "LLM pricing unavailable — inference spend will not be tracked this run");
}

export function setPrompts(prompts: Prompts): void {
  _prompts = prompts;
}

function getPrompts(): Prompts {
  if (!_prompts) throw new Error("setPrompts() not called yet");
  return _prompts;
}

export async function chat(
  messages: ChatMessage[],
  opts: { jsonMode?: boolean } = {},
): Promise<string> {
  const t = Date.now();
  recordLlm(); // one inference request (counter; USDC cost recorded below from usage)
  // Full context sent to the LLM this turn (every message, verbatim). Each
  // message is separated by an empty line so the contexts are readable in logs.
  const rendered = messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
  log.info(
    { model: config.llmModel, jsonMode: opts.jsonMode ?? false },
    `LLM request (${messages.length} messages):\n\n${rendered}\n`,
  );
  const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.bankrApiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // warn before throwing: the catch site logs the (counted) error — see log.ts.
    log.warn({ status: res.status, body, ms: Date.now() - t }, "LLM request failed");
    throw new Error(`Bankr LLM error: ${res.status} ${body}`);
  }

  const json = (await res.json()) as any;
  const content = json.choices?.[0]?.message?.content;

  // Cost this request exactly from its token usage and record it as inference spend.
  // Best-effort: never let costing/recording throw into the agent's reply path.
  let usd: number | undefined;
  try {
    const p = await modelPricing();
    if (p && json.usage) {
      usd = inferenceCostUsd(json.usage, p);
      recordSpend("inference", usd);
    }
  } catch { /* best-effort */ }

  // Full text received back from the LLM this turn. The cost rides in the `usd` field
  // (same convention as x-api calls) and is also echoed in the message — the JSON tail
  // here is dominated by `content`, so a compact "$… · N tok" keeps it glanceable.
  const tokens = Number(json.usage?.total_tokens);
  const costTag = usd != null ? ` · $${usd.toFixed(6)}${Number.isFinite(tokens) ? ` · ${tokens} tok` : ""}` : "";
  log.info({ ms: Date.now() - t, usage: json.usage, usd, content }, `LLM response${costTag}`);
  if (!content) throw new Error("Bankr LLM returned empty content");
  return content as string;
}

export function agentSystem(isAdmin: boolean): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const iso = now.toISOString();
  // Hour granularity (no minutes/seconds): the system prompt then stays identical for up
  // to an hour, so the gateway's prompt cache keeps hitting instead of missing every call.
  const datePrefix = `Today is ${weekday}, ${iso.slice(0, 10)} ${iso.slice(11, 13)}:00 (UTC).`;
  const prompt = isAdmin ? getPrompts().agentAdmin : getPrompts().agent;
  return `${datePrefix}\n\n${prompt}`;
}
