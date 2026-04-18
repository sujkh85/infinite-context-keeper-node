import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppSettings } from "./config/settings.js";
import { estimateContextTokens } from "./monitoring/token-estimate.js";
import { SqliteMemoryStore } from "./memory/sqlite-store.js";
import { SemanticMemoryStore } from "./memory/semantic-store.js";
import { formatContextTopInjectionBlock, formatInjectBlock } from "./memory/inject-format.js";
import { runTriggerCompaction, type ChatMessage } from "./compaction/service.js";
import { scanUnityProjectFiles } from "./unity/scan-project.js";

function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errResult(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

function effectiveProjectId(args: Record<string, unknown>, settings: AppSettings): string {
  const raw = args.project_id;
  if (raw != null && String(raw).trim() !== "") return String(raw).trim();
  return settings.defaultProjectId;
}

async function mergedChromaForTask(
  semantic: SemanticMemoryStore,
  params: { query: string; project_id: string; session_id: string; top_k: number; fill_from_project: boolean },
) {
  const sessionHits = await semantic.semanticSearch({
    query: params.query,
    limit: params.top_k,
    project_id: params.project_id,
    session_id: params.session_id,
  });
  if (!params.fill_from_project || sessionHits.length >= params.top_k) {
    return sessionHits.slice(0, params.top_k);
  }
  const seen = new Set(sessionHits.map((h) => h.id));
  const out = [...sessionHits];
  const projHits = await semantic.semanticSearch({
    query: params.query,
    limit: Math.max(params.top_k * 3, 24),
    project_id: params.project_id,
    session_id: null,
  });
  for (const h of projHits) {
    if (seen.has(h.id)) continue;
    out.push(h);
    seen.add(h.id);
    if (out.length >= params.top_k) break;
  }
  return out.slice(0, params.top_k);
}

const TOOLS = [
  {
    name: "get_context_usage",
    description:
      "MCP 호스트가 넘기는 used_tokens·대화 본문·tool 결과 문자열을 tiktoken으로 합산해 컨텍스트 사용량을 추정합니다.",
    inputSchema: {
      type: "object",
      properties: {
        max_tokens: { type: "number", description: "컨텍스트 윈도우 최대 토큰" },
        session_id: { type: "string", default: "default" },
        used_tokens: { type: "number" },
        conversation_text: { type: "string" },
        tool_results_text: { type: "string" },
        system_prompt_text: { type: "string" },
        text_for_estimate: { type: "string" },
        encoding_model: { type: "string" },
      },
      required: ["max_tokens"],
    },
  },
  {
    name: "trigger_compaction",
    description:
      "summarization_start_ratio(기본 75%) 이상일 때만 실행하도록 context_percentage 또는 used_tokens+max_tokens로 검증합니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        session_id: { type: "string" },
        conversation_text: { type: "string" },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
        },
        mode: { type: "string", enum: ["hierarchical", "flat"], default: "hierarchical" },
        custom_instruction: { type: "string" },
        max_tokens: { type: "number" },
        used_tokens: { type: "number" },
        context_percentage: { type: "number" },
      },
      required: ["project_id", "session_id"],
    },
  },
  {
    name: "save_memory",
    description: "시맨틱 메모리에 project_id·session_id 스코프로 저장합니다. 동일 key는 upsert됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        content: { type: "string" },
        project_id: { type: "string" },
        session_id: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
        importance: { type: "number", default: 0 },
      },
      required: ["key", "content", "project_id", "session_id"],
    },
  },
  {
    name: "semantic_search_memory",
    description:
      "관련 메모리 청크를 반환합니다. sqlite-vec(vec0) KNN이 켜지면 DB 내 벡터 인덱스로 검색하고, 아니면 JS 코사인으로 폴백합니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project_id: { type: "string" },
        limit: { type: "number", default: 8 },
        session_id: { type: "string" },
      },
      required: ["query", "project_id"],
    },
  },
  {
    name: "inject_relevant_memories",
    description: "semantic_search_memory와 동일 스코프로 검색 후 tiktoken 예산 내 마크다운 블록을 만듭니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project_id: { type: "string", default: "default" },
        session_id: { type: "string" },
        limit: { type: "number", default: 6 },
        max_inject_tokens: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_and_inject_memory",
    description: "새 세션/compaction 직후 컨텍스트 상단 주입 블록을 반환합니다.",
    inputSchema: {
      type: "object",
      properties: {
        task_description: { type: "string" },
        project_id: { type: "string" },
        session_id: { type: "string" },
        top_k: { type: "number", default: 8 },
        max_inject_tokens: { type: "number" },
        fill_from_project: { type: "boolean", default: true },
        include_recent_compaction_in_query: { type: "boolean", default: true },
        injection_mode: {
          type: "string",
          enum: ["new_session", "post_compaction", "manual"],
          default: "manual",
        },
      },
      required: ["task_description", "project_id", "session_id"],
    },
  },
  {
    name: "list_memories",
    description: "SQLite에 저장된 compaction 요약 등의 메타를 나열합니다.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        session_id: { type: "string" },
        tag: { type: "string" },
        limit: { type: "number", default: 50 },
        offset: { type: "number", default: 0 },
      },
      required: ["project_id"],
    },
  },
  {
    name: "project_get_status",
    description:
      "Project Brain: 프로젝트 메타, 마일스톤·태스크, 최근 결정/지식, Unity 파일 인덱스 건수를 한 번에 조회합니다. project_id 생략 시 default_project_id.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "생략 시 설정의 default_project_id" },
      },
    },
  },
  {
    name: "project_create_milestone",
    description: "Project Brain: 마일스톤을 추가합니다(자동 order_num).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "task_break_down",
    description:
      "Project Brain: 마일스톤을 세부 태스크로 나눕니다. tasks가 비어 있으면 마일스톤 정보와 함께 모델이 tasks 배열을 채워 재호출하도록 안내합니다.",
    inputSchema: {
      type: "object",
      properties: {
        milestone_id: { type: "string" },
        complexity_level: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "참고용(저장되지 않음). LLM이 분해 난이도에 맞춰 tasks 개수·세분화를 조절.",
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              file_path: { type: "string" },
              priority: { type: "number" },
              estimated_hours: { type: "number" },
            },
            required: ["title"],
          },
        },
      },
      required: ["milestone_id"],
    },
  },
  {
    name: "task_update",
    description: "Project Brain: 태스크 상태·노트(설명에 타임스탬프 부가)·누적 actual_hours 갱신.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", description: "todo / in_progress / done 등" },
        note: { type: "string" },
        hours_spent: { type: "number", description: "actual_hours에 가산" },
      },
      required: ["id"],
    },
  },
  {
    name: "unity_scan_project",
    description:
      "Unity 프로젝트 루트(기본: process.cwd)를 스캔해 project_files 테이블을 갱신합니다. Assets가 있으면 그 하위 위주로 .cs 등 인덱싱.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        unity_project_root: { type: "string", description: "Unity 프로젝트 절대/상대 경로" },
        max_files: { type: "number", default: 8000 },
      },
    },
  },
  {
    name: "memory_search",
    description:
      "시맨틱 메모리(semantic_memories) + 결정/지식 테이블 텍스트에 로컬 임베딩 코사인 랭킹을 합쳐 검색합니다.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project_id: { type: "string" },
        limit: { type: "number", default: 12 },
      },
      required: ["query"],
    },
  },
  {
    name: "project_resume",
    description:
      "새 세션 시작 시 호출: 프로젝트 브레인 요약 마크다운(inject_block) + 구조화 JSON + 최근 compaction 스니펫 + 시맨틱 상위 청크.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        session_id: { type: "string", default: "default", description: "compaction 스니펫용" },
        top_semantic: { type: "number", default: 5 },
      },
    },
  },
] as const;

export async function runMcpServer(settings: AppSettings, sqlite: SqliteMemoryStore, semantic: SemanticMemoryStore) {
  await semantic.warmup();

  const server = new Server(
    { name: "Infinite Context Keeper", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      if (name === "get_context_usage") {
        const max_tokens = Number(args.max_tokens);
        const used_tokens = args.used_tokens != null ? Number(args.used_tokens) : null;
        const conversation_text =
          [args.conversation_text, args.text_for_estimate].filter(Boolean).join("\n\n") || null;
        const enc = (args.encoding_model as string | undefined) ?? settings.tiktokenEncoding;
        const est = estimateContextTokens({
          usedTokens: used_tokens,
          conversationText: conversation_text,
          toolResultsText: (args.tool_results_text as string) ?? null,
          systemPromptText: (args.system_prompt_text as string) ?? null,
          encodingModel: enc,
          settingsFallbackEncoding: settings.tiktokenEncoding,
        });
        const pct = max_tokens > 0 ? Math.round((est.estimatedTokens / max_tokens) * 1000) / 10 : 0;
        return jsonResult({
          percentage: pct,
          estimated_tokens: est.estimatedTokens,
          threshold: settings.contextUsageThresholdPercent,
        });
      }

      if (name === "trigger_compaction") {
        const messages = args.messages as ChatMessage[] | undefined;
        const result = await runTriggerCompaction({
          settings,
          store: sqlite,
          project_id: String(args.project_id),
          session_id: String(args.session_id),
          conversation_text: (args.conversation_text as string) ?? null,
          messages,
          mode: (args.mode as "hierarchical" | "flat") ?? "hierarchical",
          custom_instruction: (args.custom_instruction as string) ?? null,
          max_tokens: args.max_tokens != null ? Number(args.max_tokens) : null,
          used_tokens: args.used_tokens != null ? Number(args.used_tokens) : null,
          context_percentage: args.context_percentage != null ? Number(args.context_percentage) : null,
        });
        return jsonResult(result);
      }

      if (name === "save_memory") {
        const metadata = (args.metadata as Record<string, unknown>) ?? {};
        const mid = await semantic.upsertMemory({
          project_id: String(args.project_id),
          session_id: String(args.session_id),
          memory_key: String(args.key),
          content: String(args.content),
          metadata,
          importance: args.importance != null ? Number(args.importance) : 0,
        });
        return jsonResult({
          memory_id: mid,
          project_id: String(args.project_id),
          session_id: String(args.session_id),
          key: String(args.key),
        });
      }

      if (name === "semantic_search_memory") {
        const raw = await semantic.semanticSearch({
          query: String(args.query),
          limit: args.limit != null ? Number(args.limit) : 8,
          project_id: String(args.project_id),
          session_id: (args.session_id as string) ?? null,
        });
        return jsonResult({
          query: String(args.query),
          project_id: String(args.project_id),
          chunks: raw,
          sqlite_vec_knn: semantic.isSqliteVecActive(),
        });
      }

      if (name === "inject_relevant_memories") {
        const raw = await semantic.semanticSearch({
          query: String(args.query),
          limit: args.limit != null ? Number(args.limit) : 6,
          project_id: String(args.project_id ?? "default"),
          session_id: (args.session_id as string) ?? null,
        });
        const budget =
          args.max_inject_tokens != null
            ? Math.max(128, Math.min(Number(args.max_inject_tokens), 100_000))
            : Math.max(128, settings.maxInjectTokensDefault);
        const block =
          raw.length === 0
            ? `## Relevant memories\nQuery: ${String(args.query)}\n\n_(일치하는 메모리 없음)_`
            : formatInjectBlock(raw, {
                query: String(args.query),
                maxTokens: budget,
                encodingName: settings.tiktokenEncoding,
              });
        return jsonResult({
          query: String(args.query),
          project_id: String(args.project_id ?? "default"),
          inject_block: block,
          memory_ids: raw.map((c) => c.id),
        });
      }

      if (name === "search_and_inject_memory") {
        let enriched = String(args.task_description).trim();
        if (args.include_recent_compaction_in_query !== false) {
          const hints = sqlite.fetchRecentCompactionSnippets({
            project_id: String(args.project_id),
            session_id: String(args.session_id),
            limit: 2,
          });
          if (hints) {
            enriched =
              `${enriched}\n\n--- Recent compaction context (SQLite, boosts retrieval only) ---\n${hints}`;
          }
        }
        const raw = await mergedChromaForTask(semantic, {
          query: enriched,
          project_id: String(args.project_id),
          session_id: String(args.session_id),
          top_k: args.top_k != null ? Number(args.top_k) : 8,
          fill_from_project: args.fill_from_project !== false,
        });
        const budget =
          args.max_inject_tokens != null
            ? Math.max(128, Math.min(Number(args.max_inject_tokens), 100_000))
            : Math.max(128, settings.maxInjectTokensDefault);
        const injectionMode = (args.injection_mode as "new_session" | "post_compaction" | "manual") ?? "manual";
        const block = formatContextTopInjectionBlock(raw, {
          taskDescription: String(args.task_description),
          maxTokens: budget,
          encodingName: settings.tiktokenEncoding,
          injectionMode,
        });
        return jsonResult({
          task_description: String(args.task_description),
          project_id: String(args.project_id),
          session_id: String(args.session_id),
          inject_block: block,
          memory_ids: raw.map((c) => c.id),
          chunks_used: raw.length,
        });
      }

      if (name === "list_memories") {
        const { items, total } = sqlite.listMemories({
          project_id: String(args.project_id),
          session_id: (args.session_id as string) ?? null,
          tag: (args.tag as string) ?? null,
          limit: args.limit != null ? Number(args.limit) : 50,
          offset: args.offset != null ? Number(args.offset) : 0,
        });
        return jsonResult({ items, total_hint: total });
      }

      if (name === "project_get_status") {
        const project_id = effectiveProjectId(args, settings);
        sqlite.brain.ensureProject({ id: project_id });
        const bundle = sqlite.brain.getProjectStatusBundle(project_id);
        const md: string[] = [`## Project: ${project_id}`];
        if (bundle.project) {
          md.push(`- **이름:** ${bundle.project.name ?? "—"}`);
          md.push(`- **목표:** ${bundle.project.goal ?? "—"}`);
          md.push(`- **상태:** ${bundle.project.status ?? "—"}`);
        }
        md.push(`- **인덱스된 Unity 파일 수:** ${bundle.indexed_file_count}`);
        md.push("");
        md.push("### 마일스톤 / 태스크");
        for (const m of bundle.milestones) {
          md.push(`- **${m.title}** (${m.status ?? "?"})`);
          for (const t of m.tasks) {
            md.push(`  - [${t.status ?? "?"}] ${t.title}${t.file_path ? ` — \`${t.file_path}\`` : ""}`);
          }
        }
        return jsonResult({
          project_id,
          ...bundle,
          summary_markdown: md.join("\n"),
        });
      }

      if (name === "project_create_milestone") {
        const project_id = effectiveProjectId(args, settings);
        const title = String(args.title);
        const description = args.description != null ? String(args.description) : null;
        const milestone_id = sqlite.brain.createMilestone(project_id, title, description);
        return jsonResult({ project_id, milestone_id, title });
      }

      if (name === "task_break_down") {
        const milestone_id = String(args.milestone_id);
        const complexity_level = (args.complexity_level as string | undefined) ?? "medium";
        const ms = sqlite.brain.getMilestone(milestone_id);
        if (!ms) {
          return errResult(`Unknown milestone_id: ${milestone_id}`);
        }
        const rawTasks = args.tasks as
          | Array<{
              title: string;
              description?: string;
              file_path?: string;
              priority?: number;
              estimated_hours?: number;
            }>
          | undefined;
        if (!rawTasks || !Array.isArray(rawTasks) || rawTasks.length === 0) {
          return jsonResult({
            phase: "awaiting_tasks",
            complexity_level,
            milestone: ms,
            instruction:
              "마일스톤을 구체적인 태스크 목록으로 나눈 뒤, 같은 도구(task_break_down)에 tasks 배열을 채워 다시 호출하면 SQLite에 저장됩니다.",
          });
        }
        const created_task_ids = sqlite.brain.insertTasks(
          milestone_id,
          rawTasks.map((t) => ({
            title: String(t.title),
            description: t.description != null ? String(t.description) : null,
            file_path: t.file_path != null ? String(t.file_path) : null,
            priority: t.priority != null ? Number(t.priority) : null,
            estimated_hours: t.estimated_hours != null ? Number(t.estimated_hours) : null,
          })),
        );
        return jsonResult({
          phase: "persisted",
          milestone_id,
          complexity_level,
          created_task_ids,
          task_count: created_task_ids.length,
        });
      }

      if (name === "task_update") {
        const id = String(args.id);
        const task = sqlite.brain.updateTask({
          id,
          status: args.status != null ? String(args.status) : null,
          note: args.note != null ? String(args.note) : null,
          hours_spent: args.hours_spent != null ? Number(args.hours_spent) : null,
        });
        if (!task) {
          return errResult(`Unknown task id: ${id}`);
        }
        return jsonResult({ task });
      }

      if (name === "unity_scan_project") {
        const project_id = effectiveProjectId(args, settings);
        const unity_project_root = (args.unity_project_root as string | undefined)?.trim() || process.cwd();
        const max_files = args.max_files != null ? Number(args.max_files) : 8000;
        const files = await scanUnityProjectFiles(unity_project_root, max_files);
        const { inserted } = sqlite.brain.replaceProjectFiles(project_id, files);
        return jsonResult({
          project_id,
          unity_project_root,
          indexed_files: inserted,
          sample_paths: files.slice(0, 24).map((f) => f.rel_path),
        });
      }

      if (name === "memory_search") {
        const project_id = effectiveProjectId(args, settings);
        const query = String(args.query);
        const limit = args.limit != null ? Number(args.limit) : 12;
        const half = Math.max(1, Math.ceil(limit / 2));
        const semantic_chunks = await semantic.semanticSearch({
          query,
          limit: half,
          project_id,
          session_id: null,
        });
        const brainChunks = sqlite.brain.listTextChunksForVectorSearch(project_id, 200);
        const brain_ranked = await semantic.rankTextsBySimilarity({
          query,
          items: brainChunks.map((c) => ({ id: c.id, text: c.text, source: c.source })),
          topK: Math.max(1, limit - half),
        });
        return jsonResult({
          query,
          project_id,
          semantic_memories: semantic_chunks,
          decisions_and_knowledge: brain_ranked,
          sqlite_vec_knn: semantic.isSqliteVecActive(),
        });
      }

      if (name === "project_resume") {
        const project_id = effectiveProjectId(args, settings);
        const session_id = (args.session_id as string | undefined)?.trim() || "default";
        const top_semantic = args.top_semantic != null ? Number(args.top_semantic) : 5;
        sqlite.brain.ensureProject({ id: project_id });
        const bundle = sqlite.brain.getProjectStatusBundle(project_id);
        const compaction = sqlite.fetchRecentCompactionSnippets({
          project_id,
          session_id,
          limit: 2,
        });
        const qSeed = [bundle.project?.goal, bundle.project?.name].filter(Boolean).join("\n") || "프로젝트 작업 재개";
        const semantic_top = await semantic.semanticSearch({
          query: qSeed,
          limit: Math.max(1, Math.min(top_semantic, 20)),
          project_id,
          session_id: null,
        });
        const lines: string[] = [];
        lines.push("# Project resume");
        lines.push("");
        lines.push(`**project_id:** \`${project_id}\` · **session_id (compaction 힌트):** \`${session_id}\``);
        lines.push("");
        if (bundle.project) {
          lines.push("## 프로젝트");
          lines.push(`- **이름:** ${bundle.project.name ?? "—"}`);
          lines.push(`- **목표:** ${bundle.project.goal ?? "—"}`);
          lines.push(`- **상태:** ${bundle.project.status ?? "—"}`);
          lines.push("");
        }
        lines.push("## 마일스톤 · 태스크");
        if (bundle.milestones.length === 0) {
          lines.push("_(등록된 마일스톤 없음 — `project_create_milestone` 사용)_");
        }
        for (const m of bundle.milestones) {
          lines.push(`### ${m.title} (${m.status ?? "?"})`);
          if (m.description) {
            lines.push(m.description);
          }
          for (const t of m.tasks) {
            lines.push(`- [${t.status ?? "?"}] **${t.title}**${t.file_path ? ` — \`${t.file_path}\`` : ""}`);
          }
          lines.push("");
        }
        lines.push("## 최근 결정");
        if (bundle.recent_decisions.length === 0) {
          lines.push("_(없음)_");
        } else {
          for (const d of bundle.recent_decisions) {
            lines.push(`- **${d.title}**`);
          }
        }
        lines.push("");
        lines.push("## 지식 베이스 (최근)");
        if (bundle.recent_knowledge.length === 0) {
          lines.push("_(없음)_");
        } else {
          for (const k of bundle.recent_knowledge) {
            lines.push(`- **${k.title}**${k.category ? ` (${k.category})` : ""}`);
          }
        }
        lines.push("");
        lines.push(`## Unity 파일 인덱스: **${bundle.indexed_file_count}**개`);
        lines.push("");
        if (compaction) {
          lines.push("---");
          lines.push("## 최근 compaction 요약 (SQLite)");
          lines.push(compaction);
          lines.push("");
        }
        if (semantic_top.length > 0) {
          lines.push("---");
          lines.push("## 관련 시맨틱 메모 (상위)");
          for (const c of semantic_top) {
            lines.push(`### ${c.key}`);
            lines.push((c.content || "").slice(0, 600));
            lines.push("");
          }
        }
        lines.push("---");
        lines.push(
          "다음 단계: 필요 시 `memory_search`로 결정/지식을 더 찾고, `task_update`로 진행을 기록하세요.",
        );
        const inject_block = lines.join("\n");
        return jsonResult({
          project_id,
          session_id,
          inject_block,
          bundle,
          semantic_top,
        });
      }

      return errResult(`Unknown tool: ${name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errResult(msg);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
