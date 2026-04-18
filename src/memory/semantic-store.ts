import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "@xenova/transformers";
import * as sqliteVec from "sqlite-vec";
import type { AppSettings } from "../config/settings.js";

/** `Xenova/all-MiniLM-L6-v2` 등 기본 임베딩 차원 (vec0 스키마와 일치해야 함). */
const SEMANTIC_EMBEDDING_DIM = 384;

export type SemanticChunk = {
  id: string;
  key: string;
  content: string;
  metadata: Record<string, unknown>;
  importance: number;
  distance: number | null;
  project_id: string;
  session_id: string;
};

function stableDocId(projectId: string, sessionId: string, memoryKey: string): string {
  return createHash("sha256").update(`${projectId}\x00${sessionId}\x00${memoryKey}`, "utf8").digest("hex");
}

function toXenovaModelName(embeddingModel: string): string {
  const m = embeddingModel.trim();
  if (!m) return "Xenova/all-MiniLM-L6-v2";
  if (m.startsWith("Xenova/")) return m;
  if (m.includes("/")) return m;
  return `Xenova/${m}`;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1e-12;
  return dot / denom;
}

function blobToFloat32(blob: Buffer | Uint8Array): Float32Array {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function float32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function float32ToUint8(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

type FeaturePipeline = Awaited<ReturnType<typeof pipeline>>;

type SqliteVecDb = { loadExtension: (path: string, entrypoint?: string) => void };

function openDbWithOptionalVec(dbPath: string): { db: DatabaseSync; vecEnabled: boolean } {
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
  return { db: new DatabaseSync(dbPath), vecEnabled: false };
}

export class SemanticMemoryStore {
  private readonly db: DatabaseSync;
  private readonly vecEnabled: boolean;
  private embedder: FeaturePipeline | null = null;
  private readonly xenovaModel: string;
  private vecBackfillDone = false;

  constructor(
    dataDir: string,
    embeddingModel: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "infinite_context_keeper.sqlite");
    const opened = openDbWithOptionalVec(dbPath);
    this.db = opened.db;
    this.vecEnabled = opened.vecEnabled;
    this.xenovaModel = toXenovaModelName(embeddingModel);
    this.ensureSchema();
  }

  static fromSettings(settings: AppSettings): SemanticMemoryStore {
    return new SemanticMemoryStore(settings.dataDir, settings.embeddingModel);
  }

  /** sqlite-vec(vec0) 기반 KNN 검색 사용 여부 (Node 23.5+ 및 확장 로드 성공 시 true). */
  isSqliteVecActive(): boolean {
    return this.vecEnabled;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        importance INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_project ON semantic_memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_semantic_project_session ON semantic_memories(project_id, session_id);
    `);
    if (this.vecEnabled) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_vec_meta (
          memory_id TEXT PRIMARY KEY,
          vec_rowid INTEGER NOT NULL UNIQUE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_vec USING vec0(
          embedding float[${SEMANTIC_EMBEDDING_DIM}]
        );
      `);
    }
  }

  private ensureVecBackfill(): void {
    if (!this.vecEnabled || this.vecBackfillDone) return;
    const pending = this.db
      .prepare(
        `SELECT sm.id, sm.embedding FROM semantic_memories sm
         WHERE NOT EXISTS (SELECT 1 FROM semantic_vec_meta m WHERE m.memory_id = sm.id)`,
      )
      .all() as Array<{ id: string; embedding: Buffer }>;
    for (const r of pending) {
      const vec = blobToFloat32(r.embedding);
      if (vec.length === SEMANTIC_EMBEDDING_DIM) {
        this.upsertVecRow(r.id, vec);
      }
    }
    this.vecBackfillDone = true;
  }

  /**
   * semantic_memories_vec + semantic_vec_meta에 행을 맞춥니다.
   * 이미 있으면 같은 vec_rowid로 임베딩만 교체합니다.
   */
  private upsertVecRow(memoryId: string, embedding: Float32Array): void {
    if (!this.vecEnabled) return;
    if (embedding.length !== SEMANTIC_EMBEDDING_DIM) {
      return;
    }
    const blob = float32ToUint8(embedding);
    const existing = this.db
      .prepare("SELECT vec_rowid FROM semantic_vec_meta WHERE memory_id = ?")
      .get(memoryId) as { vec_rowid: number } | undefined;
    if (existing) {
      this.db.prepare("DELETE FROM semantic_memories_vec WHERE rowid = ?").run(BigInt(existing.vec_rowid));
      this.db
        .prepare("INSERT INTO semantic_memories_vec (rowid, embedding) VALUES (?, ?)")
        .run(BigInt(existing.vec_rowid), blob);
      return;
    }
    const maxRow = this.db
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM semantic_memories_vec")
      .get() as { m: number };
    const nextRow = Number(maxRow.m) + 1;
    this.db.prepare("INSERT INTO semantic_vec_meta (memory_id, vec_rowid) VALUES (?, ?)").run(memoryId, nextRow);
    this.db.prepare("INSERT INTO semantic_memories_vec (rowid, embedding) VALUES (?, ?)").run(BigInt(nextRow), blob);
  }

  async warmup(): Promise<void> {
    if (this.embedder) return;
    this.embedder = await pipeline("feature-extraction", this.xenovaModel);
  }

  private async embedText(text: string): Promise<Float32Array> {
    await this.warmup();
    const ext = this.embedder! as (
      input: string,
      options: { pooling: string; normalize: boolean },
    ) => Promise<{ data: Float32Array }>;
    const out = await ext(text, { pooling: "mean", normalize: true });
    return new Float32Array(out.data);
  }

  async upsertMemory(params: {
    project_id: string;
    session_id: string;
    memory_key: string;
    content: string;
    metadata: Record<string, unknown> | null;
    importance: number;
  }): Promise<string> {
    const docId = stableDocId(params.project_id, params.session_id, params.memory_key);
    const vec = await this.embedText(params.content);
    const imp = Math.max(0, Math.min(10, Math.trunc(params.importance)));
    const userMetadataJson = JSON.stringify(params.metadata ?? {});

    this.db
      .prepare(
        `INSERT INTO semantic_memories (id, project_id, session_id, memory_key, content, embedding, metadata_json, importance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           embedding = excluded.embedding,
           metadata_json = excluded.metadata_json,
           importance = excluded.importance`,
      )
      .run(
        docId,
        params.project_id,
        params.session_id,
        params.memory_key,
        params.content,
        float32ToBlob(vec),
        userMetadataJson,
        imp,
      );
    this.upsertVecRow(docId, vec);
    return docId;
  }

  private mapRowToChunk(r: {
    id: string;
    project_id: string;
    session_id: string;
    memory_key: string;
    content: string;
    metadata_json: string;
    importance: number;
    distance: number;
  }): SemanticChunk {
    let userMeta: Record<string, unknown> = {};
    try {
      userMeta = JSON.parse(r.metadata_json || "{}") as Record<string, unknown>;
    } catch {
      userMeta = { _parse_error: true, raw: String(r.metadata_json || "").slice(0, 200) };
    }
    const imp = Number.isFinite(Number(r.importance)) ? Math.trunc(Number(r.importance)) : 0;
    return {
      id: r.id,
      key: r.memory_key,
      content: r.content || "",
      metadata: userMeta,
      importance: imp,
      distance: Number(r.distance),
      project_id: r.project_id,
      session_id: r.session_id,
    };
  }

  private semanticSearchWithVecSync(
    queryVec: Float32Array,
    params: {
      limit: number;
      project_id: string;
      session_id?: string | null;
    },
  ): SemanticChunk[] | null {
    if (!this.vecEnabled) return null;
    if (queryVec.length !== SEMANTIC_EMBEDDING_DIM) return null;
    this.ensureVecBackfill();
    const lim = Math.max(1, Math.min(params.limit, 100));
    const qBlob = float32ToUint8(queryVec);
    let rows: Array<{
      id: string;
      project_id: string;
      session_id: string;
      memory_key: string;
      content: string;
      metadata_json: string;
      importance: number;
      distance: number;
    }>;
    if (params.session_id) {
      rows = this.db
        .prepare(
          `SELECT sm.id, sm.project_id, sm.session_id, sm.memory_key, sm.content, sm.metadata_json, sm.importance, v.distance AS distance
           FROM semantic_memories_vec v
           INNER JOIN semantic_vec_meta meta ON meta.vec_rowid = v.rowid
           INNER JOIN semantic_memories sm ON sm.id = meta.memory_id
           WHERE sm.project_id = ? AND sm.session_id = ? AND v.embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(params.project_id, params.session_id, qBlob, lim) as typeof rows;
    } else {
      rows = this.db
        .prepare(
          `SELECT sm.id, sm.project_id, sm.session_id, sm.memory_key, sm.content, sm.metadata_json, sm.importance, v.distance AS distance
           FROM semantic_memories_vec v
           INNER JOIN semantic_vec_meta meta ON meta.vec_rowid = v.rowid
           INNER JOIN semantic_memories sm ON sm.id = meta.memory_id
           WHERE sm.project_id = ? AND v.embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(params.project_id, qBlob, lim) as typeof rows;
    }
    return rows.map((r) => this.mapRowToChunk(r));
  }

  async semanticSearch(params: {
    query: string;
    limit: number;
    project_id: string;
    session_id?: string | null;
  }): Promise<SemanticChunk[]> {
    const lim = Math.max(1, Math.min(params.limit, 100));
    const queryVec = await this.embedText(params.query);

    if (this.vecEnabled) {
      try {
        const viaVec = this.semanticSearchWithVecSync(queryVec, {
          limit: lim,
          project_id: params.project_id,
          session_id: params.session_id,
        });
        if (viaVec != null && viaVec.length > 0) {
          return viaVec;
        }
      } catch {
        // vec 쿼리 실패 시 아래 JS 경로로 폴백
      }
    }

    const where = params.session_id
      ? "project_id = ? AND session_id = ?"
      : "project_id = ?";
    const qargs: string[] =
      params.session_id != null ? [params.project_id, params.session_id] : [params.project_id];

    const rows = this.db
      .prepare(
        `SELECT id, project_id, session_id, memory_key, content, embedding, metadata_json, importance
         FROM semantic_memories WHERE ${where}`,
      )
      .all(...qargs) as Array<{
      id: string;
      project_id: string;
      session_id: string;
      memory_key: string;
      content: string;
      embedding: Buffer;
      metadata_json: string;
      importance: number;
    }>;

    if (!rows.length) return [];

    const scored = rows.map((r) => {
      const emb = blobToFloat32(r.embedding);
      const sim = cosineSimilarity(queryVec, emb);
      const distance = 1 - sim;
      let userMeta: Record<string, unknown> = {};
      try {
        userMeta = JSON.parse(r.metadata_json || "{}") as Record<string, unknown>;
      } catch {
        userMeta = { _parse_error: true, raw: String(r.metadata_json || "").slice(0, 200) };
      }
      const imp = Number.isFinite(Number(r.importance)) ? Math.trunc(Number(r.importance)) : 0;
      return {
        id: r.id,
        key: r.memory_key,
        content: r.content || "",
        metadata: userMeta,
        importance: imp,
        distance,
        project_id: r.project_id,
        session_id: r.session_id,
      } satisfies SemanticChunk;
    });

    scored.sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
    return scored.slice(0, lim);
  }

  /** 쿼리 임베딩 1회 + 각 텍스트 임베딩으로 코사인 랭킹 (짧은 후보 목록용). */
  async rankTextsBySimilarity(params: {
    query: string;
    items: Array<{ id: string; text: string; source?: string }>;
    topK: number;
  }): Promise<Array<{ id: string; text: string; source?: string; distance: number }>> {
    const lim = Math.max(1, Math.min(params.topK, 50));
    if (!params.items.length) return [];
    await this.warmup();
    const queryVec = await this.embedText(params.query);
    const batchSize = 8;
    const scored: Array<{ id: string; text: string; source?: string; distance: number }> = [];
    for (let i = 0; i < params.items.length; i += batchSize) {
      const slice = params.items.slice(i, i + batchSize);
      const texts = slice.map((it) => (it.text || "").slice(0, 8000));
      const embeds = await Promise.all(texts.map((t) => this.embedText(t)));
      for (let j = 0; j < slice.length; j++) {
        const sim = cosineSimilarity(queryVec, embeds[j]);
        scored.push({
          id: slice[j].id,
          text: slice[j].text,
          source: slice[j].source,
          distance: 1 - sim,
        });
      }
    }
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, lim);
  }
}