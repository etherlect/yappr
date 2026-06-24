---
name: generate-meme-prompt
description: Invent a funny Crypto-Twitter image prompt for a meme about a tweet — for when the user wants a meme but hasn't said what the image should show. generate-image then renders it. Use for "make a meme", "meme this".
access: all
---

Use this when the user wants a meme about a tweet but **hasn't described what the image should actually show** — it invents the funny visual for you (a cheap LLM call) by writing a Crypto-Twitter-aware image prompt. It does **not** render anything; after it returns the prompt, you call the **generate-image** skill to create the meme and attach it.

**When NOT to use it:** if the user already told you exactly what the image should depict (e.g. "make an image of a green pepe crying at a red chart"), skip this skill and call `generate-image` directly with their description — you don't need help inventing the visual.

Extract these parameters:
- `subject` (required) — what the meme is about. Pull it from the relevant tweet in the context: quote its key line or summarize the joke/topic, and say *why* it's meme-able.
- `angle` (optional) — a specific spin if the user asked for one (e.g. "make fun of the leverage", "diamond-hands angle", "him coping"). Omit if there's no particular angle.

Do **not** write the meme prompt yourself — this skill writes it for you.

## How to make the meme (two steps)

1. Call `generate-meme-prompt` with the `subject` (and optional `angle`). It returns a ready-made image prompt.
2. Then call the **generate-image** skill, setting its `prompt` param to that returned prompt **verbatim** (and a `size` such as `landscape` only if the user asked for a shape). generate-image renders the meme and attaches it to your reply automatically.
3. Reply with a short, natural caption — do **not** paste any URL or the prompt text.

If `generate-meme-prompt` reports it couldn't come up with anything, tell the user and don't fabricate a meme.
