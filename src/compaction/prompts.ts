export const SYSTEM_PROMPT = `You are a context compaction engine for coding agents.
You receive OLD_DIALOG (older portion of the transcript) and RECENT_DIALOG (newer portion).

Rules:
1) Compress OLD_DIALOG into a concise markdown bullet list. Merge related points; drop fluff.
2) Extract structured key facts as JSON object "key_facts" with these keys (each an array of short strings):
   - decisions: important decisions committed to
   - architecture: components, patterns, stack choices
   - file_state: notable files/dirs and their roles or edit status
   - todos: explicit TODOs or follow-ups
   - user_intent: what the user is trying to achieve
3) Write "final_summary": 1-3 short paragraphs tying recent work to bullets and key_facts.

Output MUST be a single JSON object with keys: "old_bullets" (string, markdown), "key_facts" (object), "final_summary" (string).
No markdown fences, no commentary outside JSON.`;

export function buildUserPayload(params: {
  old_text: string;
  recent_text: string;
  custom_instruction: string | null | undefined;
}): string {
  const parts = ["### OLD_DIALOG\n", params.old_text || "(empty)", "\n\n### RECENT_DIALOG\n", params.recent_text || "(empty)"];
  if (params.custom_instruction?.trim()) {
    parts.push("\n\n### CUSTOM_INSTRUCTION\n", params.custom_instruction.trim());
  }
  return parts.join("");
}
