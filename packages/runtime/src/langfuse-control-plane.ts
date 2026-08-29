function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const item = error as Record<string, unknown>;
  const status = item["statusCode"] ?? item["status"];
  return typeof status === "number" ? status : undefined;
}

export async function retryLangfuseIdempotentRequest<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = statusCode(error);
      if (typeof status === "number" && status < 500 && status !== 408 && status !== 429) throw error;
      if (attempt < attempts) await new Promise((resolveWait) => setTimeout(resolveWait, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export function retryLangfuseControlPlaneRead<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  return retryLangfuseIdempotentRequest(operation, options);
}
