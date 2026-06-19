import { payFetch, paidUsd, type SkillHandler } from "yappr";

// "call this endpoint" skill. payFetch is the engine's x402-aware fetch:
// it pays an EIP-3009 USDC authorization ONLY when the endpoint answers HTTP 402,
// and returns free (HTTP 200) endpoints untouched. So the same call works whether or
// not the user mentioned x402, and whether or not the endpoint actually charges.

// Keep the observation compact: it's fed back into the model's context and the agent
// composes a reply from it. Large payloads are truncated (the meta line notes it).
const MAX_BODY = 1800;

const looksLikeJson = (s: string): boolean => {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
};

async function formatResponse(method: string, url: string, res: Response): Promise<string> {
  const paid = paidUsd(res);
  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  // Pretty-print JSON when the body is (or looks like) JSON; otherwise show text as-is.
  let body = raw;
  if (contentType.includes("json") || looksLikeJson(raw)) {
    try {
      body = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* not valid JSON after all — leave the raw text */
    }
  }
  if (body.length > MAX_BODY) {
    body = `${body.slice(0, MAX_BODY)}\n… [truncated, ${body.length} chars total]`;
  }

  const meta = [
    `${method} ${url}`,
    `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
    contentType ? `type ${contentType.split(";")[0].trim()}` : null,
    paid != null && paid > 0 ? `paid $${paid.toFixed(4)} (x402)` : "no payment required",
  ]
    .filter(Boolean)
    .join(" · ");

  return `${meta}\n\n${body || "(empty body)"}`;
}

export const handler: SkillHandler = async (params, _tweet) => {
  const url = (params.url ?? "").trim();
  if (!url) return { text: 'missing "url" — specify the endpoint to call' };
  if (!/^https?:\/\//i.test(url)) return { text: `invalid url "${url}" — must start with http:// or https://` };

  const method = (params.method ?? "GET").toUpperCase();
  const init: RequestInit = { method };

  // Optional caller-supplied headers (JSON object string).
  const headers: Record<string, string> = {};
  if (params.headers) {
    try {
      Object.assign(headers, JSON.parse(params.headers));
    } catch {
      return { text: `couldn't parse headers — pass a JSON object string, got: ${params.headers}` };
    }
  }

  // Attach a body only for methods that take one; default to JSON content-type when
  // the user didn't set one explicitly.
  if (params.body != null && method !== "GET" && method !== "HEAD") {
    init.body = params.body;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }
  if (Object.keys(headers).length) init.headers = headers;

  let res: Response;
  try {
    res = await payFetch(url, init);
  } catch (err) {
    return { text: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { text: await formatResponse(method, url, res) };
};
