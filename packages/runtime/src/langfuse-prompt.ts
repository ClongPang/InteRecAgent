import type { LangfuseClient, TextPromptClient } from "@langfuse/client";
import {
  CONVERSATION_PROMPT_NAME,
  CONVERSATION_PROMPT_SHA256,
  CONVERSATION_PROMPT_VERSION,
  CONVERSATION_SYSTEM_PROMPT,
} from "@interec/agent";
import { retryLangfuseControlPlaneRead } from "./langfuse-control-plane.js";

export const CONVERSATION_PROMPT_LABEL = "production";

export interface LangfusePromptLink {
  name: string;
  version: number;
  isFallback: boolean;
}

function configRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function assertConversationPromptMatchesSource(prompt: TextPromptClient): void {
  const config = configRecord(prompt.config);
  if (prompt.name !== CONVERSATION_PROMPT_NAME) throw new Error("LANGFUSE_PROMPT_NAME_MISMATCH");
  if (prompt.isFallback) throw new Error("LANGFUSE_PROMPT_FALLBACK_NOT_LINKABLE");
  if (prompt.prompt !== CONVERSATION_SYSTEM_PROMPT) throw new Error("LANGFUSE_PROMPT_CONTENT_DRIFT");
  if (config["sourceVersion"] !== CONVERSATION_PROMPT_VERSION) throw new Error("LANGFUSE_PROMPT_VERSION_DRIFT");
  if (config["sourceSha256"] !== CONVERSATION_PROMPT_SHA256) throw new Error("LANGFUSE_PROMPT_HASH_DRIFT");
}

export async function fetchConversationPrompt(
  langfuse: LangfuseClient,
  options: { label?: string; fetchTimeoutMs?: number; maxRetries?: number } = {},
): Promise<TextPromptClient> {
  return retryLangfuseControlPlaneRead(async () => {
      const prompt = await langfuse.prompt.get(CONVERSATION_PROMPT_NAME, {
        type: "text",
        label: options.label ?? CONVERSATION_PROMPT_LABEL,
        cacheTtlSeconds: 0,
        fetchTimeoutMs: options.fetchTimeoutMs ?? 10_000,
        maxRetries: 0,
      });
      assertConversationPromptMatchesSource(prompt);
      return prompt;
  }, { attempts: Math.max(1, (options.maxRetries ?? 2) + 1) });
}

export function promptLink(prompt: TextPromptClient): LangfusePromptLink {
  assertConversationPromptMatchesSource(prompt);
  return { name: prompt.name, version: prompt.version, isFallback: prompt.isFallback };
}

export interface ConversationPromptCreateBody {
  name: string;
  type: "text";
  prompt: string;
  labels: string[];
  tags: string[];
  config: Record<string, unknown>;
  commitMessage: string;
}

export function conversationPromptCreateBody(): ConversationPromptCreateBody {
  return {
    name: CONVERSATION_PROMPT_NAME,
    type: "text",
    prompt: CONVERSATION_SYSTEM_PROMPT,
    labels: [CONVERSATION_PROMPT_LABEL],
    tags: ["interec", "conversation-agent", "git-source"],
    config: {
      sourceVersion: CONVERSATION_PROMPT_VERSION,
      sourceSha256: CONVERSATION_PROMPT_SHA256,
      sourceOfTruth: "packages/agent/src/turn-agent.ts",
    },
    commitMessage: `Sync ${CONVERSATION_PROMPT_VERSION} (${CONVERSATION_PROMPT_SHA256.slice(7, 15)}) from Git`,
  };
}
