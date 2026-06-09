import { agentPrompt, type SkillHandler } from "yappr";

// Bankr returns a natural-language response, so we pull transaction hashes out of
// it and append the right block-explorer link. Hash format tells us the chain:
//   EVM:    0x + 64 hex chars        -> basescan.org (our EVM actions run on Base)
//   Solana: base58 signature ~88 chars -> solscan.io
// (EVM addresses are 0x+40 hex, so they never match the 64-hex tx pattern; Solana
// addresses are <=44 base58 chars, so they never match the long-signature pattern.)
const EVM_TX = /0x[0-9a-fA-F]{64}/g;
const SOL_TX = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g;

function appendTxLinks(text: string): string {
  const links: string[] = [];
  const seen = new Set<string>();
  const add = (hash: string, base: string) => {
    if (seen.has(hash)) return;
    seen.add(hash);
    links.push(`${base}${hash}`);
  };
  for (const h of text.match(EVM_TX) ?? []) add(h, "https://basescan.org/tx/");
  for (const s of text.match(SOL_TX) ?? []) add(s, "https://solscan.io/tx/");
  if (links.length === 0) return text;
  return `${text}\n\nTransaction${links.length > 1 ? "s" : ""}:\n${links.join("\n")}`;
}

export const handler: SkillHandler = async (params, _tweet) => {
  switch (params.action) {
    case "claim":
      return { text: appendTxLinks(await agentPrompt("claim my token fees on base")) };

    case "burn": {
      const amount = params.amount ?? "50%";
      return { text: appendTxLinks(await agentPrompt(`burn ${amount} of my tokens on base`)) };
    }

    case "swap": {
      const from = params.from ?? "WETH";
      const to = params.to ?? "USDC";
      const amount = params.swap_amount ?? "all";
      return { text: appendTxLinks(await agentPrompt(`swap ${amount} of ${from} to ${to} on base`)) };
    }

    case "send": {
      if (!params.send_to) return { text: "missing recipient — specify an address, ENS name, or X @handle" };
      if (!params.send_amount) return { text: "missing amount — specify how much to send" };
      const token = params.send_token ?? "ETH";
      return { text: appendTxLinks(await agentPrompt(`send ${params.send_amount} ${token} to ${params.send_to} on base`)) };
    }

    case "balance":
      return { text: await agentPrompt("what are my token balances on base") };

    default:
      return { text: `unknown action "${params.action}" — try: claim, burn, swap, send, balance` };
  }
};
