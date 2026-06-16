import { payFetch, log, type SkillHandler } from "yappr";

// Generate an image from a prompt via BlockRun's x402 image gateway, then hand the
// asker the resulting URL. payFetch signs the EIP-3009 payment on Base automatically
// (same wallet as every other agent spend), so this module just speaks plain HTTP.

const ORIGIN = "https://blockrun.ai";
const ENDPOINT = `${ORIGIN}/api/v1/images/generations`;

// Available image models and their x402 price (USDC on Base, quoted at 1024x1024, 1
// image — prices are dynamic and non-square sizes may cost more). gpt-image-1 is the
// cheapest frontier model and what we use here; swap MODEL to trade cost for quality:
//   openai/gpt-image-1          $0.021
//   openai/gpt-image-2          $0.063
//   google/nano-banana          $0.053
//   google/nano-banana-pro      $0.105
//   zai/cogview-4               $0.016
//   xai/grok-imagine-image      $0.021
//   xai/grok-imagine-image-pro  $0.074
const MODEL = "openai/gpt-image-1"; // $0.021 / image (1024x1024)

// Orientation keyword → the pixel dimensions sent to the endpoint as `size`. Square is
// the default when the caller gives no (or an unrecognised) size.
const SIZES: Record<string, string> = {
  square: "1024x1024",
  landscape: "1792x1024",
  portrait: "1024x1792",
};
const DEFAULT_SIZE = "square";

// Map a caller-supplied size to a dimension string: a known orientation keyword, an
// explicit WxH the endpoint already understands, or — failing both — the square default.
function resolveSize(raw: string | undefined): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (key in SIZES) return SIZES[key];
  if (/^\d{3,4}x\d{3,4}$/.test(key)) return key;
  return SIZES[DEFAULT_SIZE];
}

// gpt-image-1 routinely runs past the server's 30s inline window: the POST then returns
// a queued job instead of the image, and we poll it to completion. Bound the wait so a
// stuck job can't hang the reply loop forever.
const POST_TIMEOUT_MS = 60_000; // POST holds inline up to ~30s before handing back a job
const POLL_TIMEOUT_MS = 30_000; // per-poll request timeout
const POLL_INTERVAL_MS = 5_000; // pause between polls
const POLL_MAX_ATTEMPTS = 24; // ~2 min of polling after the inline window

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// BlockRun returns the image under data[0].url on both the inline and the completed-poll
// responses; absent until the job finishes.
function imageUrl(body: any): string | undefined {
  return body?.data?.[0]?.url;
}

export const handler: SkillHandler = async (params) => {
  const prompt = (params.prompt ?? "").trim();
  if (!prompt) return { text: "missing prompt — describe the image to generate" };
  const size = resolveSize(params.size ?? params.orientation);

  // 1) Kick off generation. The server holds the request inline for up to ~30s: if the
  // image is ready it comes back directly, otherwise we get a queued job to poll.
  let body: any;
  try {
    const res = await payFetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: MODEL, size }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log.warn({ status: res.status, detail }, "generate-image: POST failed");
      return { text: `image generation failed (HTTP ${res.status})` };
    }
    body = await res.json();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "generate-image: POST errored");
    return { text: "image generation failed — the request errored before any image was produced" };
  }

  // 2a) Fast path — the image came back inline within the 30s window.
  const inline = imageUrl(body);
  if (inline) {
    log.info({ model: MODEL, size, url: inline }, "generate-image: inline result");
    return { text: `image_url: ${inline}` };
  }

  // 2b) Slow path — poll the job until it completes. payFetch re-signs the poll's x402
  // challenge each time; BlockRun only settles the charge on the first completed poll
  // (the unused authorizations for in-progress polls are never submitted on-chain), so
  // polling does not double-bill. The poll must come from the same wallet as the POST,
  // which it always does (one agent wallet).
  const pollPath = body?.poll_url as string | undefined;
  if (!pollPath) {
    log.warn({ body }, "generate-image: no image and no poll_url to follow");
    return { text: "image generation failed — no image and no job to poll" };
  }
  const pollUrl = new URL(pollPath, ORIGIN).toString();
  log.info({ jobId: body?.id, status: body?.status, size, pollUrl }, "generate-image: job queued, polling");

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const pr = await payFetch(pollUrl, { method: "GET", signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      const pb: any = await pr.json().catch(() => null);
      const url = imageUrl(pb);
      if (url) {
        log.info({ attempt, url }, "generate-image: completed");
        return { text: `image_url: ${url}` };
      }
      if (pb?.status === "failed") {
        log.warn({ attempt, body: pb }, "generate-image: job reported failed");
        return { text: "image generation failed while processing the job" };
      }
      log.info({ attempt, status: pb?.status }, "generate-image: still generating");
    } catch (err) {
      // A transient poll error (timeout/network) shouldn't abort — the job may still
      // finish, so log and try the next tick.
      log.warn({ attempt, err: err instanceof Error ? err.message : String(err) }, "generate-image: poll errored — retrying");
    }
  }

  log.warn({ jobId: body?.id }, "generate-image: polling exhausted before completion");
  return { text: "image generation timed out — the job did not finish in time, try again" };
};
