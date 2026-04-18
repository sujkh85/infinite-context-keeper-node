import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "@xenova/transformers";
import type { AppSettings } from "../config/settings.js";

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

type FeaturePipeline = Awaited<ReturnType<typeof pipeline>>;

export class SemanticMemoryStore {
  private readonly db: DatabaseSync;
  private embedder: FeaturePipeline | null = null;
  private readonly xenovaModel: string;

  constructor(
    dataDir: string,
    embeddingModel: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "infinite_context_keeper.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.xenovaModel = toXenovaModelName(embeddingModel);
    this.ensureSchema();
  }

  static fromSettings(settings: AppSettings): SemanticMemoryStore {
    return new SemanticMemoryStore(settings.dataDir, settings.embeddingModel);
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
    return docId;
  }

  async semanticSearch(params: {
    query: string;
    limit: number;
    project_id: string;
    session_id?: string | null;
  }): Promise<SemanticChunk[]> {
    const lim = Math.max(1, Math.min(params.limit, 100));
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

    const queryVec = await this.embedText(params.query);
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
}
