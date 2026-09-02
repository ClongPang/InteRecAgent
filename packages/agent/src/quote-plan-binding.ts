import {
  bindQuoteTargetSource,
  resolveProductIdentity,
  selectProductIdentityCandidateForConfirmation,
  type ProductIdentitySnapshot,
  type QuoteTurnOperation,
  type QuoteTurnPlan,
} from "@retail-price/domain";

import type { IdentityHypothesis } from "./identity-hypothesis.js";

export type ProposedQuoteTurnOperation =
  | (Omit<Extract<QuoteTurnOperation, { kind: "SET_QUOTE_TARGET" }>, "source" | "identityResolution"> & {
      sourceMessageOrdinal: number;
      sourceSpan?: { start: number; end: number };
      identityHypothesis: IdentityHypothesis;
    })
  | Exclude<QuoteTurnOperation, { kind: "SET_QUOTE_TARGET" }>;

export interface QuoteTurnPlanProposal {
  userIntentSummary: string;
  ops: ProposedQuoteTurnOperation[];
}

/** Converts model-facing provenance into a host-authored domain plan and binds registry evidence. */
export function bindQuotePlan(
  proposal: QuoteTurnPlanProposal,
  messageIds: readonly string[],
  messageContents: readonly string[],
  identitySnapshot: ProductIdentitySnapshot | null,
): QuoteTurnPlan {
  return {
    userIntentSummary: proposal.userIntentSummary.normalize("NFKC").trim(),
    ops: proposal.ops.map((operation): QuoteTurnOperation => {
      if (operation.kind !== "SET_QUOTE_TARGET") return structuredClone(operation);
      const { sourceMessageOrdinal, sourceSpan, identityHypothesis: _identityHypothesis, ...rest } = operation;
      const sourceMessage = messageContents[sourceMessageOrdinal] ?? "";
      const rawText = sourceSpan ? sourceMessage.slice(sourceSpan.start, sourceSpan.end) : sourceMessage;
      let identityResolution = identitySnapshot ? resolveProductIdentity(identitySnapshot, {
        rawText,
        proposedModel: operation.target.proposedModel,
        brand: operation.target.brand,
        productType: operation.target.productType,
        requiredQualifiers: operation.target.requiredQualifiers,
      }) : null;
      if (identitySnapshot && identityResolution && operation.identityHypothesis.selectedVariantRef) {
        identityResolution = selectProductIdentityCandidateForConfirmation(
          identitySnapshot,
          identityResolution,
          operation.identityHypothesis.selectedVariantRef,
        );
      }
      return {
        ...structuredClone(rest),
        source: bindQuoteTargetSource({ sourceMessageOrdinal, ...(sourceSpan ? { sourceSpan } : {}) }, messageIds),
        ...(identityResolution ? { identityResolution } : {}),
      } as QuoteTurnOperation;
    }),
  };
}
