import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ProjectBrainStore } from "./project-brain-store.js";

export type MemoryListItem = {
  memory_id: string;
  title: string;
  session_id: string;
  tags: string[];
  created_at: string | null;
};

export class SqliteMemoryStore {
  private readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly brain: ProjectBrainStore;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "infinite_context_keeper.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.ensureSchema();
    this.brain = new ProjectBrainStore(this.db);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'general',
        created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_project_session
        ON memories(project_id, session_id);
      CREATE TABLE IF NOT EXISTS compaction_cooldown (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_compaction_at REAL NOT NULL,
        PRIMARY KEY (project_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS compaction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ran_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_runs_lookup
        ON compaction_runs(project_id, session_id, ran_at);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT,
        goal TEXT,
        created_at DATETIME,
        last_active DATETIME,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        description TEXT,
        order_num INTEGER,
        status TEXT DEFAULT 'pending',
        completed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_milestones_project
        ON milestones(project_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        milestone_id TEXT,
        title TEXT,
        description TEXT,
        status TEXT DEFAULT 'todo',
        priority INTEGER,
        estimated_hours REAL,
        actual_hours REAL,
        dependencies TEXT,
        file_path TEXT,
        updated_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_milestone
        ON tasks(milestone_id);

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        content TEXT,
        timestamp DATETIME,
        related_files TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_project
        ON decisions(project_id);

      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        category TEXT,
        title TEXT,
        content TEXT,
        vector BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_project
        ON knowledge(project_id);

      CREATE TABLE IF NOT EXISTS project_files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        kind TEXT,
        mtime_ms INTEGER,
        scanned_at DATETIME,
        UNIQUE(project_id, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_project_files_project
        ON project_files(project_id);
    `);
  }

  insertMemory(params: {
    project_id: string;
    session_id: string;
    title: string;
    body: string;
    tags: string[];
    kind?: string;
  }): string {
    const mid = randomUUID();
    const now = Date.now() / 1000;
    const kind = params.kind ?? "general";
    this.db.prepare(
      `INSERT INTO memories (id, project_id, session_id, title, body, tags, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mid,
      params.project_id,
      params.session_id,
      params.title,
      params.body,
      JSON.stringify(params.tags),
      kind,
      now,
    );
    return mid;
  }

  listMemories(params: {
    project_id: string;
    session_id?: string | null;
    tag?: string | null;
    limit: number;
    offset: number;
  }): { items: MemoryListItem[]; total: number } {
    const where: string[] = ["project_id = ?"];
    const args: (string | number)[] = [params.project_id];
    if (params.session_id != null) {
      where.push("session_id = ?");
      args.push(params.session_id);
    }
    if (params.tag) {
      where.push("tags LIKE ?");
      args.push(`%"${params.tag}"%`);
    }
    const wh = where.join(" AND ");
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${wh}`).get(...args) as { c: number };
    const total = Number(totalRow.c);
    const rows = this.db
      .prepare(
        `SELECT id, title, session_id, tags, created_at
         FROM memories WHERE ${wh}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, params.limit, params.offset) as Array<{
      id: string;
      title: string;
      session_id: string;
      tags: string;
      created_at: number | null;
    }>;
    const items: MemoryListItem[] = rows.map((r) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(r.tags || "[]") as string[];
      } catch {
        tags = [];
      }
      const ts = r.created_at != null ? Number(r.created_at) : null;
      const created_iso =
        ts != null && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
      return {
        memory_id: r.id,
        title: r.title,
        session_id: r.session_id,
        tags,
        created_at: created_iso,
      };
    });
    return { items, total };
  }

  fetchRecentCompactionSnippets(params: {
    project_id: string;
    session_id: string | null;
    limit: number;
    max_chars_per_body?: number;
  }): string {
    const maxChars = params.max_chars_per_body ?? 1800;
    const where = [`project_id = ?`, `tags LIKE ?`];
    const args: (string | number)[] = [params.project_id, '%"compaction"%'];
    if (params.session_id != null) {
      where.push("session_id = ?");
      args.push(params.session_id);
    }
    const wh = where.join(" AND ");
    const lim = Math.max(1, Math.min(params.limit, 10));
    const rows = this.db
      .prepare(
        `SELECT title, body FROM memories
         WHERE ${wh}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args, lim) as Array<{ title: string; body: string }>;
    return rows
      .map((r) => {
        const body = (r.body || "").slice(0, maxChars);
        return `### ${r.title}\n${body}`;
      })
      .join("\n\n")
      .trim();
  }

  getCooldownLast(project_id: string, session_id: string): number | null {
    const row = this.db
      .prepare(
        "SELECT last_compaction_at FROM compaction_cooldown WHERE project_id = ? AND session_id = ?",
      )
      .get(project_id, session_id) as { last_compaction_at: number } | undefined;
    if (!row) return null;
    return Number(row.last_compaction_at);
  }

  countCompactionsSince(project_id: string, session_id: string, sinceTimestamp: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM compaction_runs
         WHERE project_id = ? AND session_id = ? AND ran_at >= ?`,
      )
      .get(project_id, session_id, sinceTimestamp) as { c: number };
    return Number(row.c);
  }

  logCompactionRun(project_id: string, session_id: string): void {
    const now = Date.now() / 1000;
    this.db.prepare("INSERT INTO compaction_runs (project_id, session_id, ran_at) VALUES (?, ?, ?)").run(
      project_id,
      session_id,
      now,
    );
    this.db.prepare("DELETE FROM compaction_runs WHERE ran_at < ?").run(now - 86400 * 30);
  }

  touchCooldown(project_id: string, session_id: string): void {
    const now = Date.now() / 1000;
    this.db
      .prepare(
        `INSERT INTO compaction_cooldown (project_id, session_id, last_compaction_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id, session_id) DO UPDATE SET last_compaction_at = excluded.last_compaction_at`,
      )
      .run(project_id, session_id, now);
  }

  archiveDir(project_id: string, session_id: string): string {
    const d = join(this.dataDir, "projects", project_id, "sessions", session_id, "archive");
    mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * 시맨틱 테이블 제외: 메모·컴팩션·프로젝트 브레인 관련 행을 모두 삭제합니다.
   * `SemanticMemoryStore.wipeAllSemanticData`와 함께 호출하면 DB 사용자 데이터를 비울 수 있습니다.
   */
  wipeAllCoreTables(): void {
    this.db.exec(`
      DELETE FROM tasks;
      DELETE FROM milestones;
      DELETE FROM decisions;
      DELETE FROM knowledge;
      DELETE FROM project_files;
      DELETE FROM projects;
      DELETE FROM memories;
      DELETE FROM compaction_cooldown;
      DELETE FROM compaction_runs;
    `);
  }
}
