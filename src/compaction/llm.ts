import { SYSTEM_PROMPT, buildUserPayload } from "./prompts.js";
import { validateCompactionOutput, type CompactionLLMOutput } from "./models.js";

function extractJsonObject(text: string): unknown {
  const raw = (text || "").trim();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    /* continue */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim()) as unknown;
    } catch {
      /* continue */
    }
  }
  throw new Error("LLM 응답에서 JSON 객체를 파싱할 수 없습니다.");
}

export async function callCompactionLlm(params: {
  old_text: string;
  recent_text: string;
  custom_instruction: string | null | undefined;
  api_key: string;
  base_url: string;
  model: string;
  timeout_seconds?: number;
}): Promise<CompactionLLMOutput> {
  const base = params.base_url.replace(/\/$/, "");
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const userContent = buildUserPayload({
    old_text: params.old_text,
    recent_text: params.recent_text,
    custom_instruction: params.custom_instruction,
  });
  const payload = {
    model: params.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  };
  const timeout = params.timeout_seconds ?? 120;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout * 1000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI 호환 API 오류: ${res.status} ${errText.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const raw = extractJsonObject(content);
  return validateCompactionOutput(raw);
}
