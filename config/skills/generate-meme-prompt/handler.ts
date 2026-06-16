import { chat, log, type SkillHandler, type ChatMessage } from "yappr";

// generate-meme-prompt: craft a funny, Crypto-Twitter-flavored image PROMPT from a tweet.
// It does NOT render anything — it returns the prompt for the model to hand to the
// generate-image skill, which does the actual (paid) rendering and attaches the result.
// Keeping the two apart means one render path (generate-image) and no duplicated image-gen
// code here. Use it when the user wants a meme but hasn't described the visual themselves.

// The prompt-crafting brief. Bakes in Crypto Twitter context so the meme lands.
const MEME_SYSTEM = `You are a Crypto Twitter (CT) meme director. Given the subject of a tweet, write ONE image-generation prompt for a single funny meme image.

- Lean into CT humor and culture where it fits — degens, leverage and liquidations, rugs and exit liquidity, gm/wagmi/ngmi, "ser"/"anon", diamond vs paper hands, copium, "few understand this", and wojak/pepe/chad/virgin-vs-chad visual archetypes. Use what suits the subject; never force every trope in.
- Describe a clear, vivid visual scene, and specify the EXACT short bold meme caption text to render in the image (impact-font style, just a few words).
- Funny and a little edgy is good; never hateful, sexual, or harassing toward private individuals.
- Output ONLY the image prompt itself — no preamble, no quotes, no explanation, no markdown.`;

export const handler: SkillHandler = async (params) => {
  const subject = (params.subject ?? params.prompt ?? "").trim();
  if (!subject) return { text: "missing subject — pass the tweet's content/topic to meme about" };
  const angle = params.angle?.trim() || undefined;

  const user = angle ? `Tweet subject: ${subject}\n\nExtra angle to play on: ${angle}` : `Tweet subject: ${subject}`;
  const messages: ChatMessage[] = [
    { role: "system", content: MEME_SYSTEM },
    { role: "user", content: user },
  ];

  try {
    const memePrompt = (await chat(messages)).trim();
    if (!memePrompt) throw new Error("empty prompt");
    log.info({ subject, memePrompt }, "generate-meme-prompt: crafted prompt");
    // Return just the prompt (as data). The chaining — "now call generate-image with this"
    // — is driven by skill.md (a trusted instruction), since observations are fed to the
    // model as data, not instructions.
    return { text: `Meme image prompt (pass verbatim to the generate-image skill's "prompt"):\n\n${memePrompt}` };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "generate-meme-prompt: prompt crafting failed");
    return { text: "couldn't come up with a meme for that — try again" };
  }
};
