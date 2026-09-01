import { createHash } from "node:crypto";

import { emptyQuoteConversationState, resolveQuoteTarget } from "../packages/domain/src/index.js";
import { QuoteConversationTurnExecutor } from "../packages/agent/src/index.js";
import { ProviderCallControlError, type QuoteProviderResult } from "../packages/runtime/src/index.js";
import {
  appendChecks,
  check,
  controlledProviderResult,
  controlledRecordsProviderResult,
  evaluateProviderResult,
  localCase,
  type AcceptanceCase,
  type LiveCaseSpec,
} from "./quote_live_acceptance_support.js";

const sonyTarget: LiveCaseSpec["target"] = {
  rawText: "Sony WH-1000XM5 headphones quote",
  proposedModel: "WH-1000XM5",
  brand: "Sony",
  productType: "headphones",
  conditionPreference: "ANY",
};

const nintendoTarget: LiveCaseSpec["target"] = {
  rawText: "Nintendo Switch 2 console quote",
  proposedModel: "Switch 2",
  brand: "Nintendo",
  productType: "console",
  conditionPreference: "ANY",
};

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function runControlledAcceptanceCases(replayProviderResult: QuoteProviderResult): Promise<AcceptanceCase[]> {
  const now = new Date().toISOString();
  let providerCalls = 0;
  const typoResolution = resolveQuoteTarget({
    rawText: "Soni WH-1000XM55 headphones quote",
    proposedModel: "WH-1000XM5",
    brand: "Sony",
    productType: "headphones",
  });
  if (typoResolution.status === "RESOLVED") providerCalls += 1;
  const typoReasons = typoResolution.status === "NEEDS_CONFIRMATION" ? typoResolution.reasonCodes : [];
  const typo = localCase({
    id: "typo-model-does-not-call-provider",
    evidenceKind: "LOCAL_PRE_PROVIDER",
    observedAt: now,
    checks: [
      check("typo_requires_confirmation", typoResolution.status === "NEEDS_CONFIRMATION", typoResolution.status),
      check("typo_is_not_silently_rewritten", typoReasons.includes("MODEL_NOT_LEXICALLY_GROUNDED"), typoReasons),
      check("typo_provider_call_count_is_zero", providerCalls === 0, providerCalls),
    ],
  });

  const failureTarget: LiveCaseSpec = {
    id: "controlled-timeout-remains-degraded",
    providerQuery: "Sony WH-1000XM5 headphones",
    target: sonyTarget,
  };
  const timeout = await evaluateProviderResult({
    spec: failureTarget,
    providerResult: controlledProviderResult({ status: "FAILED", code: "BUYWHERE_TIMEOUT", retryable: true, observedAt: now }),
    evidenceKind: "CONTROLLED_FAILURE",
    queryFingerprint: fingerprint("controlled:BUYWHERE_TIMEOUT"),
    invocation: null,
  });
  appendChecks(timeout, [
    check("timeout_is_degraded_not_empty", timeout.replyOutcome === "DEGRADED" && timeout.providerFailureCode === "BUYWHERE_TIMEOUT", {
      outcome: timeout.replyOutcome,
      failureCode: timeout.providerFailureCode,
    }),
  ]);

  const degraded = await evaluateProviderResult({
    spec: { ...failureTarget, id: "controlled-engine-degraded-remains-degraded" },
    providerResult: controlledProviderResult({ status: "DEGRADED", code: "BUYWHERE_ENGINE_DEGRADED", retryable: true, observedAt: now }),
    evidenceKind: "CONTROLLED_FAILURE",
    queryFingerprint: fingerprint("controlled:BUYWHERE_ENGINE_DEGRADED"),
    invocation: null,
  });
  appendChecks(degraded, [
    check("engine_degraded_is_not_empty", degraded.replyOutcome === "DEGRADED", degraded.replyOutcome),
  ]);

  const circuitExecutor = new QuoteConversationTurnExecutor({
    turnId: "controlled-circuit-open",
    inputMessageIds: ["m1"],
    inputMessageContents: [failureTarget.target.rawText],
    baseState: emptyQuoteConversationState(),
    publicationRevision: 1,
    quoteData: { lookup: async () => { throw new ProviderCallControlError("PROVIDER_CIRCUIT_OPEN"); } },
  });
  let circuitCode = "NONE";
  try {
    await circuitExecutor.execute({
      userIntentSummary: "controlled circuit rejection",
      ops: [
        {
          opId: "target",
          kind: "SET_QUOTE_TARGET",
          sourceMessageOrdinal: 0,
          target: {
            proposedModel: failureTarget.target.proposedModel,
            brand: failureTarget.target.brand ?? null,
            productType: failureTarget.target.productType ?? null,
            requiredQualifiers: [],
            conditionPreference: "ANY",
          },
        },
        { opId: "lookup", kind: "LOOKUP_QUOTES" },
      ],
    });
  } catch (error) {
    circuitCode = error instanceof ProviderCallControlError ? error.code : "UNEXPECTED_ERROR";
  }
  const circuitFallback = await circuitExecutor.fallback(circuitCode);
  const circuit = localCase({
    id: "controlled-circuit-open-fails-closed",
    evidenceKind: "CONTROLLED_FAILURE",
    observedAt: now,
    checks: [
      check("circuit_open_code_is_preserved", circuitCode === "PROVIDER_CIRCUIT_OPEN", circuitCode),
      check("circuit_open_publishes_deterministic_degraded_reply", circuitFallback.reply.outcome === "DEGRADED", circuitFallback.reply.outcome),
      check("circuit_open_does_not_publish_an_empty_lead_set", circuitFallback.state.leadSet === null, circuitFallback.state.leadSet),
    ],
  });
  circuit.providerStatus = "CONTROL_REJECTED";
  circuit.providerFailureCode = circuitCode;
  circuit.providerRetryable = true;
  circuit.replyOutcome = circuitFallback.reply.outcome;

  const accessoryAdmission = await evaluateProviderResult({
    spec: {
      id: "controlled-accessory-record-is-rejected",
      providerQuery: "Sony WH-1000XM5 headphones",
      target: sonyTarget,
    },
    providerResult: controlledRecordsProviderResult([{
      id: "controlled-accessory",
      title: "Replacement ear pads for Sony WH-1000XM5",
      price: { amount: "29.90", currency: "SGD" },
      merchant: "Controlled Merchant",
      url: "https://merchant.example/sony-wh1000xm5-ear-pads",
      outbound_url: "https://merchant.example/sony-wh1000xm5-ear-pads",
    }], now),
    evidenceKind: "CONTROLLED_ADMISSION",
    queryFingerprint: fingerprint("controlled:sony-accessory-record"),
    invocation: null,
  });
  appendChecks(accessoryAdmission, [
    check("accessory_record_has_explicit_rejection_reason", accessoryAdmission.rejectionReasonCounts["ACCESSORY_RECORD"] === 1, accessoryAdmission.rejectionReasonCounts),
    check("accessory_record_publishes_no_quote_lead", accessoryAdmission.groupedLeadCount === 0 && accessoryAdmission.replyOutcome === "NO_QUOTE_LEADS", {
      groupedLeadCount: accessoryAdmission.groupedLeadCount,
      replyOutcome: accessoryAdmission.replyOutcome,
    }),
  ]);

  const serviceAdmission = await evaluateProviderResult({
    spec: {
      id: "controlled-nintendo-display-service-record-is-rejected",
      providerQuery: "Nintendo Switch 2 console",
      target: nintendoTarget,
    },
    providerResult: controlledRecordsProviderResult([{
      id: "controlled-service",
      title: "Nintendo Switch 2 display repair service",
      price: { amount: "89.00", currency: "SGD" },
      merchant: "Controlled Service Merchant",
      url: "https://merchant.example/nintendo-switch-2-display-service",
      outbound_url: "https://merchant.example/nintendo-switch-2-display-service",
    }], now),
    evidenceKind: "CONTROLLED_ADMISSION",
    queryFingerprint: fingerprint("controlled:nintendo-display-service-record"),
    invocation: null,
  });
  appendChecks(serviceAdmission, [
    check("service_record_has_explicit_rejection_reason", serviceAdmission.rejectionReasonCounts["SERVICE_RECORD"] === 1, serviceAdmission.rejectionReasonCounts),
    check("service_record_publishes_no_quote_lead", serviceAdmission.groupedLeadCount === 0 && serviceAdmission.replyOutcome === "NO_QUOTE_LEADS", {
      groupedLeadCount: serviceAdmission.groupedLeadCount,
      replyOutcome: serviceAdmission.replyOutcome,
    }),
  ]);

  const availabilityProviderResult: QuoteProviderResult = {
    ...replayProviderResult,
    records: replayProviderResult.records.map((record) => ({ ...record, availability: "provider-says-available" })),
    rawPayload: { controlledOverlay: "availability-on-sanitized-live-records" },
    artifactRef: null,
    observedAt: now,
  };
  const availability = await evaluateProviderResult({
    spec: {
      id: "provider-availability-is-evidence-only",
      providerQuery: "Sony WH-1000XM5 headphones",
      target: {
        rawText: "Sony WH-1000XM5 refurbished headphones quote",
        proposedModel: "WH-1000XM5",
        brand: "Sony",
        productType: "headphones",
        conditionPreference: "REFURBISHED",
      },
    },
    providerResult: availabilityProviderResult,
    evidenceKind: "CONTROLLED_OVERLAY_ON_LIVE_REPLAY",
    queryFingerprint: fingerprint("controlled:availability-on-live-replay"),
    invocation: null,
  });
  appendChecks(availability, [
    check("provider_availability_is_retained_only_in_internal_observations", availability.availabilityEvidenceRecordCount === 9, availability.availabilityEvidenceRecordCount),
    check("provider_availability_never_reaches_public_projection", availability.publicForbiddenKeyCount === 0, availability.publicForbiddenKeyCount),
  ]);

  return [typo, timeout, degraded, circuit, accessoryAdmission, serviceAdmission, availability];
}
