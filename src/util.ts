export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
