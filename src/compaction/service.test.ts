import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAppSettings } from "../config/settings.js";
import { runTriggerCompaction } from "./service.js";

describe("runTriggerCompaction", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores compaction output in SQLite and semantic memory", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ick-compaction-"));
    tempDirs.push(dataDir);
    const memoryIds: string[] = [];
    const store = {
      getCooldownLast: () => null,
      countCompactionsSince: () => 0,
      archiveDir: () => dataDir,
      insertMemory: () => {
        const id = `sqlite:${memoryIds.length + 1}`;
        memoryIds.push(id);
        return id;
      },
      touchCooldown: () => undefined,
      logCompactionRun: () => undefined,
    };
    const semanticCalls: Array<{ memory_key: string; content: string; importance: number }> = [];
    const semantic = {
      async upsertMemory(params: { memory_key: string; content: string; importance: number }) {
        semanticCalls.push(params);
        return `semantic:${params.memory_key}`;
      },
    };

    const result = await runTriggerCompaction({
      settings: {
        ...defaultAppSettings,
        dataDir,
        embeddingEnabled: true,
        compactionCooldownSeconds: 0,
      },
      store: store as never,
      semantic,
      project_id: "proj",
      session_id: "sess",
      conversation_text: "old decision\nnew next_steps: continue implementation",
      messages: null,
      mode: "flat",
      custom_instruction: null,
      max_tokens: null,
      used_tokens: null,
      context_percentage: 90,
    });

    expect(result.status).toBe("completed_with_fallback");
    expect(result.memory_ids).toHaveLength(2);
    expect(result.semantic_memory_ids).toHaveLength(2);
    expect(semanticCalls.map((c) => c.memory_key)).toEqual([
      `compaction:${result.compaction_id}:summary`,
      `compaction:${result.compaction_id}:key_facts`,
    ]);
    expect(semanticCalls[0]?.content).toContain("## 통합 요약");
    expect(semanticCalls[1]?.importance).toBe(9);
  });
});
