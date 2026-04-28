import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { openSqliteDatabase } from "../io/data-path.js";

type SqliteVecDb = { loadExtension: (path: string, entrypoint?: string) => void };

/**
 * 단일 SQLite 파일을 열고, 가능하면 sqlite-vec(vec0) 확장을 로드합니다.
 * 두 스토어(SqliteMemoryStore·SemanticMemoryStore)가 같은 연결을 공유할 때 사용합니다.
 */
export function openSharedSqlite(dbPath: string): { db: DatabaseSync; vecEnabled: boolean } {
  try {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(db as unknown as SqliteVecDb);
    const row = db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
    if (row?.v) {
      return { db, vecEnabled: true };
    }
  } catch {
    // Node 22 이하 또는 확장 로드 실패 시 내장 SQLite만 사용
  }
  return { db: openSqliteDatabase(dbPath), vecEnabled: false };
}
