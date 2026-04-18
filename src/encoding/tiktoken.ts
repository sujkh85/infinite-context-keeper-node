import { get_encoding, type TiktokenEmbedding } from "@dqbd/tiktoken";

const SUPPORTED: readonly TiktokenEmbedding[] = ["gpt2", "r50k_base", "p50k_base", "p50k_edit", "cl100k_base"];

const ALIASES: Record<string, TiktokenEmbedding> = {
  "gpt-4": "cl100k_base",
  "gpt-4o": "cl100k_base",
  o200k_base: "cl100k_base",
  "gpt-3.5-turbo": "cl100k_base",
  cl100k_base: "cl100k_base",
  r50k_base: "r50k_base",
  p50k_base: "p50k_base",
  p50k_edit: "p50k_edit",
  gpt2: "gpt2",
};

/** @dqbd/tiktoken 이 지원하는 인코딩 이름으로 정규화합니다. */
export function normalizeTiktokenEncoding(name: string, fallback: string): TiktokenEmbedding {
  const tryOne = (raw: string): TiktokenEmbedding | null => {
    const k = raw.trim();
    if (k in ALIASES) return ALIASES[k]!;
    if ((SUPPORTED as readonly string[]).includes(k)) return k as TiktokenEmbedding;
    return null;
  };
  return tryOne(name) ?? tryOne(fallback) ?? "cl100k_base";
}

export function getTiktokenEncoder(encodingName: string, fallbackEncoding: string) {
  for (const candidate of [encodingName, fallbackEncoding, "cl100k_base"]) {
    const encName = normalizeTiktokenEncoding(candidate, "cl100k_base");
    try {
      return { enc: get_encoding(encName), name: encName };
    } catch {
      continue;
    }
  }
  return { enc: get_encoding("cl100k_base"), name: "cl100k_base" as const };
}
