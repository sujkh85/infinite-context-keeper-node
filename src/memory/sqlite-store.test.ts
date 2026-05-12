import { describe, expect, it } from "vitest";
import { migrateSchemaVersion } from "./schema-version.js";

describe("schema migration version", () => {
  it("sets the SQLite user_version for migrations", () => {
    let userVersion = 0;
    const db = {
      exec(sql: string) {
        if (sql.includes("PRAGMA user_version = 1")) userVersion = 1;
      },
      prepare(sql: string) {
        if (sql === "PRAGMA user_version") {
          return { get: () => ({ user_version: userVersion }) };
        }
        throw new Error(`unexpected SQL in test: ${sql}`);
      },
    };
    migrateSchemaVersion(db);

    expect(userVersion).toBe(1);
  });
});
