import { describe, expect, it } from "vitest";

import { matchSearchTokens, tokenizeSearchText } from "../src/index.js";

describe("search tokenizer", () => {
  it("creates stable latin, numeric and CJK bigram tokens", () => {
    expect(tokenizeSearchText("  轻薄笔记本 Laptop 14  ")).toEqual([
      "laptop",
      "14",
      "轻薄",
      "薄笔",
      "笔记",
      "记本",
    ]);
    expect(tokenizeSearchText("ＬＡＰＴＯＰ laptop")).toEqual(["laptop"]);
  });

  it("reports exact bounded token coverage", () => {
    expect(matchSearchTokens(
      ["laptop", "轻薄", "笔记"],
      ["轻薄", "出差", "laptop", "laptop"],
    )).toEqual({ matchedTokens: ["轻薄", "laptop"], coverage: 2 / 3 });
  });

  it("rejects invalid token limits", () => {
    expect(() => tokenizeSearchText("laptop", 0)).toThrowError(/INVALID_SEARCH_TOKEN_LIMIT/);
    expect(() => tokenizeSearchText("laptop", 129)).toThrowError(/INVALID_SEARCH_TOKEN_LIMIT/);
  });
});
