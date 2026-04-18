import { getTiktokenEncoder } from "../encoding/tiktoken.js";

const textDecoder = new TextDecoder("utf-8");

export function splitTextByTokenRatio(
  text: string,
  params: { encodingName: string; fallbackEncoding: string; oldTokenRatio?: number },
): [string, string] {
  let oldTokenRatio = params.oldTokenRatio ?? 0.65;
  if (oldTokenRatio <= 0 || oldTokenRatio >= 1) oldTokenRatio = 0.65;
  const { enc } = getTiktokenEncoder(params.encodingName, params.fallbackEncoding);
  const ids = enc.encode(text || "", "all");
  if (!ids.length) return ["", ""];
  const cut = Math.max(1, Math.floor(ids.length * oldTokenRatio));
  const oldIds = ids.slice(0, cut);
  const recentIds = ids.slice(cut);
  const decodeTokens = (tokens: Uint32Array) => textDecoder.decode(enc.decode(tokens));
  return [decodeTokens(oldIds), decodeTokens(recentIds)];
}
