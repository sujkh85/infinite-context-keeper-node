import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppSettings } from "../config/settings.js";
import { SqliteMemoryStore } from "../memory/sqlite-store.js";
import { heuristicCompaction } from "./heuristic.js";
import { callCompactionLlm } from "./llm.js";
import { splitTextByTokenRatio } from "./split.js";
import type { CompactionLLMOutput } from "./models.js";

export type ChatMessage = { role: "user" | "assistant" | "system" | "tool"; content: string };

export type TriggerCompactionResult = {
  project_id: string;
  session_id: string;
  compaction_id: string;
  status: "rejected" | "completed" | "completed_with_fallback";
  message: string;
  archive_path: string | null;
  memory_ids: string[];
  key_facts: Record<string, string[]> | null;
  old_bullets: string | null;
  final_summary: string | null;
};

function normalizeDialogue(params: {
  conversation_text: string | null | undefined;
  messages: ChatMessage[] | null | undefined;
}): string {
  if (params.conversation_text?.trim()) return params.conversation_text.trim();
  if (params.messages?.length) {
    return params.messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n").trim();
  }
  return "";
}

function writeArchive(
  archiveDir: string,
  params: {
    compaction_id: string;
    project_id: string;
    session_id: string;
    conversation_text: string | null | undefined;
    messages: ChatMessage[] | null | undefined;
    raw_full: string;
  },
): string {
  const path = join(archiveDir, `${params.compaction_id}.json`);
  const payload = {
    compaction_id: params.compaction_id,
    project_id: params.project_id,
    session_id: params.session_id,
    archived_at: Date.now() / 1000,
    conversation_text: params.conversation_text ?? null,
    messages: params.messages ?? null,
    raw_merged_dialogue: params.raw_full,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

export async function runTriggerCompaction(params: {
  settings: AppSettings;
  store: SqliteMemoryStore;
  project_id: string;
  session_id: string;
  conversation_text: string | null | undefined;
  messages: ChatMessage[] | null | undefined;
  mode: "hierarchical" | "flat";
  custom_instruction: string | null | undefined;
  max_tokens: number | null | undefined;
  used_tokens: number | null | undefined;
  context_percentage: number | null | undefined;
}): Promise<TriggerCompactionResult> {
  const cid = randomUUID();
  const minPct = params.settings.summarizationStartRatio * 100;

  if (params.context_percentage != null && params.context_percentage + 1e-9 < minPct) {
    return {
      project_id: params.project_id,
      session_id: params.session_id,
      compaction_id: cid,
      status: "rejected",
      message: `context_percentage ${params.context_percentage}% 가 요약 시작 기준 ${minPct.toFixed(0)}% 미만입니다.`,
      archive_path: null,
      memory_ids: [],
      key_facts: null,
      old_bullets: null,
      final_summary: null,
    };
  }
  if (params.max_tokens != null && params.used_tokens != null && params.max_tokens > 0) {
    const pct = (params.used_tokens / params.max_tokens) * 100;
    if (pct + 1e-9 < minPct) {
      return {
        project_id: params.project_id,
        session_id: params.session_id,
        compaction_id: cid,
        status: "rejected",
        message: `추정 사용률 ${pct.toFixed(1)}% 가 기준 ${minPct.toFixed(0)}% 미만입니다.`,
        archive_path: null,
        memory_ids: [],
        key_facts: null,
        old_bullets: null,
        final_summary: null,
      };
    }
  }

  const raw = normalizeDialogue({
    conversation_text: params.conversation_text,
    messages: params.messages,
  });
  if (!raw) {
    return {
      project_id: params.project_id,
      session_id: params.session_id,
      compaction_id: cid,
      status: "rejected",
      message: "conversation_text 또는 messages 가 필요합니다.",
      archive_path: null,
      memory_ids: [],
      key_facts: null,
      old_bullets: null,
      final_summary: null,
    };
  }

  const last = params.store.getCooldownLast(params.project_id, params.session_id);
  const now = Date.now() / 1000;
  if (last != null && now - last < params.settings.compactionCooldownSeconds) {
    return {
      project_id: params.project_id,
      session_id: params.session_id,
      compaction_id: cid,
      status: "rejected",
      message: `compaction 쿨다운 중입니다 (${params.settings.compactionCooldownSeconds}s).`,
      archive_path: null,
      memory_ids: [],
      key_facts: null,
      old_bullets: null,
      final_summary: null,
    };
  }

  const window = params.settings.compactionRateWindowSeconds;
  const since = now - window;
  const runCount = params.store.countCompactionsSince(params.project_id, params.session_id, since);
  if (runCount >= params.settings.compactionMaxRunsPerWindow) {
    return {
      project_id: params.project_id,
      session_id: params.session_id,
      compaction_id: cid,
      status: "rejected",
      message:
        `compaction 스로틀: 최근 ${Math.trunc(window)}초 안에 이미 ${runCount}회 실행되었습니다 ` +
        `(허용 ${params.settings.compactionMaxRunsPerWindow}회). ` +
        "`compaction_cooldown_seconds`·`compaction_max_runs_per_window`·`compaction_rate_window_seconds`를 조정하세요.",
      archive_path: null,
      memory_ids: [],
      key_facts: null,
      old_bullets: null,
      final_summary: null,
    };
  }

  const archiveDir = params.store.archiveDir(params.project_id, params.session_id);
  const archivePath = writeArchive(archiveDir, {
    compaction_id: cid,
    project_id: params.project_id,
    session_id: params.session_id,
    conversation_text: params.conversation_text,
    messages: params.messages,
    raw_full: raw,
  });

  const [oldText, recentText] = splitTextByTokenRatio(raw, {
    encodingName: params.settings.tiktokenEncoding,
    fallbackEncoding: params.settings.tiktokenEncoding,
    oldTokenRatio: 0.65,
  });

  let out: CompactionLLMOutput;
  let usedLlm = false;
  let msgNote: string;
  const apiKey = (params.settings.openaiApiKey ?? "").trim();

  if (params.mode !== "hierarchical") {
    out = heuristicCompaction(oldText, recentText);
    msgNote = "mode=flat 이면 휴리스틱 요약만 수행합니다.";
  } else if (apiKey) {
    try {
      out = await callCompactionLlm({
        old_text: oldText,
        recent_text: recentText,
        custom_instruction: params.custom_instruction,
        api_key: apiKey,
        base_url: params.settings.openaiBaseUrl,
        model: params.settings.compactionModel,
      });
      usedLlm = true;
      msgNote = "OpenAI 호환 API로 계층 요약을 생성했습니다.";
    } catch (e) {
      out = heuristicCompaction(oldText, recentText);
      msgNote = `LLM 실패(${e instanceof Error ? e.name : "Error"}), 휴리스틱으로 대체했습니다.`;
    }
  } else {
    out = heuristicCompaction(oldText, recentText);
    msgNote = "ICK_OPENAI_API_KEY 미설정 — 휴리스틱 요약만 수행했습니다.";
  }

  const summaryBody =
    `<!-- compaction_id=${cid} mode=${params.mode} -->\n\n` +
    "## 오래된 대화 (bullet)\n\n" +
    `${out.old_bullets}\n\n` +
    "## 통합 요약\n\n" +
    `${out.final_summary}\n`;
  const kfJson = JSON.stringify(out.key_facts, null, 2);

  const midSummary = params.store.insertMemory({
    project_id: params.project_id,
    session_id: params.session_id,
    title: `Compaction ${cid} — hierarchical summary`,
    body: summaryBody,
    tags: ["compaction", "summary", "hierarchical"],
    kind: "compaction_summary",
  });
  const midFacts = params.store.insertMemory({
    project_id: params.project_id,
    session_id: params.session_id,
    title: `Compaction ${cid} — key_facts`,
    body: kfJson,
    tags: ["compaction", "key_facts", "json"],
    kind: "compaction_key_facts",
  });

  params.store.touchCooldown(params.project_id, params.session_id);
  params.store.logCompactionRun(params.project_id, params.session_id);

  const status: TriggerCompactionResult["status"] = usedLlm ? "completed" : "completed_with_fallback";
  return {
    project_id: params.project_id,
    session_id: params.session_id,
    compaction_id: cid,
    status,
    message: msgNote,
    archive_path: archivePath,
    memory_ids: [midSummary, midFacts],
    key_facts: out.key_facts,
    old_bullets: out.old_bullets,
    final_summary: out.final_summary,
  };
}
