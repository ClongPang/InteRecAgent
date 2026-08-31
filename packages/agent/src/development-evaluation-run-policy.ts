export type DevelopmentEvaluationModelFailureCode =
  | "MODEL_PROVIDER_INSUFFICIENT_BALANCE"
  | "MODEL_PROVIDER_AUTHORIZATION_FAILED"
  | "MODEL_PROVIDER_RATE_LIMITED"
  | "MODEL_PROVIDER_REQUEST_FAILED";

function providerErrorMessage(reason: string): string | null {
  try {
    const parsed = JSON.parse(reason) as Record<string, unknown>;
    if (parsed["stopReason"] !== "error") return null;
    return typeof parsed["errorMessage"] === "string" ? parsed["errorMessage"] : reason;
  } catch {
    return /insufficient balance|(?:^|\D)(?:401|402|403|429)(?=\D|$)/iu.test(reason) ? reason : null;
  }
}

export function developmentEvaluationModelFailureCode(reason: unknown): DevelopmentEvaluationModelFailureCode | null {
  if (typeof reason !== "string") return null;
  const errorMessage = providerErrorMessage(reason);
  if (!errorMessage) return null;
  if (/insufficient balance|(?:^|\D)402(?=\D|$)/iu.test(errorMessage)) return "MODEL_PROVIDER_INSUFFICIENT_BALANCE";
  if (/(?:^|\D)(?:401|403)(?=\D|$)|unauthori[sz]ed|forbidden|invalid api key/iu.test(errorMessage)) {
    return "MODEL_PROVIDER_AUTHORIZATION_FAILED";
  }
  if (/(?:^|\D)429(?=\D|$)|rate.?limit/iu.test(errorMessage)) return "MODEL_PROVIDER_RATE_LIMITED";
  return "MODEL_PROVIDER_REQUEST_FAILED";
}
