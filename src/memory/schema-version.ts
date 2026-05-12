export const SCHEMA_VERSION = 1;

type SchemaDb = {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...args: unknown[]): unknown };
};

export function migrateSchemaVersion(db: SchemaDb): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
  const current = Number(row.user_version ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(`Unsupported SQLite schema version ${current}; this server supports up to ${SCHEMA_VERSION}.`);
  }
  if (current < 1) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
