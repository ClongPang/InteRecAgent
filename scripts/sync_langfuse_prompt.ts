import { LangfuseClient } from "@langfuse/client";
import {
  CONVERSATION_PROMPT_LABEL,
  assertConversationPromptMatchesSource,
  conversationPromptCreateBody,
  resolveTelemetryConfig,
} from "../packages/runtime/src/index.js";
import {
  CONVERSATION_PROMPT_NAME,
  CONVERSATION_PROMPT_SHA256,
  CONVERSATION_PROMPT_VERSION,
} from "../packages/agent/src/index.js";

const plan = {
  promptName: CONVERSATION_PROMPT_NAME,
  sourceVersion: CONVERSATION_PROMPT_VERSION,
  sourceSha256: CONVERSATION_PROMPT_SHA256,
  deploymentLabel: CONVERSATION_PROMPT_LABEL,
};

if (process.env["INTEREC_LANGFUSE_PROMPT_SYNC_CONFIRM"] !== "authorized-prompt-sync") {
  process.stdout.write(`${JSON.stringify({ mode: "DRY_RUN", ...plan }, null, 2)}\n`);
  process.exit(0);
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)["statusCode"] ?? (error as Record<string, unknown>)["status"];
  return typeof value === "number" ? value : undefined;
}

const wait = (milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function retryTransient<T>(operation: () => Promise<T>, attempts = 4, retryNotFound = false): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = statusCode(error);
      if (status !== undefined && status < 500 && status !== 408 && status !== 429 && !(retryNotFound && status === 404)) throw error;
      if (attempt < attempts) await wait(1_000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

const telemetryConfig = resolveTelemetryConfig();
if (!telemetryConfig.langfuseEnabled) throw new Error("LANGFUSE_CREDENTIALS_REQUIRED");
const langfuse = new LangfuseClient({
  publicKey: telemetryConfig.publicKey!,
  secretKey: telemetryConfig.secretKey!,
  ...(telemetryConfig.baseUrl ? { baseUrl: telemetryConfig.baseUrl } : {}),
  timeout: 10,
});

try {
  let latest = null;
  try {
    latest = await retryTransient(() => langfuse.prompt.get(CONVERSATION_PROMPT_NAME, {
      type: "text",
      cacheTtlSeconds: 0,
      fetchTimeoutMs: 10_000,
      maxRetries: 0,
    }));
  } catch (error) {
    if (statusCode(error) !== 404) throw error;
  }

  let action: "CREATED" | "LABEL_UPDATED" | "UNCHANGED";
  if (!latest) {
    await retryTransient(() => langfuse.prompt.create(conversationPromptCreateBody()));
    action = "CREATED";
  } else {
    try {
      assertConversationPromptMatchesSource(latest);
      if (!latest.labels.includes(CONVERSATION_PROMPT_LABEL)) {
        await retryTransient(() => langfuse.prompt.update({
          name: latest.name,
          version: latest.version,
          newLabels: [...new Set([...latest.labels, CONVERSATION_PROMPT_LABEL])],
        }));
        action = "LABEL_UPDATED";
      } else {
        action = "UNCHANGED";
      }
    } catch (error) {
      if (!(error instanceof Error) || !/^LANGFUSE_PROMPT_(?:CONTENT|VERSION|HASH)_DRIFT$/.test(error.message)) throw error;
      await retryTransient(() => langfuse.prompt.create(conversationPromptCreateBody()));
      action = "CREATED";
    }
  }

  const verified = await retryTransient(() => langfuse.prompt.get(CONVERSATION_PROMPT_NAME, {
    type: "text",
    label: CONVERSATION_PROMPT_LABEL,
    cacheTtlSeconds: 0,
    fetchTimeoutMs: 10_000,
    maxRetries: 2,
  }), 4, true);
  assertConversationPromptMatchesSource(verified);
  process.stdout.write(`${JSON.stringify({ mode: "SYNCED", action, ...plan, langfuseVersion: verified.version }, null, 2)}\n`);
} finally {
  await langfuse.shutdown();
}
