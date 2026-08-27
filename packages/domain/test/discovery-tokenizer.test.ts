import { describe, expect, it } from "vitest";

import { matchDiscoveryTokens, tokenizeDiscoveryText } from "../src/index.js";

describe("discovery tokenizer", () => {
  it("creates stable latin, numeric and CJK bigram tokens", () => {
    expect(tokenizeDiscoveryText("  轻薄笔记本 Laptop 14  ")).toEqual([
      "laptop",
      "14",
      "轻薄",
      "薄笔",
      "笔记",
      "记本",
    ]);
    expect(tokenizeDiscoveryText("ＬＡＰＴＯＰ laptop")).toEqual(["laptop"]);
  });

  it("reports exact bounded token coverage", () => {
    expect(matchDiscoveryTokens(
      ["laptop", "轻薄", "笔记"],
      ["轻薄", "出差", "laptop", "laptop"],
    )).toEqual({ matchedTokens: ["轻薄", "laptop"], coverage: 2 / 3 });
  });

  it("rejects invalid token limits", () => {
    expect(() => tokenizeDiscoveryText("laptop", 0)).toThrowError(/INVALID_DISCOVERY_TOKEN_LIMIT/);
    expect(() => tokenizeDiscoveryText("laptop", 129)).toThrowError(/INVALID_DISCOVERY_TOKEN_LIMIT/);
  });
});
