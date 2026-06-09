---
name: wallet
description: Manage the agent's wallet. Use when the user asks to claim fees, burn tokens, swap tokens, send tokens, or check balances.
access: admin
---

Extract these params from the request:
- action (required): one of "claim", "burn", "swap", "send", "balance"
- amount (optional): for "burn" — a token amount (e.g. "100"), a percentage (e.g. "50%"), or "all". Defaults to configured burn percentage.
- from (optional): for "swap" — source token symbol or address
- to (optional): for "swap" — destination token symbol or address
- swap_amount (optional): for "swap" — amount or percentage of source token (e.g. "10%", "0.5", "all")
- send_token (optional): for "send" — token symbol or address to send (e.g. "USDC", "ETH")
- send_amount (optional): for "send" — amount to send (e.g. "100", "0.5")
- send_to (optional): for "send" — recipient: wallet address, ENS name, or X handle (e.g. "0x123...", "vitalik.eth", "@someone")

For on-chain actions (claim, burn, swap, send), the skill result includes a block-explorer link for each transaction. Always include the transaction link(s) verbatim in your reply so the user can verify the on-chain action.
