import { getTiktokenEncoder, normalizeTiktokenEncoding } from "../encoding/tiktoken.js";

const ENCODING_ALIASES: Record<string, string> = {
  "gpt-4": "cl100k_base",
  "gpt-4o": "o200k_base",
  "gpt-3.5-turbo": "cl100k_base",
  cl100k_base: "cl100k_base",
  o200k_base: "o200k_base",
  p50k_base: "p50k_base",
  r50k_base: "r50k_base",
};

export type TokenEstimate = {
  estimatedTokens: number;
  textTokens: number;
  usedTokens: number | null;
  encodingUsed: string;
  method: string;
};

/** 호출자·YAML의 논리적 인코딩 이름을 @dqbd/tiktoken 지원 이름으로 정규화합니다. */
export function resolveEncodingName(encodingModel: string, fallback: string): string {
  const key = (encodingModel || "").trim();
  const logical = !key ? fallback : ENCODING_ALIASES[key] ?? key;
  return normalizeTiktokenEncoding(logical, fallback);
}

function countTokens(text: string | null | undefined, encodingName: string, fallbackEncoding: string): number {
  if (!text) return 0;
  const { enc } = getTiktokenEncoder(encodingName, fallbackEncoding);
  return enc.encode(text, "all").length;
}

export function estimateContextTokens(params: {
  usedTokens: number | null | undefined;
  conversationText: string | null | undefined;
  toolResultsText: string | null | undefined;
  systemPromptText: string | null | undefined;
  encodingModel: string;
  settingsFallbackEncoding: string;
}): TokenEstimate {
  const encoding = resolveEncodingName(params.encodingModel, params.settingsFallbackEncoding);
  const { name: encodingResolved } = getTiktokenEncoder(encoding, params.settingsFallbackEncoding);

  const conv = countTokens(params.conversationText, encoding, params.settingsFallbackEncoding);
  const tools = countTokens(params.toolResultsText, encoding, params.settingsFallbackEncoding);
  const system_ = countTokens(params.systemPromptText, encoding, params.settingsFallbackEncoding);
  const textTotal = conv + tools + system_;

  let est: number;
  let method: string;
  if (params.usedTokens != null) {
    est = Math.max(Math.trunc(params.usedTokens), textTotal);
    method = "max(host_used_tokens, text_components)";
  } else {
    est = textTotal;
    method = "text_components_only";
  }

  return {
    estimatedTokens: est,
    textTokens: textTotal,
    usedTokens: params.usedTokens ?? null,
    encodingUsed: encodingResolved,
    method,
  };
}
