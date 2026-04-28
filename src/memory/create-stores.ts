import { join } from "node:path";
import type { AppSettings } from "../config/settings.js";
import { mkdirDataDir } from "../io/data-path.js";
import { SemanticMemoryStore } from "./semantic-store.js";
import { SqliteMemoryStore } from "./sqlite-store.js";
import { openSharedSqlite } from "./shared-database.js";

/** 같은 SQLite 파일에 대한 단일 연결로 두 스토어를 생성합니다. */
export function createMemoryStores(settings: AppSettings): {
  sqlite: SqliteMemoryStore;
  semantic: SemanticMemoryStore;
} {
  mkdirDataDir(settings.dataDir);
  const dbPath = join(settings.dataDir, "infinite_context_keeper.sqlite");
  const { db, vecEnabled } = openSharedSqlite(dbPath);
  return {
    sqlite: new SqliteMemoryStore(db, settings.dataDir),
    semantic: new SemanticMemoryStore(db, vecEnabled, settings.embeddingModel),
  };
}
