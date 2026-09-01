import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BuyWhereMcpQuoteClient,
  resolveBuyWhereRuntimeConfig,
} from "../packages/runtime/src/index.js";
import {
  appendChecks,
  check,
  evaluateProviderResult,
  localCase,
  runSonyReplayCase,
  type AcceptanceCase,
  type LiveCaseSpec,
  type ProviderInvocationAudit,
} from "./quote_live_acceptance_support.js";
import { runControlledAcceptanceCases } from "./quote_live_acceptance_controlled.js";
import {
  deduplicateAttempts,
  loadHistoricalLiveAttempts,
  selectLiveEvidence,
} from "./quote_live_acceptance_history.js";

const AUTHORIZATION = "authorized-buywhere-multi-case-read";
if (process.env["INTEREC_QUOTE_LIVE_ACCEPTANCE_CONFIRM"] !== AUTHORIZATION) {
  throw new Error(`INTEREC_QUOTE_LIVE_ACCEPTANCE_CONFIRM_MUST_BE_${AUTHORIZATION}`);
}

const startedAt = new Date().toISOString();
const config = resolveBuyWhereRuntimeConfig();
const delayText = process.env["INTEREC_QUOTE_LIVE_ACCEPTANCE_DELAY_MS"]?.trim() ?? "3000";
if (!/^\d+$/u.test(delayText) || Number(delayText) > 10_000) throw new Error("INTEREC_QUOTE_LIVE_ACCEPTANCE_DELAY_MS_INVALID");
const interRequestDelayMs = Number(delayText);
const invocationAudits: ProviderInvocationAudit[] = [];

const auditedFetch: typeof fetch = async (input, init) => {
  let audit: ProviderInvocationAudit = { toolName: null, deliverTo: null, argumentKeys: [], modeArgumentKeys: [] };
  if (typeof init?.body === "string") {
    try {
      const envelope = JSON.parse(init.body) as Record<string, unknown>;
      const params = envelope["params"] && typeof envelope["params"] === "object"
        ? envelope["params"] as Record<string, unknown>
        : {};
      const args = params["arguments"] && typeof params["arguments"] === "object"
        ? params["arguments"] as Record<string, unknown>
        : {};
      const argumentKeys = Object.keys(args).sort();
      audit = {
        toolName: typeof params["name"] === "string" ? params["name"] : null,
        deliverTo: typeof args["deliver_to"] === "string" ? args["deliver_to"] : null,
        argumentKeys,
        modeArgumentKeys: argumentKeys.filter((key) => /(?:mode|fuzzy|semantic|hybrid|sort|search_type)/iu.test(key)),
      };
    } catch {
      audit = { toolName: null, deliverTo: null, argumentKeys: [], modeArgumentKeys: ["UNPARSEABLE_REQUEST"] };
    }
  }
  invocationAudits.push(audit);
  return fetch(input, init);
};

const client = new BuyWhereMcpQuoteClient(config.apiKey, {
  fetchImpl: auditedFetch,
  timeoutMs: config.timeoutMs,
});

function fingerprint(query: string): string {
  return `sha256:${createHash("sha256").update(query).digest("hex")}`;
}

const liveSpecs: LiveCaseSpec[] = [
  {
    id: "live-sony-wh1000xm5-primary",
    providerQuery: "Sony WH-1000XM5 headphones",
    target: {
      rawText: "Sony WH-1000XM5 headphones quote",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
      productType: "headphones",
      conditionPreference: "ANY",
    },
  },
  {
    id: "live-sony-wh1000xm5-accessory-pollution",
    providerQuery: "Sony WH-1000XM5 replacement ear pads",
    target: {
      rawText: "Sony WH-1000XM5 headphones quote",
      proposedModel: "WH-1000XM5",
      brand: "Sony",
      productType: "headphones",
      conditionPreference: "ANY",
    },
  },
  {
    id: "live-nintendo-switch2-display-service-pollution",
    providerQuery: "Nintendo Switch 2 display service",
    target: {
      rawText: "Nintendo Switch 2 console quote",
      proposedModel: "Switch 2",
      brand: "Nintendo",
      productType: "console",
      conditionPreference: "ANY",
    },
  },
  {
    id: "live-obscure-model-empty-probe",
    providerQuery: "Obscura ZXQ-99001 console",
    target: {
      rawText: "Obscura ZXQ-99001 console quote",
      proposedModel: "ZXQ-99001",
      brand: "Obscura",
      productType: "console",
      conditionPreference: "ANY",
    },
  },
  {
    id: "live-dyson-tp09-currency",
    providerQuery: "Dyson TP09 air purifier",
    target: {
      rawText: "Dyson TP09 air purifier quote",
      proposedModel: "TP09",
      brand: "Dyson",
      productType: "air purifier",
      conditionPreference: "ANY",
    },
  },
];

async function runLiveCase(spec: LiveCaseSpec): Promise<AcceptanceCase> {
  const invocationIndex = invocationAudits.length;
  const providerResult = await client.lookup({ canonicalQuery: spec.providerQuery });
  const invocation = invocationAudits[invocationIndex] ?? null;
  const result = await evaluateProviderResult({
    spec,
    providerResult,
    evidenceKind: "LIVE_BUYWHERE",
    queryFingerprint: fingerprint(spec.providerQuery),
    invocation,
  });
  if (spec.id === "live-sony-wh1000xm5-primary") {
    return appendChecks(result, [
      check("current_sony_observation_is_non_degraded", ["OK_RESULTS", "OK_EMPTY"].includes(result.providerStatus), result.providerStatus),
    ]);
  }
  if (spec.id === "live-sony-wh1000xm5-accessory-pollution") {
    const pollution = (result.rejectionReasonCounts["ACCESSORY_RECORD"] ?? 0)
      + (result.rejectionReasonCounts["REPLACEMENT_OR_PART_RECORD"] ?? 0);
    const providerFilteredAccessories = result.providerStatus === "OK_EMPTY" && result.rawRecordCount === 0;
    const localAdmissionRejectedPollution = result.providerStatus === "OK_RESULTS"
      && pollution > 0
      && (result.admissionCounts["ELIGIBLE"] ?? 0) === 0;
    return appendChecks(result, [
      check("live_accessory_query_was_explicitly_filtered_or_locally_rejected", providerFilteredAccessories || localAdmissionRejectedPollution, {
        providerStatus: result.providerStatus,
        emptinessReason: result.providerMeta?.emptinessReason ?? null,
        pollution,
      }),
      check("no_accessory_pollution_entered_a_quote_lead", result.groupedLeadCount === 0, result.groupedLeadCount),
    ]);
  }
  if (spec.id === "live-nintendo-switch2-display-service-pollution") {
    const services = result.rejectionReasonCounts["SERVICE_RECORD"] ?? 0;
    const providerDegraded = ["DEGRADED", "FAILED"].includes(result.providerStatus) && result.replyOutcome === "DEGRADED";
    const providerFilteredServices = result.providerStatus === "OK_EMPTY"
      && /service/iu.test(result.providerMeta?.emptinessReason ?? "");
    const localAdmissionRejectedServices = result.providerStatus === "OK_RESULTS"
      && services > 0
      && (result.admissionCounts["ELIGIBLE"] ?? 0) === 0;
    return appendChecks(result, [
      check("live_service_query_is_non_fabricated_or_correctly_degraded", providerDegraded || providerFilteredServices || localAdmissionRejectedServices, {
        providerStatus: result.providerStatus,
        failureCode: result.providerFailureCode,
        emptinessReason: result.providerMeta?.emptinessReason ?? null,
        services,
      }),
      check("live_service_query_never_publishes_a_service_lead", result.groupedLeadCount === 0, result.groupedLeadCount),
    ]);
  }
  if (spec.id === "live-obscure-model-empty-probe") {
    return appendChecks(result, [
      check("obscure_query_is_honestly_empty_or_degraded", (
        result.providerStatus === "OK_EMPTY" && result.replyOutcome === "NO_QUOTE_LEADS"
      ) || (["DEGRADED", "FAILED"].includes(result.providerStatus) && result.replyOutcome === "DEGRADED"), {
        providerStatus: result.providerStatus,
        replyOutcome: result.replyOutcome,
      }),
    ]);
  }
  return appendChecks(result, [
    check("dyson_observation_is_non_degraded", ["OK_RESULTS", "OK_EMPTY"].includes(result.providerStatus), result.providerStatus),
    check(
      "dyson_results_preserve_original_currency",
      result.providerStatus === "OK_EMPTY" || result.originalCurrencies.length > 0,
      result.originalCurrencies,
    ),
  ]);
}

const artifactDirectory = resolve("artifacts/quote-lead-live-acceptance");
await mkdir(artifactDirectory, { recursive: true });
const historicalLiveAttempts = await loadHistoricalLiveAttempts(artifactDirectory, startedAt);
const cases: AcceptanceCase[] = [];
const replayPath = new URL("../packages/runtime/test/fixtures/buywhere-wh1000xm5-2026-09-01.json", import.meta.url);
const replay = await runSonyReplayCase(replayPath);
cases.push(replay.result);

const currentLiveAttempts: AcceptanceCase[] = [];
for (const [index, spec] of liveSpecs.entries()) {
  if (index > 0 && interRequestDelayMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, interRequestDelayMs));
  }
  try {
    currentLiveAttempts.push(await runLiveCase(spec));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : "LIVE_CASE_UNEXPECTED_FAILURE";
    currentLiveAttempts.push(localCase({
      id: spec.id,
      evidenceKind: "LIVE_BUYWHERE",
      observedAt: new Date().toISOString(),
      checks: [check("live_case_completed_through_production_parser", false, message)],
    }));
  }
}

const allLiveAttempts = deduplicateAttempts([...historicalLiveAttempts, ...currentLiveAttempts]);
const selectedLiveCases = liveSpecs.map((spec) => selectLiveEvidence(spec, allLiveAttempts, startedAt));
cases.push(...selectedLiveCases);
cases.push(...await runControlledAcceptanceCases(replay.providerResult));

const liveCases = cases.filter((item) => item.evidenceKind === "LIVE_BUYWHERE");
const providerStatus = countStatuses(liveCases);
const providerAttemptStatus = countStatuses(allLiveAttempts);
const invocationShapes = [...new Set(invocationAudits.map((audit) => JSON.stringify(audit.argumentKeys)))].map((shape) => JSON.parse(shape) as string[]);
const modeParametersObserved = [...new Set(invocationAudits.flatMap((audit) => audit.modeArgumentKeys))].sort();
const allChecksPassed = cases.every((item) => item.passed);
const overallChecks = [
  check("five_distinct_live_buywhere_calls_were_attempted", currentLiveAttempts.length === liveSpecs.length && invocationAudits.length === liveSpecs.length, {
    cases: currentLiveAttempts.length,
    invocations: invocationAudits.length,
  }),
  check("every_live_request_used_one_fixed_tool_and_scope", invocationAudits.every((audit) => (
    audit.toolName === "find_best_price_v2"
      && audit.deliverTo === "SG"
      && JSON.stringify(audit.argumentKeys) === JSON.stringify(["deliver_to", "product_name"])
  )), invocationAudits),
  check("no_explicit_fuzzy_keyword_semantic_hybrid_or_sort_mode_was_sent", modeParametersObserved.length === 0, modeParametersObserved),
  check("required_live_and_controlled_cases_passed", allChecksPassed, cases.filter((item) => !item.passed).map((item) => item.id)),
  check("a_live_ok_results_observation_was_recorded", liveCases.some((item) => item.providerStatus === "OK_RESULTS"), providerStatus),
  check("a_live_ok_empty_observation_was_recorded", liveCases.some((item) => item.providerStatus === "OK_EMPTY" && item.replyOutcome === "NO_QUOTE_LEADS"), providerStatus),
  check("a_live_degraded_or_failed_observation_was_not_conflated_with_empty", allLiveAttempts.some((item) => (
    ["DEGRADED", "FAILED"].includes(item.providerStatus) && item.replyOutcome === "DEGRADED"
  )), providerAttemptStatus),
  check("a_real_non_sgd_original_currency_was_preserved", cases.some((item) => (
    ["LIVE_BUYWHERE", "SANITIZED_LIVE_REPLAY"].includes(item.evidenceKind)
      && item.originalCurrencies.some((currency) => currency !== "SGD")
  )), cases.flatMap((item) => item.originalCurrencies)),
];
const overallDecision = overallChecks.every((item) => item.passed) ? "PASS" : "FAIL";
const completedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  contractVersion: "quote-leads-sg-v1",
  runKind: "REAL_BUYWHERE_MULTI_CASE_WITH_EXPLICIT_CONTROLLED_BOUNDARIES",
  observedAt: startedAt,
  completedAt,
  serviceMarket: "SG",
  providerTool: "find_best_price_v2",
  interRequestDelayMs,
  providerStatus,
  providerAttemptStatus,
  evidenceAggregation: {
    windowHours: 24,
    historicalAttemptCount: historicalLiveAttempts.length,
    currentAttemptCount: currentLiveAttempts.length,
    failedAttemptsRetainedInEachLogicalCase: true,
    auditUseOnly: "Historical observations are acceptance evidence and are never republished as a current user quote.",
  },
  searchModeFinding: {
    requestArgumentShapesObserved: invocationShapes,
    explicitModeParametersObserved: modeParametersObserved,
    explicitSearchModeControl: "NOT_EXPOSED_BY_THE_OBSERVED_FIND_BEST_PRICE_V2_REQUEST_CONTRACT",
    fuzzyCorrectionGuarantee: "NOT_CLAIMED_OR_USED",
    automaticFallback: "NONE",
  },
  dataHandling: {
    apiKeyPersisted: false,
    rawProviderPayloadPersisted: false,
    rawMerchantUrlsPersisted: false,
    onlySanitizedAggregatesPersisted: true,
  },
  cases,
  overallChecks,
  overallDecision,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (config.apiKey && serialized.includes(config.apiKey)) throw new Error("LIVE_ACCEPTANCE_REPORT_CONTAINS_API_KEY");
const datedName = completedAt.replace(/[:.]/gu, "-");
await writeFile(resolve(artifactDirectory, `${datedName}.json`), serialized, "utf8");
await writeFile(resolve(artifactDirectory, "latest.json"), serialized, "utf8");

process.stdout.write(`${JSON.stringify({
  overallDecision,
  contractVersion: report.contractVersion,
  serviceMarket: report.serviceMarket,
  providerTool: report.providerTool,
  providerStatus,
  cases: cases.map((item) => ({ id: item.id, status: item.providerStatus, passed: item.passed })),
  artifact: "artifacts/quote-lead-live-acceptance/latest.json",
})}\n`);
if (overallDecision !== "PASS") process.exitCode = 1;

function countStatuses(values: readonly AcceptanceCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value.providerStatus] = (counts[value.providerStatus] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, "en-US")));
}
