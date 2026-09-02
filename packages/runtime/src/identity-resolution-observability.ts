import type { QuoteAdmissionDecision } from "@retail-price/domain";

import { runtimeMetrics } from "./runtime-metrics.js";

export type FrozenLegacyAdmissionStatus = "ELIGIBLE" | "REJECTED" | "INSUFFICIENT_EVIDENCE";

export interface IdentityResolutionComparison {
  observationRef: string;
  activeStatus: QuoteAdmissionDecision["status"];
  activeStrength: QuoteAdmissionDecision["identityStrength"];
  frozenLegacyStatus: FrozenLegacyAdmissionStatus;
  agreement: boolean;
  disagreementCode: "ACTIVE_MORE_PERMISSIVE" | "ACTIVE_MORE_CONSERVATIVE" | "STATUS_CLASS_CHANGED" | null;
}

/** Compares against a frozen replay label; there is deliberately no second production resolver. */
export function compareIdentityResolutionShadow(
  active: QuoteAdmissionDecision,
  frozenLegacyStatus: FrozenLegacyAdmissionStatus,
): IdentityResolutionComparison {
  const agreement = active.status === frozenLegacyStatus;
  return {
    observationRef: active.observationRef,
    activeStatus: active.status,
    activeStrength: active.identityStrength,
    frozenLegacyStatus,
    agreement,
    disagreementCode: agreement ? null
      : active.status === "ELIGIBLE"
        ? "ACTIVE_MORE_PERMISSIVE"
        : frozenLegacyStatus === "ELIGIBLE"
          ? "ACTIVE_MORE_CONSERVATIVE"
          : "STATUS_CLASS_CHANGED",
  };
}

export function recordIdentityResolution(decision: QuoteAdmissionDecision): void {
  runtimeMetrics.identityResolutions.add(1, {
    status: decision.status,
    strength: decision.identityStrength,
    policy_version: decision.policyVersion,
  });
}

export function recordIdentityShadowComparison(comparison: IdentityResolutionComparison): void {
  runtimeMetrics.identityShadowComparisons.add(1, {
    agreement: comparison.agreement,
    active_status: comparison.activeStatus,
    legacy_status: comparison.frozenLegacyStatus,
  });
  if (!comparison.agreement) {
    runtimeMetrics.identityShadowDisagreements.add(1, {
      code: comparison.disagreementCode ?? "UNKNOWN",
      active_strength: comparison.activeStrength,
    });
  }
}
