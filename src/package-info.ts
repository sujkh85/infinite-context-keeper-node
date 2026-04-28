import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

let cachedVersion: string | null = null;

export function getPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(join(PROJECT_ROOT, "package.json"), "utf8");
    const j = JSON.parse(raw) as { version?: string };
    cachedVersion = j.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
