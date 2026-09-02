import { readFile } from "node:fs/promises";

import {
  emptyQuoteConversationState,
  projectPublishedQuoteLeadSet,
  resolveQuoteTarget,
  type QuoteProviderSummary,
  type ResolveQuoteTargetInput,
} from "../packages/domain/src/index.js";
import { createLexicallyGroundedIdentityHypothesis, QuoteConversationTurnExecutor } from "../packages/agent/src/index.js";
import {
  parseBuyWhereMcpToolResponse,
  QuoteLookupService,
  type QuoteProvider,
  type QuoteProviderResult,
} from "../packages/runtime/src/index.js";
import { countValues, summarizeAdmissionIdentity } from "./quote_live_acceptance_identity.js";

export interface AcceptanceCheck {
  id: string;
  passed: boolean;
  evidence: unknown;
}

export interface ProviderInvocationAudit {
  toolName: string | null;
  deliverTo: string | null;
  argumentKeys: string[];
  modeArgumentKeys: string[];
}

export interface AcceptanceCase {
  id: string;
  evidenceKind: "LIVE_BUYWHERE" | "SANITIZED_LIVE_REPLAY" | "LOCAL_PRE_PROVIDER" | "CONTROLLED_FAILURE" | "CONTROLLED_ADMISSION" | "CONTROLLED_OVERLAY_ON_LIVE_REPLAY";
  query: string | null;
  queryFingerprint: string | null;
  observedAt: string;
  providerStatus: QuoteProviderSummary["status"] | "NOT_CALLED" | "CONTROL_REJECTED";
  providerFailureCode: string | null;
  providerRetryable: boolean | null;
  providerMeta: {
    status: string | null;
    emptinessReason: string | null;
    confidence: string | null;
    engineStatus: string | null;
  } | null;
  rawRecordCount: number;
  admissionCounts: Record<string, number>;
  identityStrengthCounts: Record<string, number>;
  rejectionReasonCounts: Record<string, number>;
  groupedLeadCount: number;
  multiObservationLeadCount: number;
  originalCurrencies: string[];
  priceRanges: Array<{
    currency: string;
    minAmount: string;
    maxAmount: string;
    cnyEstimatePresent: boolean;
  }>;
  conditions: string[];
  merchantDomains: string[];
  httpsMerchantHandoffCount: number;
  availabilityEvidenceRecordCount: number;
  publicForbiddenKeyCount: number;
  replyOutcome: string | null;
  replyDisclosureCodes: string[];
  invocation: ProviderInvocationAudit | null;
  attemptHistory?: Array<{
    observedAt: string;
    providerStatus: string;
    providerFailureCode: string | null;
    rawRecordCount: number;
    replyOutcome: string | null;
  }>;
  checks: AcceptanceCheck[];
  passed: boolean;
}

export interface LiveCaseSpec {
  id: string;
  providerQuery: string;
  target: ResolveQuoteTargetInput;
}

interface ReplayFixture {
  fixtureVersion: number;
  captureKind: string;
  canonicalQuery: string;
  serviceMarket: string;
  providerStatus: string;
  providerContractVersion: string;
  sourceArtifactRef: string;
  sourceObservedAt: string;
  sanitization: string;
  records: Record<string, unknown>[];
}

const PUBLIC_FORBIDDEN_KEYS = new Set([
  "admissions",
  "availability",
  "delivery",
  "provideravailability",
  "rawpayload",
  "rawrecord",
  "rawrecords",
  "stock",
]);

export function check(id: string, passed: boolean, evidence: unknown): AcceptanceCheck {
  return { id, passed, evidence };
}

export function appendChecks(result: AcceptanceCase, additions: AcceptanceCheck[]): AcceptanceCase {
  result.checks.push(...additions);
  result.passed = result.checks.every((item) => item.passed);
  return result;
}

function countForbiddenKeys(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countForbiddenKeys(item), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value as Record<string, unknown>).reduce((total, [key, child]) => (
    total + (PUBLIC_FORBIDDEN_KEYS.has(key.toLocaleLowerCase("en-US")) ? 1 : 0) + countForbiddenKeys(child)
  ), 0);
}

function expectedOutcome(provider: QuoteProviderResult, leadCount: number): "QUOTE_LEADS" | "NO_QUOTE_LEADS" | "DEGRADED" {
  if (provider.status === "DEGRADED" || provider.status === "FAILED") return "DEGRADED";
  if (provider.status === "OK_EMPTY" || leadCount === 0) return "NO_QUOTE_LEADS";
  return "QUOTE_LEADS";
}

async function renderPublicReply(targetInput: ResolveQuoteTargetInput, leadSet: Parameters<typeof projectPublishedQuoteLeadSet>[0]) {
  const target = {
    proposedModel: targetInput.proposedModel,
    brand: targetInput.brand ?? null,
    productType: targetInput.productType ?? null,
    requiredQualifiers: [...(targetInput.requiredQualifiers ?? [])],
    conditionPreference: targetInput.conditionPreference ?? "ANY" as const,
  };
  const executor = new QuoteConversationTurnExecutor({
    turnId: `acceptance-${leadSet.quoteLeadSetRef}`,
    inputMessageIds: ["acceptance-message"],
    inputMessageContents: [targetInput.rawText],
    baseState: emptyQuoteConversationState(),
    publicationRevision: 1,
    quoteEffects: { execute: async () => ({ status: "SUCCEEDED", leadSet: projectPublishedQuoteLeadSet(leadSet), providerInvocation: "LIVE" }) },
  });
  return executor.execute({
    userIntentSummary: "acceptance exact-model quote lookup",
    ops: [
      {
        opId: "target",
        kind: "SET_QUOTE_TARGET",
        sourceMessageOrdinal: 0,
        target,
        identityHypothesis: createLexicallyGroundedIdentityHypothesis(targetInput.rawText, 0, target),
      },
      { opId: "lookup", kind: "LOOKUP_QUOTES" },
    ],
  });
}

export async function evaluateProviderResult(input: {
  spec: LiveCaseSpec;
  providerResult: QuoteProviderResult;
  evidenceKind: AcceptanceCase["evidenceKind"];
  queryFingerprint: string;
  invocation: ProviderInvocationAudit | null;
}): Promise<AcceptanceCase> {
  const resolution = resolveQuoteTarget(input.spec.target);
  if (resolution.status !== "RESOLVED") throw new Error(`LIVE_ACCEPTANCE_TARGET_UNRESOLVED:${input.spec.id}:${resolution.reasonCodes.join(",")}`);
  const provider: QuoteProvider = { lookup: async () => input.providerResult };
  const execution = await new QuoteLookupService(provider).lookup(resolution);
  if (execution.status !== "LOOKUP_COMPLETED") throw new Error(`LIVE_ACCEPTANCE_LOOKUP_INCOMPLETE:${input.spec.id}`);
  const leadSet = execution.leadSet;
  const rendered = await renderPublicReply(input.spec.target, leadSet);
  const publicProjection = projectPublishedQuoteLeadSet(leadSet);
  const publicForbiddenKeyCount = countForbiddenKeys({ leadSet: publicProjection, reply: rendered.reply });
  const admissionCounts = countValues(leadSet.admissions.map((decision) => decision.status));
  const admissionIdentity = summarizeAdmissionIdentity(leadSet.admissions);
  const rejectionReasonCounts = countValues(leadSet.admissions.flatMap((decision) => decision.reasonCodes));
  const priceRanges = leadSet.leads.flatMap((lead) => lead.priceRanges.map((range) => ({
    currency: range.currency,
    minAmount: range.minAmount,
    maxAmount: range.maxAmount,
    cnyEstimatePresent: range.cnyEstimate !== null,
  })));
  const originalCurrencies = [...new Set(priceRanges.map((range) => range.currency))].sort();
  const conditions = [...new Set(leadSet.leads.map((lead) => lead.condition))].sort();
  const merchantDomains = [...new Set(leadSet.leads.map((lead) => lead.merchantDomain))].sort().slice(0, 20);
  const httpsMerchantHandoffCount = leadSet.leads.filter((lead) => lead.outboundUrl.startsWith("https://")).length;
  const availabilityEvidenceRecordCount = leadSet.observations.filter((observation) => observation.providerAvailability !== null).length;
  const eligibleCount = admissionCounts["ELIGIBLE"] ?? 0;
  const groupedObservationCount = leadSet.leads.reduce((total, lead) => total + lead.observationCount, 0);
  const expected = expectedOutcome(input.providerResult, leadSet.leads.length);
  const invocationChecks = input.invocation ? [
    check("buywhere_tool_is_find_best_price_v2", input.invocation.toolName === "find_best_price_v2", input.invocation.toolName),
    check("service_scope_is_adapter_owned_sg", input.invocation.deliverTo === "SG", input.invocation.deliverTo),
    check(
      "no_explicit_search_mode_parameter",
      input.invocation.modeArgumentKeys.length === 0
        && JSON.stringify(input.invocation.argumentKeys) === JSON.stringify(["deliver_to", "product_name"]),
      input.invocation.argumentKeys,
    ),
  ] : [];
  const checks = [
    ...invocationChecks,
    check("raw_records_preserved_as_observations", leadSet.observations.length === input.providerResult.records.length, {
      records: input.providerResult.records.length,
      observations: leadSet.observations.length,
    }),
    check("eligible_observations_group_exactly_once", groupedObservationCount === eligibleCount, {
      eligibleCount,
      groupedObservationCount,
    }),
    check(
      "only_deterministic_identity_strengths_are_publishable",
      admissionIdentity.onlyDeterministicPublished,
      admissionIdentity.counts,
    ),
    check("provider_status_maps_without_empty_conflation", leadSet.outcome === expected, {
      providerStatus: input.providerResult.status,
      outcome: leadSet.outcome,
    }),
    check("public_projection_has_no_stock_delivery_or_raw_keys", publicForbiddenKeyCount === 0, publicForbiddenKeyCount),
    check("every_published_lead_has_https_handoff", httpsMerchantHandoffCount === leadSet.leads.length, {
      httpsMerchantHandoffCount,
      leadCount: leadSet.leads.length,
    }),
    check("host_reply_matches_published_outcome", rendered.reply.outcome === leadSet.outcome, rendered.reply.outcome),
    check(
      "merchant_or_non_absence_disclosure_is_present",
      leadSet.outcome === "QUOTE_LEADS"
        ? rendered.reply.disclosureCodes.includes("MERCHANT_PAGE_CHECK_REQUIRED")
          && rendered.reply.disclosureCodes.includes("AFFILIATE_LINK_DISCLOSURE")
        : rendered.reply.disclosureCodes.includes("PROVIDER_RESULT_NOT_MARKET_ABSENCE"),
      rendered.reply.disclosureCodes,
    ),
  ];
  return {
    id: input.spec.id,
    evidenceKind: input.evidenceKind,
    query: input.spec.providerQuery,
    queryFingerprint: input.queryFingerprint,
    observedAt: input.providerResult.observedAt,
    providerStatus: input.providerResult.status,
    providerFailureCode: input.providerResult.failure?.code ?? null,
    providerRetryable: input.providerResult.failure?.retryable ?? null,
    providerMeta: {
      status: input.providerResult.meta.status,
      emptinessReason: input.providerResult.meta.emptinessReason,
      confidence: input.providerResult.meta.confidence,
      engineStatus: input.providerResult.meta.engineStatus,
    },
    rawRecordCount: leadSet.observations.length,
    admissionCounts,
    identityStrengthCounts: admissionIdentity.counts,
    rejectionReasonCounts,
    groupedLeadCount: leadSet.leads.length,
    multiObservationLeadCount: leadSet.leads.filter((lead) => lead.observationCount > 1).length,
    originalCurrencies,
    priceRanges,
    conditions,
    merchantDomains,
    httpsMerchantHandoffCount,
    availabilityEvidenceRecordCount,
    publicForbiddenKeyCount,
    replyOutcome: rendered.reply.outcome,
    replyDisclosureCodes: rendered.reply.disclosureCodes,
    invocation: input.invocation,
    checks,
    passed: checks.every((item) => item.passed),
  };
}

export async function loadReplayProviderResult(path: URL): Promise<{ fixture: ReplayFixture; providerResult: QuoteProviderResult }> {
  const fixture = JSON.parse(await readFile(path, "utf8")) as ReplayFixture;
  const payload = {
    best_price: fixture.records[0],
    alternatives: fixture.records.slice(1),
    meta: { status: "ok" },
  };
  const providerResult = parseBuyWhereMcpToolResponse({
    jsonrpc: "2.0",
    id: "acceptance-replay",
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  }, fixture.sourceObservedAt);
  return { fixture, providerResult };
}

export async function runSonyReplayCase(path: URL): Promise<{ result: AcceptanceCase; providerResult: QuoteProviderResult }> {
  const { fixture, providerResult } = await loadReplayProviderResult(path);
  const result = await evaluateProviderResult({
    spec: {
      id: "sony-wh1000xm5-live-replay-grouping",
      providerQuery: fixture.canonicalQuery,
      target: {
        rawText: "Sony WH-1000XM5 refurbished headphones quote",
        proposedModel: "WH-1000XM5",
        brand: "Sony",
        productType: "headphones",
        conditionPreference: "REFURBISHED",
      },
    },
    providerResult,
    evidenceKind: "SANITIZED_LIVE_REPLAY",
    queryFingerprint: fixture.sourceArtifactRef,
    invocation: {
      toolName: "find_best_price_v2",
      deliverTo: fixture.serviceMarket,
      argumentKeys: ["deliver_to", "product_name"],
      modeArgumentKeys: [],
    },
  });
  appendChecks(result, [
    check("capture_is_sanitized_live_buywhere_v2", fixture.captureKind === "SANITIZED_LIVE_BUYWHERE_MCP_V2", fixture.captureKind),
    check("nine_records_group_to_one_merchant_page", result.rawRecordCount === 9 && result.groupedLeadCount === 1 && result.multiObservationLeadCount === 1, {
      records: result.rawRecordCount,
      leads: result.groupedLeadCount,
    }),
    check("refurbished_condition_is_preserved", JSON.stringify(result.conditions) === JSON.stringify(["REFURBISHED"]), result.conditions),
    check(
      "usd_range_is_preserved_as_original_currency",
      result.priceRanges.some((range) => range.currency === "USD" && range.minAmount === "215" && range.maxAmount === "249.99"),
      result.priceRanges,
    ),
  ]);
  return { result, providerResult };
}

export function controlledProviderResult(input: {
  status: "DEGRADED" | "FAILED";
  code: string;
  retryable: boolean;
  observedAt: string;
}): QuoteProviderResult {
  return {
    status: input.status,
    records: [],
    meta: { status: input.status.toLocaleLowerCase("en-US"), emptinessReason: null, confidence: null, engineStatus: null, raw: {} },
    failure: { code: input.code, retryable: input.retryable },
    rawPayload: { controlledFailure: input.code },
    artifactRef: null,
    observedAt: input.observedAt,
    providerContractVersion: "buywhere-mcp-v2-quote-records-v1",
  };
}

export function controlledRecordsProviderResult(records: Record<string, unknown>[], observedAt: string): QuoteProviderResult {
  return {
    status: "OK_RESULTS",
    records: structuredClone(records),
    meta: { status: "ok", emptinessReason: null, confidence: "controlled", engineStatus: null, raw: {} },
    failure: null,
    rawPayload: { controlledRecordCount: records.length },
    artifactRef: null,
    observedAt,
    providerContractVersion: "buywhere-mcp-v2-quote-records-v1",
  };
}

export function localCase(input: {
  id: string;
  evidenceKind: AcceptanceCase["evidenceKind"];
  observedAt: string;
  checks: AcceptanceCheck[];
}): AcceptanceCase {
  return {
    id: input.id,
    evidenceKind: input.evidenceKind,
    query: null,
    queryFingerprint: null,
    observedAt: input.observedAt,
    providerStatus: "NOT_CALLED",
    providerFailureCode: null,
    providerRetryable: null,
    providerMeta: null,
    rawRecordCount: 0,
    admissionCounts: {},
    identityStrengthCounts: {},
    rejectionReasonCounts: {},
    groupedLeadCount: 0,
    multiObservationLeadCount: 0,
    originalCurrencies: [],
    priceRanges: [],
    conditions: [],
    merchantDomains: [],
    httpsMerchantHandoffCount: 0,
    availabilityEvidenceRecordCount: 0,
    publicForbiddenKeyCount: 0,
    replyOutcome: null,
    replyDisclosureCodes: [],
    invocation: null,
    checks: input.checks,
    passed: input.checks.every((item) => item.passed),
  };
}
