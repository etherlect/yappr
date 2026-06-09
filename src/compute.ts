// Shared client for the x402 Compute API (https://compute.x402layer.cc).
// Instance-management endpoints (lookup, password, …) require wallet-signature
// auth — an EIP-191 personal_sign over a canonical "X402-COMPUTE-AUTH" message
// signed by the Bankr wallet. Used by both the deploy script and the ssh helper.

import { createHash, randomUUID } from "node:crypto";
import { bankrApi, bankrSignMessage } from "./bankr.js";

const COMPUTE_API = "https://compute.x402layer.cc";

// ─── response accessors ─────────────────────────────────────────────────────

export function computeInstanceData(instance: any): any {
  return instance?.data?.order ?? instance?.order ?? instance?.data ?? instance;
}

export function computeInstanceId(instance: any): string | undefined {
  // The platform order id (`id`/`order_id`) is what every management endpoint
  // (lookup, password, extend) keys on — NOT the provider's own instance id.
  const data = computeInstanceData(instance);
  return data?.id ?? data?.order_id ?? data?.instance_id ?? data?.provider_instance_id ?? data?.vultr_instance_id
    ?? instance?.id ?? instance?.order_id ?? instance?.instance_id ?? instance?.provider_instance_id;
}

export function computeInstanceIp(instance: any): string | undefined {
  const data = computeInstanceData(instance);
  const ip = data?.ip ?? data?.main_ip ?? data?.ipv4 ?? data?.public_ip ?? data?.ip_address
    ?? instance?.ip ?? instance?.main_ip ?? instance?.ip_address;
  return ip && ip !== "0.0.0.0" ? ip : undefined;
}

export function computeInstancePassword(instance: any): string | undefined {
  const data = computeInstanceData(instance);
  return data?.password ?? data?.root_password ?? data?.rootPassword ?? data?.default_password
    ?? data?.ssh_password ?? data?.sshPassword ?? instance?.password ?? instance?.root_password;
}

export function computeInstanceExpiry(instance: any): Date | null {
  const data = computeInstanceData(instance);
  const raw = data?.expiry ?? data?.expires_at ?? data?.expiresAt ?? instance?.expiry ?? instance?.expires_at;
  return raw ? new Date(raw) : null;
}

export function remainingComputeHours(instance: any): number | null {
  const expiry = computeInstanceExpiry(instance);
  if (!expiry || Number.isNaN(expiry.getTime())) return null;
  return (expiry.getTime() - Date.now()) / 3_600_000;
}

// ─── auth + requests ────────────────────────────────────────────────────────

// Resolve the Bankr EVM wallet address (the payer/owner of compute instances).
export async function resolveEvmAddress(apiKey: string): Promise<`0x${string}`> {
  const me = await bankrApi<any>(apiKey, "/wallet/me");
  const address: string | undefined = me.wallets?.find((w: any) => w.chain === "evm")?.address ?? me.address;
  if (!address) throw new Error("Could not resolve EVM wallet address from /wallet/me");
  return address as `0x${string}`;
}

export async function computeAuthHeaders(
  apiKey: string,
  walletAddress: `0x${string}`,
  method: string,
  path: string,
  body = "",
): Promise<Record<string, string>> {
  const address = walletAddress.toLowerCase();
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const timestampMs = Date.now();
  const nonce = randomUUID().replace(/-/g, "");

  const message = [
    "X402-COMPUTE-AUTH", "v1", "base", address,
    method.toUpperCase(), path, bodyHash, String(timestampMs), nonce,
  ].join("\n");

  const signature = await bankrSignMessage(apiKey, message);

  return {
    "X-Auth-Address": address,
    "X-Auth-Chain": "base",
    "X-Auth-Signature": signature,
    "X-Auth-Timestamp": String(timestampMs),
    "X-Auth-Nonce": nonce,
    "X-Auth-Sig-Encoding": "hex",
  };
}

export async function fetchComputeInstance(apiKey: string, walletAddress: `0x${string}`, instanceId: string): Promise<any> {
  const path = `/compute/instances/${instanceId}`;
  const headers = await computeAuthHeaders(apiKey, walletAddress, "GET", path);
  const res = await fetch(`${COMPUTE_API}${path}`, { headers });
  if (!res.ok) throw new Error(`Compute instance lookup failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Fetch the one-time root password for instances provisioned without an SSH key
// (access_method: one_time_password_fallback). It's a POST (single-use per
// instance) and requires wallet-signature auth. Password lives under `access`.
export async function fetchOneTimePassword(apiKey: string, walletAddress: `0x${string}`, instanceId: string): Promise<string | undefined> {
  const path = `/compute/instances/${instanceId}/password`;
  const headers = await computeAuthHeaders(apiKey, walletAddress, "POST", path);
  const res = await fetch(`${COMPUTE_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (!res.ok) throw new Error(`Compute password fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as any;
  return body?.access?.password ?? body?.password ?? body?.root_password ?? body?.one_time_password ?? computeInstancePassword(body);
}

// Freshly provisioned instances report ip_address "0.0.0.0" until the provider
// brings them up. Poll the instance until a real IP appears. `onTick` fires on
// each poll so callers can render progress.
export async function waitForComputeIp(
  apiKey: string,
  walletAddress: `0x${string}`,
  instanceId: string,
  timeoutMs: number,
  onTick?: () => void,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastInstance: any = null;
  while (Date.now() < deadline) {
    try {
      lastInstance = await fetchComputeInstance(apiKey, walletAddress, instanceId);
      if (computeInstanceIp(lastInstance)) return lastInstance;
    } catch { /* transient — keep polling */ }
    onTick?.();
    await new Promise((r) => setTimeout(r, 5000));
  }
  return lastInstance;
}
