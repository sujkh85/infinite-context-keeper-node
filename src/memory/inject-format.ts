import { getTiktokenEncoder } from "../encoding/tiktoken.js";

const textDecoder = new TextDecoder("utf-8");

function encoder(name: string): ReturnType<typeof getTiktokenEncoder>["enc"] {
  return getTiktokenEncoder(name, "cl100k_base").enc;
}

function decodeTokens(enc: ReturnType<typeof getTiktokenEncoder>["enc"], tokens: Uint32Array): string {
  return textDecoder.decode(enc.decode(tokens));
}

type Chunk = {
  id?: string;
  key?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  importance?: number;
  distance?: number | null;
  session_id?: string;
};

export function formatInjectBlock(
  chunks: Chunk[],
  params: { query: string; maxTokens: number; encodingName: string },
): string {
  const enc = encoder(params.encodingName);
  const header = `## Relevant memories (semantic recall)\nQuery: ${params.query}\n\n`;
  const parts: string[] = [header];
  let used = enc.encode(header, "all").length;

  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i]!;
    const block =
      `### [${i + 1}] key=${JSON.stringify(ch.key ?? "")} ` +
      `importance=${ch.importance ?? 0} ` +
      `distance=${ch.distance}\n` +
      `${ch.content ?? ""}\n\n`;
    const t = enc.encode(block, "all").length;
    if (used + t > params.maxTokens) {
      const remain = params.maxTokens - used - enc.encode("… (truncated)\n", "all").length;
      if (remain > 50) {
        const body = ch.content ?? "";
        const bodyEnc = enc.encode(body, "all");
        const slice = bodyEnc.slice(0, Math.max(0, remain - 20));
        const short = decodeTokens(enc, slice) + "…\n\n";
        parts.push(`### [${i + 1}] key=${JSON.stringify(ch.key ?? "")} (truncated)\n${short}`);
      }
      break;
    }
    parts.push(block);
    used += t;
  }
  return parts.join("").trim();
}

export function formatContextTopInjectionBlock(
  chunks: Chunk[],
  params: {
    taskDescription: string;
    maxTokens: number;
    encodingName: string;
    injectionMode: "new_session" | "post_compaction" | "manual";
  },
): string {
  const enc = encoder(params.encodingName);
  const modeNote: Record<typeof params.injectionMode, string> = {
    new_session: "새 세션 시작 시 자동 주입용",
    post_compaction: "compaction 직후 맥락 복원용",
    manual: "작업 중 수동 주입용",
  };
  const banner =
    "<<BEGIN_INJECTED_MEMORIES_TOP_PRIORITY>>\n" +
    "호스트 지시: 아래 블록을 **에이전트 컨텍스트 최상단**에 붙이세요 " +
    "(system 메시지 앞이나 첫 user 턴 직전). " +
    `(${modeNote[params.injectionMode]})\n\n` +
    "### Current task (relevance anchor)\n" +
    `${params.taskDescription.trim()}\n\n` +
    "### Top retrieved memories (Chroma)\n\n";
  const footer = "\n<<END_INJECTED_MEMORIES_TOP_PRIORITY>>\n";
  const footerTok = enc.encode(footer, "all").length;
  const bannerTok = enc.encode(banner, "all").length;
  const budget = Math.max(64, params.maxTokens - footerTok);
  if (!chunks.length) {
    return (banner + "_(벡터 메모 없음 — Chroma에 일치하는 청크가 없습니다.)_\n" + footer).trim();
  }

  const parts: string[] = [banner];
  let used = bannerTok;

  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i]!;
    const block =
      `#### [${i + 1}] key=${JSON.stringify(ch.key ?? "")} | session=${JSON.stringify(ch.session_id ?? "")} | ` +
      `importance=${ch.importance ?? 0} | distance=${ch.distance}\n` +
      `${ch.content ?? ""}\n\n`;
    const t = enc.encode(block, "all").length;
    if (used + t > budget) {
      const remain = budget - used - enc.encode("… (truncated)\n", "all").length;
      if (remain > 80) {
        const body = ch.content ?? "";
        const bodyEnc = enc.encode(body, "all");
        const slice = bodyEnc.slice(0, Math.max(0, remain - 40));
        const short = decodeTokens(enc, slice) + "…\n\n";
        parts.push(`#### [${i + 1}] key=${JSON.stringify(ch.key ?? "")} (truncated)\n${short}`);
      }
      break;
    }
    parts.push(block);
    used += t;
  }
  return (parts.join("") + footer).trim();
}
