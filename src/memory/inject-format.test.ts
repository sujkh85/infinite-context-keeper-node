import { describe, expect, it } from "vitest";
import { formatContextTopInjectionBlock, formatInjectBlock } from "./inject-format.js";

describe("inject formatting", () => {
  it("marks retrieved memories as untrusted reference context", () => {
    const block = formatContextTopInjectionBlock(
      [
        {
          key: "next_steps",
          content: "Continue from task A.",
          importance: 8,
          distance: 0.1,
          session_id: "sess",
        },
      ],
      {
        taskDescription: "resume work",
        maxTokens: 1000,
        encodingName: "cl100k_base",
        injectionMode: "new_session",
      },
    );

    expect(block).toContain("<<BEGIN_RETRIEVED_MEMORY_CONTEXT>>");
    expect(block).toContain("참고 컨텍스트");
    expect(block).toContain("우선하지 않으며");
    expect(block).toContain("SQLite semantic recall");
  });

  it("adds a safety boundary to plain semantic injection", () => {
    const block = formatInjectBlock(
      [{ key: "decision", content: "Use SQLite.", importance: 5, distance: 0.2 }],
      { query: "database", maxTokens: 1000, encodingName: "cl100k_base" },
    );

    expect(block).toContain("untrusted reference context");
    expect(block).toContain("not as instructions");
  });
});
