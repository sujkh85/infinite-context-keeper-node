export type KeyFacts = {
  decisions: string[];
  architecture: string[];
  file_state: string[];
  todos: string[];
  user_intent: string[];
};

export type CompactionLLMOutput = {
  old_bullets: string;
  key_facts: KeyFacts;
  final_summary: string;
};

export function emptyKeyFacts(): KeyFacts {
  return { decisions: [], architecture: [], file_state: [], todos: [], user_intent: [] };
}

export function validateCompactionOutput(raw: unknown): CompactionLLMOutput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid LLM JSON");
  const o = raw as Record<string, unknown>;
  const old_bullets = typeof o.old_bullets === "string" ? o.old_bullets : "";
  const final_summary = typeof o.final_summary === "string" ? o.final_summary : "";
  const kfRaw = o.key_facts;
  const kfObj = kfRaw && typeof kfRaw === "object" && !Array.isArray(kfRaw) ? (kfRaw as Record<string, unknown>) : {};
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const key_facts: KeyFacts = {
    decisions: asList(kfObj.decisions),
    architecture: asList(kfObj.architecture),
    file_state: asList(kfObj.file_state),
    todos: asList(kfObj.todos),
    user_intent: asList(kfObj.user_intent),
  };
  return { old_bullets, key_facts, final_summary };
}
