---
name: generate-image
description: Generate an image from a text prompt and reply with its URL. Use when the user asks you to create, generate, draw, paint, or make an image/picture of something.
access: admin
---

Generate an image from a text description using OpenAI `gpt-image-1` (via the BlockRun
x402 gateway, paid from the agent wallet — so this costs money per call).

Extract these parameters:
- `prompt` (required) — the image description, in the user's own words (e.g. "anime
  style white cat playing on green grass"). Build it from what the user actually asked
  for; don't invent detail they didn't request.
- `size` (optional) — the image orientation, one of:
  - `square` — 1024×1024 (**default** — use this whenever the user doesn't ask for a shape)
  - `landscape` — 1792×1024 (wide; for "landscape", "wide", "banner", "16:9")
  - `portrait` — 1024×1792 (tall; for "portrait", "vertical", "tall", "phone wallpaper")

The skill returns `image_url: <url>` once the image is ready. Generation runs inline for
up to ~30s; if it takes longer the skill polls the job in the background, so a call can
take up to ~1–2 minutes. Wait for it.

When you get the result back:
- Reply to the asker and include the returned image URL **verbatim** in your reply so
  they can open it.
- The image is delivered as a **link, not an inline attachment** — you cannot embed it
  in the tweet, so the URL itself must appear in the reply text.
- If the skill reports a failure or timeout, tell the user it couldn't generate the
  image. Never invent or guess an image URL.
