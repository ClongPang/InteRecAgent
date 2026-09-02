import { startActiveObservation } from "@langfuse/tracing";

import type { QuoteProviderResult } from "./quote-provider.js";
import { runtimeMetrics } from "./runtime-metrics.js";
import {
  redactTelemetryData,
  telemetryContent,
  telemetryErrorCode,
} from "./telemetry-safety.js";

const PROVIDER = "buywhere";
const PROVIDER_TOOL = "find_best_price_v2";

function resultSummary(result: QuoteProviderResult, requestId: string): Record<string, unknown> {
  return {
    providerStatus: result.status,
    providerFailureCode: result.failure?.code ?? null,
    providerRetryable: result.failure?.retryable ?? null,
    quoteRecordCount: result.records.length,
    providerContractVersion: result.providerContractVersion,
    providerRequestId: requestId,
    cacheHit: false,
  };
}

/** The physical production BuyWhere call. It intentionally excludes admission, FX, and persistence latency. */
export async function observeBuyWhereProviderCall(
  canonicalQuery: string,
  requestId: string,
  operation: () => Promise<QuoteProviderResult>,
): Promise<QuoteProviderResult> {
  const startedAt = performance.now();
  let outcome = "EXCEPTION";
  return startActiveObservation(
    "tool.provider.buywhere.find_best_price_v2",
    async (observation) => {
      observation.update({
        input: telemetryContent({ canonicalQuery, deliverTo: "SG" }),
        metadata: {
          provider: PROVIDER,
          providerTool: PROVIDER_TOOL,
          providerRequestId: requestId,
          cacheHit: false,
        },
      });
      try {
        const result = await operation();
        outcome = result.status;
        const summary = resultSummary(result, requestId);
        observation.update({
          output: redactTelemetryData(summary),
          metadata: {
            provider: PROVIDER,
            providerTool: PROVIDER_TOOL,
            providerRequestId: requestId,
            providerStatus: result.status,
            providerFailureCode: result.failure?.code ?? "NONE",
            cacheHit: false,
          },
          ...(result.failure
            ? { level: "ERROR" as const, statusMessage: result.failure.code }
            : {}),
        });
        if (result.failure) {
          runtimeMetrics.providerErrors.add(1, {
            provider: PROVIDER,
            failure_code: result.failure.code,
          });
        }
        return result;
      } catch (error) {
        const failureCode = telemetryErrorCode(error, "BUYWHERE_CALL_FAILED");
        observation.update({
          level: "ERROR",
          statusMessage: failureCode,
          output: {
            providerStatus: "EXCEPTION",
            providerFailureCode: failureCode,
            providerRequestId: requestId,
            cacheHit: false,
          },
        });
        runtimeMetrics.providerErrors.add(1, { provider: PROVIDER, failure_code: failureCode });
        throw error;
      } finally {
        runtimeMetrics.providerDuration.record((performance.now() - startedAt) / 1000, {
          provider: PROVIDER,
          operation: PROVIDER_TOOL,
          outcome,
        });
      }
    },
    { asType: "tool" },
  );
}
