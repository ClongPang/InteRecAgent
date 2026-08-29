import { describe, expect, it } from "vitest";

import {
  CONVERSATION_PROMPT_NAME,
  CONVERSATION_PROMPT_SHA256,
  CONVERSATION_PROMPT_VERSION,
  CONVERSATION_SYSTEM_PROMPT,
} from "@interec/agent";
import { assertConversationPromptMatchesSource, promptLink } from "../src/langfuse-prompt.js";

function nativePrompt(overrides: Record<string, unknown> = {}) {
  return {
    name: CONVERSATION_PROMPT_NAME,
    version: 7,
    config: { sourceVersion: CONVERSATION_PROMPT_VERSION, sourceSha256: CONVERSATION_PROMPT_SHA256 },
    labels: ["production"],
    tags: [],
    isFallback: false,
    type: "text",
    prompt: CONVERSATION_SYSTEM_PROMPT,
    ...overrides,
  } as never;
}

describe("native Langfuse prompt association", () => {
  it("links only a server-returned version that matches the Git source", () => {
    expect(promptLink(nativePrompt())).toEqual({ name: CONVERSATION_PROMPT_NAME, version: 7, isFallback: false });
  });

  it("fails closed on content drift and fallback prompts", () => {
    expect(() => assertConversationPromptMatchesSource(nativePrompt({ prompt: "drifted" }))).toThrow("LANGFUSE_PROMPT_CONTENT_DRIFT");
    expect(() => assertConversationPromptMatchesSource(nativePrompt({ isFallback: true }))).toThrow("LANGFUSE_PROMPT_FALLBACK_NOT_LINKABLE");
  });
});
