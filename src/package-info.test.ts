import { describe, it, expect } from "vitest";
import { getPackageVersion } from "./package-info.js";

describe("getPackageVersion", () => {
  it("비어 있지 않은 문자열을 반환", () => {
    const v = getPackageVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });
});
