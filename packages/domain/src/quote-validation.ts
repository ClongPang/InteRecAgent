import { DomainError } from "./errors.js";

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "admissions",
  "availability",
  "delivery",
  "providerAvailability",
  "rawPayload",
  "rawRecord",
  "rawRecords",
  "stock",
]);

export function assertNoForbiddenPublicKey(value: unknown, path = "quote"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPublicKey(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_KEYS.has(key)) throw new DomainError("QUOTE_PUBLIC_FIELD_FORBIDDEN", `${path}.${key}`);
    assertNoForbiddenPublicKey(child, `${path}.${key}`);
  }
}

export function uniqueRefs(values: readonly string[], code: string): string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) {
    throw new DomainError(code, normalized.join(","));
  }
  return normalized;
}

export function assertIso(value: string, code: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new DomainError(code, value);
  return new Date(value).toISOString();
}

export function assertHttps(value: string, code: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomainError(code, value);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new DomainError(code, value);
  return parsed.toString();
}
