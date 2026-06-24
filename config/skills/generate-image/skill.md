---
name: generate-image
description: Generate image(s) from a text prompt, upload them to X, and return their media_id(s). Use when the user asks you to create, generate, draw, paint, or make an image/picture of something.
access: all
---

Generate an image from a text description using OpenAI `gpt-image-2` (via the BlockRun x402 gateway, paid from the agent wallet — so this costs money per call). Override the model with the `GENERATE_IMAGE_MODEL` env var.

Extract these parameters:
- `prompt` (required) — the image description, in the user's own words (e.g. "anime style white cat playing on green grass"). Build it from what the user actually asked for; don't invent detail they didn't request.
- `size` (optional) — the image orientation, one of:
  - `square` — 1024×1024 (**default** — use this whenever the user doesn't ask for a shape)
  - `landscape` — 1536×1024 (wide; for "landscape", "wide", "banner")
  - `portrait` — 1024×1536 (tall; for "portrait", "vertical", "tall", "phone wallpaper")
- `n` (optional) — how many images to generate, 1–4 (default 1). Use it only when the user asks for several (e.g. "make me 3 logos"). Each costs a separate generation.

Generation runs inline for up to ~30s; if it takes longer the skill polls the job in the background, so a call can take up to ~1–2 minutes. Wait for it.

When you get the result back:
- The skill uploads the image(s) to X and returns their `media_id`(s) in the observation. Nothing is auto-attached — **attach them to your reply** to show them: `{"action":"reply","text":"<short caption>","media_id":"<id1,id2>"}`. Write a short, natural caption; do **not** paste any URL or link. (To post them elsewhere — a new tweet, a quote, or a reply to a different tweet — pass the media_id(s) to the `x-write` `post` action instead.)
- If the skill reports a failure or timeout, tell the user it couldn't generate the image. Never invent or describe an image that wasn't actually generated.
