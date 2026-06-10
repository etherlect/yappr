// .env read/write helpers for the deploy flow: prompt-collected values and
// deploy-generated state (instance id, one-time SSH password) are persisted here
// so a failed run can resume without losing anything unrecoverable.

import { readFile, writeFile } from "node:fs/promises";

// A value that should be treated as "not set" — empty or an .env.example placeholder.
export function isUnset(value: string | undefined): boolean {
  return !value || /^(bk_|0x)?\.\.\.$/.test(value) || value === "...";
}

// Quote a value so dotenv reads it back verbatim: unquoted values are trimmed and
// truncated at an inline " #" — fatal for generated secrets like the one-time SSH
// password, which can't be re-fetched. Plain values stay unquoted.
function quoteEnvValue(value: string): string {
  if (!/[#'"\s]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return value; // contains both quote kinds — leave as-is rather than corrupt it
}

export function setEnvVarInContent(content: string, key: string, value: string): string {
  const line = `${key}=${quoteEnvValue(value)}`;

  // The replacements below MUST use a function: a plain replacement string would
  // have its `$`-sequences ($&, $', $1, …) expanded by String.replace, silently
  // mangling any value (passwords!) that contains them.

  // Existing uncommented assignment — overwrite in place.
  const active = new RegExp(`^${key}=.*$`, "m");
  if (active.test(content)) return content.replace(active, () => line);

  // Commented placeholder (e.g. "# KEY=" or "#KEY=...") — uncomment in place
  // so the file stays clean instead of growing a duplicate at the bottom.
  const commented = new RegExp(`^#\\s*${key}=.*$`, "m");
  if (commented.test(content)) return content.replace(commented, () => line);

  if (!content) return `${line}\n`;
  return content.endsWith("\n") ? `${content}${line}\n` : `${content}\n${line}\n`;
}

// Drop every assignment of `key` — used to keep credentials the server has no use
// for (its own root password) out of the uploaded .env.
export function removeEnvVarInContent(content: string, key: string): string {
  return content.replace(new RegExp(`^${key}=.*\\n?`, "gm"), "");
}

// Persist `key=value` into the .env file AND the live process.env, so later steps
// in the same run see it without re-reading the file.
export async function setEnvVar(envPath: string, key: string, value: string): Promise<void> {
  const content = await readFile(envPath, "utf8").catch(() => "");
  await writeFile(envPath, setEnvVarInContent(content, key, value));
  process.env[key] = value;
}
