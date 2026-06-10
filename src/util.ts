export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Lenient numeric env var: a missing/empty/malformed value falls back instead of
// becoming NaN (which setInterval would treat as ~1ms, and charts as garbage).
// For agent-critical knobs that should *fail* the boot on a malformed value, use
// `numeric()` in config.ts instead.
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
