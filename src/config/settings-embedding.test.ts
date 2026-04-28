import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadSettings } from "./settings.js";

describe("embeddingEnabled env override", () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env.ICK_EMBEDDING_ENABLED;
    delete process.env.ICK_EMBEDDING_ENABLED;
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.ICK_EMBEDDING_ENABLED;
    else process.env.ICK_EMBEDDING_ENABLED = prior;
  });

  it("ICK_EMBEDDING_ENABLED=0 이면 false", () => {
    process.env.ICK_EMBEDDING_ENABLED = "0";
    expect(loadSettings().embeddingEnabled).toBe(false);
  });

  it("ICK_EMBEDDING_ENABLED=1 이면 true", () => {
    process.env.ICK_EMBEDDING_ENABLED = "1";
    expect(loadSettings().embeddingEnabled).toBe(true);
  });
});
