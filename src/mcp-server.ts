import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppSettings } from "./config/settings.js";
import { estimateContextTokens } from "./monitoring/token-estimate.js";
import { SqliteMemoryStore } from "./memory/sqlite-store.js";
import { SemanticMemoryStore } from "./memory/semantic-store.js";
import { formatContextTopInjectionBlock, formatInjectBlock } from "./memory/inject-format.js";
import { runTriggerCompaction, type ChatMessage } from "./compaction/service.js";

function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errResult(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
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
    description: "코사인 유사도로 관련 메모리 청크를 반환합니다.",
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

      return errResult(`Unknown tool: ${name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errResult(msg);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
