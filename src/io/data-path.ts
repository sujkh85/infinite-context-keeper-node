import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Appended to filesystem / DB open errors for MCP users. */
export const DATA_PATH_HINT =
  'For MCP hosts, set "cwd" to your project folder, or set env ICK_DATA_DIR / YAML data_dir to a writable absolute path.';

function errnoMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function mkdirDataDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (e) {
    throw new Error(`infinite-context: cannot create data directory "${path}": ${errnoMessage(e)} ${DATA_PATH_HINT}`);
  }
}

export function openSqliteDatabase(dbPath: string, options?: { allowExtension?: boolean }): DatabaseSync {
  try {
    if (options?.allowExtension) {
      return new DatabaseSync(dbPath, { allowExtension: true });
    }
    return new DatabaseSync(dbPath);
  } catch (e) {
    throw new Error(`infinite-context: cannot open SQLite database "${dbPath}": ${errnoMessage(e)} ${DATA_PATH_HINT}`);
  }
}
