import type { CompactionLLMOutput, KeyFacts } from "./models.js";

function linesToBullets(text: string, maxLines = 80): string {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  return lines.length ? lines.map((ln) => `- ${ln.slice(0, 500)}`).join("\n") : "- (내용 없음)";
}

export function heuristicCompaction(oldText: string, recentText: string): CompactionLLMOutput {
  const bullets = linesToBullets(oldText);
  const preview = (recentText || "").trim().slice(0, 4000);
  const kf: KeyFacts = {
    decisions: ["휴리스틱 요약: ICK_OPENAI_API_KEY 설정 시 LLM으로 key_facts 추출"],
    architecture: [],
    file_state: [],
    todos: [],
    user_intent: [preview.slice(0, 800) + (preview.length > 800 ? "…" : "")],
  };
  const summary =
    "최근 대화 발췌:\n" +
    (preview.slice(0, 2000) + (preview.length > 2000 ? "…" : "")) +
    "\n\n오래된 구간은 bullet 로만 압축되었습니다.";
  return { old_bullets: bullets, key_facts: kf, final_summary: summary };
}
