import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type MilestoneRow = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  order_num: number | null;
  status: string | null;
  completed_at: string | null;
};

export type TaskRow = {
  id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  status: string | null;
  priority: number | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  dependencies: string | null;
  file_path: string | null;
  updated_at: string | null;
};

export type DecisionRow = {
  id: string;
  project_id: string;
  title: string;
  content: string;
  timestamp: string | null;
  related_files: string | null;
};

export type KnowledgeRow = {
  id: string;
  project_id: string;
  category: string | null;
  title: string;
  content: string;
};

export type ProjectFileRow = {
  id: string;
  project_id: string;
  rel_path: string;
  kind: string | null;
  mtime_ms: number | null;
  scanned_at: string | null;
};

export type BrainTextChunk = {
  id: string;
  source: "decision" | "knowledge";
  text: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class ProjectBrainStore {
  constructor(private readonly db: DatabaseSync) {}

  ensureProject(params: { id: string; name?: string | null; goal?: string | null }): void {
    const t = nowIso();
    const row = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(params.id) as { id: string } | undefined;
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, goal, created_at, last_active, status)
           VALUES (?, ?, ?, ?, ?, 'active')`,
        )
        .run(params.id, params.name ?? params.id, params.goal ?? null, t, t);
    } else {
      this.db
        .prepare(`UPDATE projects SET last_active = ?, name = COALESCE(?, name), goal = COALESCE(?, goal) WHERE id = ?`)
        .run(t, params.name ?? null, params.goal ?? null, params.id);
    }
  }

  touchProject(projectId: string): void {
    this.db.prepare(`UPDATE projects SET last_active = ? WHERE id = ?`).run(nowIso(), projectId);
  }

  getProject(projectId: string):
    | {
        id: string;
        name: string | null;
        goal: string | null;
        created_at: string | null;
        last_active: string | null;
        status: string | null;
      }
    | undefined {
    return this.db.prepare(`SELECT id, name, goal, created_at, last_active, status FROM projects WHERE id = ?`).get(
      projectId,
    ) as
      | {
          id: string;
          name: string | null;
          goal: string | null;
          created_at: string | null;
          last_active: string | null;
          status: string | null;
        }
      | undefined;
  }

  createMilestone(projectId: string, title: string, description: string | null): string {
    this.ensureProject({ id: projectId });
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(order_num), -1) + 1 AS n FROM milestones WHERE project_id = ?`)
      .get(projectId) as { n: number };
    const orderNum = Number(row.n);
    const id = randomUUID();
    const t = nowIso();
    this.db
      .prepare(
        `INSERT INTO milestones (id, project_id, title, description, order_num, status, completed_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL)`,
      )
      .run(id, projectId, title, description, orderNum);
    this.touchProject(projectId);
    return id;
  }

  getMilestone(milestoneId: string): MilestoneRow | undefined {
    return this.db
      .prepare(`SELECT id, project_id, title, description, order_num, status, completed_at FROM milestones WHERE id = ?`)
      .get(milestoneId) as MilestoneRow | undefined;
  }

  listMilestones(projectId: string): MilestoneRow[] {
    return this.db
      .prepare(
        `SELECT id, project_id, title, description, order_num, status, completed_at
         FROM milestones WHERE project_id = ? ORDER BY order_num ASC, id ASC`,
      )
      .all(projectId) as MilestoneRow[];
  }

  listTasksForMilestone(milestoneId: string): TaskRow[] {
    return this.db
      .prepare(
        `SELECT id, milestone_id, title, description, status, priority, estimated_hours, actual_hours, dependencies, file_path, updated_at
         FROM tasks WHERE milestone_id = ?
         ORDER BY CASE WHEN priority IS NULL THEN 1 ELSE 0 END ASC, priority DESC, id ASC`,
      )
      .all(milestoneId) as TaskRow[];
  }

  insertTasks(
    milestoneId: string,
    tasks: Array<{
      title: string;
      description?: string | null;
      file_path?: string | null;
      priority?: number | null;
      estimated_hours?: number | null;
    }>,
  ): string[] {
    const ms = this.getMilestone(milestoneId);
    if (!ms) throw new Error(`Unknown milestone_id: ${milestoneId}`);
    const ids: string[] = [];
    const t = nowIso();
    const ins = this.db.prepare(
      `INSERT INTO tasks (id, milestone_id, title, description, status, priority, estimated_hours, actual_hours, dependencies, file_path, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, NULL, '[]', ?, ?)`,
    );
    for (const task of tasks) {
      const id = randomUUID();
      ins.run(
        id,
        milestoneId,
        task.title,
        task.description ?? null,
        task.priority ?? null,
        task.estimated_hours ?? null,
        task.file_path ?? null,
        t,
      );
      ids.push(id);
    }
    this.touchProject(ms.project_id);
    return ids;
  }

  updateTask(params: {
    id: string;
    status?: string | null;
    note?: string | null;
    hours_spent?: number | null;
  }): TaskRow | undefined {
    const cur = this.db
      .prepare(
        `SELECT id, milestone_id, title, description, status, priority, estimated_hours, actual_hours, dependencies, file_path, updated_at
         FROM tasks WHERE id = ?`,
      )
      .get(params.id) as TaskRow | undefined;
    if (!cur) return undefined;
    let description = cur.description ?? "";
    if (params.note != null && String(params.note).trim() !== "") {
      const stamp = nowIso();
      description = `${description}\n\n[${stamp}] ${params.note}`.trim();
    }
    const status = params.status != null ? String(params.status) : (cur.status ?? "todo");
    let actual = cur.actual_hours != null ? Number(cur.actual_hours) : 0;
    if (params.hours_spent != null && Number.isFinite(Number(params.hours_spent))) {
      actual += Number(params.hours_spent);
    }
    const t = nowIso();
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, description = ?, actual_hours = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, description || null, actual > 0 ? actual : null, t, params.id);
    const ms = this.getMilestone(cur.milestone_id);
    if (ms) this.touchProject(ms.project_id);
    return this.db
      .prepare(
        `SELECT id, milestone_id, title, description, status, priority, estimated_hours, actual_hours, dependencies, file_path, updated_at
         FROM tasks WHERE id = ?`,
      )
      .get(params.id) as TaskRow;
  }

  listDecisions(projectId: string, limit: number): DecisionRow[] {
    const lim = Math.max(1, Math.min(limit, 200));
    return this.db
      .prepare(
        `SELECT id, project_id, title, content, timestamp, related_files FROM decisions
         WHERE project_id = ? ORDER BY timestamp DESC NULLS LAST, id DESC LIMIT ?`,
      )
      .all(projectId, lim) as DecisionRow[];
  }

  listKnowledge(projectId: string, limit: number): KnowledgeRow[] {
    const lim = Math.max(1, Math.min(limit, 200));
    return this.db
      .prepare(
        `SELECT id, project_id, category, title, content FROM knowledge
         WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(projectId, lim) as KnowledgeRow[];
  }

  listTextChunksForVectorSearch(projectId: string, maxRows: number): BrainTextChunk[] {
    const cap = Math.max(1, Math.min(maxRows, 500));
    const dec = this.db
      .prepare(`SELECT id, title, content FROM decisions WHERE project_id = ? LIMIT ?`)
      .all(projectId, cap) as Array<{ id: string; title: string; content: string }>;
    const kn = this.db
      .prepare(`SELECT id, title, content FROM knowledge WHERE project_id = ? LIMIT ?`)
      .all(projectId, cap) as Array<{ id: string; title: string; content: string }>;
    const out: BrainTextChunk[] = [];
    for (const r of dec) {
      out.push({ id: r.id, source: "decision", text: `${r.title}\n${r.content}`.trim() });
    }
    for (const r of kn) {
      out.push({ id: r.id, source: "knowledge", text: `${r.title}\n${r.content}`.trim() });
    }
    return out;
  }

  replaceProjectFiles(
    projectId: string,
    files: Array<{ rel_path: string; kind: string | null; mtime_ms: number | null }>,
  ): { inserted: number } {
    this.ensureProject({ id: projectId });
    this.db.prepare(`DELETE FROM project_files WHERE project_id = ?`).run(projectId);
    const t = nowIso();
    const ins = this.db.prepare(
      `INSERT INTO project_files (id, project_id, rel_path, kind, mtime_ms, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const f of files) {
      ins.run(randomUUID(), projectId, f.rel_path, f.kind, f.mtime_ms, t);
    }
    this.touchProject(projectId);
    return { inserted: files.length };
  }

  countProjectFiles(projectId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM project_files WHERE project_id = ?`)
      .get(projectId) as { c: number };
    return Number(row.c);
  }

  getProjectStatusBundle(projectId: string): {
    project: ReturnType<ProjectBrainStore["getProject"]>;
    milestones: Array<MilestoneRow & { tasks: TaskRow[] }>;
    recent_decisions: DecisionRow[];
    recent_knowledge: KnowledgeRow[];
    indexed_file_count: number;
  } {
    const project = this.getProject(projectId);
    const milestones = this.listMilestones(projectId).map((m) => ({
      ...m,
      tasks: this.listTasksForMilestone(m.id),
    }));
    return {
      project,
      milestones,
      recent_decisions: this.listDecisions(projectId, 8),
      recent_knowledge: this.listKnowledge(projectId, 8),
      indexed_file_count: this.countProjectFiles(projectId),
    };
  }
}
