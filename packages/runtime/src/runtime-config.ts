const DEFAULT_BUYWHERE_TIMEOUT_MS = 10_000;
const MIN_BUYWHERE_TIMEOUT_MS = 1_000;
const MAX_BUYWHERE_TIMEOUT_MS = 30_000;

export function resolveBuyWhereTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment["INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS"]?.trim();
  if (!raw) return DEFAULT_BUYWHERE_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) throw new Error("INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS_INVALID");
  const value = Number(raw);
  if (value < MIN_BUYWHERE_TIMEOUT_MS || value > MAX_BUYWHERE_TIMEOUT_MS) {
    throw new Error("INTEREC_PROVIDER_BUYWHERE_TIMEOUT_MS_OUT_OF_RANGE");
  }
  return value;
}

export interface BuyWhereRuntimeConfig {
  apiKey: string;
  timeoutMs: number;
}

export function resolveBuyWhereRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): BuyWhereRuntimeConfig {
  const apiKey = environment["INTEREC_PROVIDER_BUYWHERE_API_KEY"]?.trim() ?? "";
  if (!apiKey) throw new Error("INTEREC_PROVIDER_BUYWHERE_API_KEY_REQUIRED");
  return { apiKey, timeoutMs: resolveBuyWhereTimeoutMs(environment) };
}
