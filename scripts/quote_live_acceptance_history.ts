import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  appendChecks,
  check,
  localCase,
  type AcceptanceCase,
  type LiveCaseSpec,
} from "./quote_live_acceptance_support.js";

function canonicalLiveId(id: string): string {
  return id === "live-provider-ok-empty" ? "live-obscure-model-empty-probe" : id;
}

function baseChecksPassed(value: AcceptanceCase): boolean {
  const required = new Set([
    "buywhere_tool_is_find_best_price_v2",
    "service_scope_is_adapter_owned_sg",
    "no_explicit_search_mode_parameter",
    "raw_records_preserved_as_observations",
    "eligible_observations_group_exactly_once",
    "provider_status_maps_without_empty_conflation",
    "public_projection_has_no_stock_delivery_or_raw_keys",
    "every_published_lead_has_https_handoff",
    "host_reply_matches_published_outcome",
    "merchant_or_non_absence_disclosure_is_present",
  ]);
  return [...required].every((id) => value.checks.some((item) => item.id === id && item.passed));
}

function qualifies(spec: LiveCaseSpec, value: AcceptanceCase): boolean {
  if (!baseChecksPassed(value)) return false;
  if (spec.id === "live-sony-wh1000xm5-primary") return ["OK_RESULTS", "OK_EMPTY"].includes(value.providerStatus);
  if (spec.id === "live-sony-wh1000xm5-accessory-pollution") {
    const pollution = (value.rejectionReasonCounts["ACCESSORY_RECORD"] ?? 0)
      + (value.rejectionReasonCounts["REPLACEMENT_OR_PART_RECORD"] ?? 0);
    return (value.providerStatus === "OK_EMPTY" && value.rawRecordCount === 0)
      || (value.providerStatus === "OK_RESULTS" && pollution > 0 && value.groupedLeadCount === 0);
  }
  if (spec.id === "live-nintendo-switch2-display-service-pollution") {
    const services = value.rejectionReasonCounts["SERVICE_RECORD"] ?? 0;
    return (["DEGRADED", "FAILED"].includes(value.providerStatus) && value.replyOutcome === "DEGRADED")
      || (value.providerStatus === "OK_EMPTY" && value.groupedLeadCount === 0)
      || (value.providerStatus === "OK_RESULTS" && services > 0 && value.groupedLeadCount === 0);
  }
  if (spec.id === "live-obscure-model-empty-probe") {
    return (value.providerStatus === "OK_EMPTY" && value.replyOutcome === "NO_QUOTE_LEADS")
      || (["DEGRADED", "FAILED"].includes(value.providerStatus) && value.replyOutcome === "DEGRADED");
  }
  return ["OK_RESULTS", "OK_EMPTY"].includes(value.providerStatus)
    && (value.providerStatus === "OK_EMPTY" || value.originalCurrencies.length > 0);
}

export function selectLiveEvidence(spec: LiveCaseSpec, attempts: AcceptanceCase[], referenceTime: string): AcceptanceCase {
  const matching = attempts
    .filter((item) => canonicalLiveId(item.id) === spec.id)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const selected = [...matching].reverse().find((item) => qualifies(spec, item)) ?? matching.at(-1);
  if (!selected) {
    return localCase({
      id: spec.id,
      evidenceKind: "LIVE_BUYWHERE",
      observedAt: referenceTime,
      checks: [check("qualifying_live_observation_exists_within_24_hours", false, "NO_ATTEMPTS")],
    });
  }
  const baseCheckIds = new Set([
    "buywhere_tool_is_find_best_price_v2",
    "service_scope_is_adapter_owned_sg",
    "no_explicit_search_mode_parameter",
    "raw_records_preserved_as_observations",
    "eligible_observations_group_exactly_once",
    "provider_status_maps_without_empty_conflation",
    "public_projection_has_no_stock_delivery_or_raw_keys",
    "every_published_lead_has_https_handoff",
    "host_reply_matches_published_outcome",
    "merchant_or_non_absence_disclosure_is_present",
  ]);
  const rebuilt: AcceptanceCase = {
    ...structuredClone(selected),
    id: spec.id,
    providerMeta: selected.providerMeta ?? null,
    attemptHistory: matching.map((item) => ({
      observedAt: item.observedAt,
      providerStatus: item.providerStatus,
      providerFailureCode: item.providerFailureCode,
      rawRecordCount: item.rawRecordCount,
      replyOutcome: item.replyOutcome,
    })),
    checks: selected.checks.filter((item) => baseCheckIds.has(item.id)),
    passed: false,
  };
  return appendChecks(rebuilt, [
    check("qualifying_live_observation_exists_within_24_hours", qualifies(spec, selected), {
      selectedObservedAt: selected.observedAt,
      selectedProviderStatus: selected.providerStatus,
      attempts: matching.length,
    }),
    check("all_live_attempt_statuses_are_retained", rebuilt.attemptHistory?.length === matching.length, rebuilt.attemptHistory),
  ]);
}

export function deduplicateAttempts(values: AcceptanceCase[]): AcceptanceCase[] {
  const byKey = new Map<string, AcceptanceCase>();
  for (const value of values) {
    const key = `${canonicalLiveId(value.id)}\u0000${value.observedAt}\u0000${value.providerStatus}`;
    byKey.set(key, value);
  }
  return [...byKey.values()];
}

export async function loadHistoricalLiveAttempts(directory: string, referenceTime: string): Promise<AcceptanceCase[]> {
  const cutoff = Date.parse(referenceTime) - 24 * 60 * 60 * 1000;
  const files = (await readdir(directory)).filter((name) => name !== "latest.json" && name.endsWith(".json"));
  const attempts: AcceptanceCase[] = [];
  for (const file of files) {
    try {
      const report = JSON.parse(await readFile(resolve(directory, file), "utf8")) as {
        contractVersion?: string;
        cases?: AcceptanceCase[];
      };
      if (report.contractVersion !== "quote-leads-sg-v1" || !Array.isArray(report.cases)) continue;
      attempts.push(...report.cases.filter((item) => (
        item.evidenceKind === "LIVE_BUYWHERE"
          && Number.isFinite(Date.parse(item.observedAt))
          && Date.parse(item.observedAt) >= cutoff
      )));
    } catch {
      // A malformed old artifact is ignored, never promoted into acceptance evidence.
    }
  }
  return attempts;
}
