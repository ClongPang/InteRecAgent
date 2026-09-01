import {
  projectPublishedQuoteLeadSet,
  QUOTE_LEAD_CONTRACT_VERSION,
  type PublishedQuoteLeadSet,
  type QuoteTarget,
} from "@interec/domain";
import type { QuoteLookupDataPort } from "@interec/agent";

import { ControlledFxClient } from "./controlled-fx-client.js";
import type { ClaimedConversationTurn, ConversationRepository } from "./conversation-repository-types.js";
import { PostgresQuoteLookupRepository } from "./quote-lookup-repository.js";
import { QuoteLookupService } from "./quote-lookup-service.js";
import { buildQuoteProvenance } from "./quote-provenance.js";
import type { FxPort } from "./fx-provider.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";
import type { QuoteProvider } from "./quote-provider.js";
import { withOwnerSnapshotTransaction } from "./postgres-conversation-storage.js";

export class QuoteTurnDataService implements QuoteLookupDataPort {
  private providerCalls = 0;
  private readonly lookupRepository: PostgresQuoteLookupRepository;

  public constructor(
    private readonly claimed: ClaimedConversationTurn,
    private readonly repository: ConversationRepository,
    private readonly callController: PostgresProviderCallController,
    private readonly quoteProvider: QuoteProvider,
    private readonly fxSource: FxPort,
  ) {
    this.lookupRepository = new PostgresQuoteLookupRepository(callController.pool);
  }

  public async lookup(target: QuoteTarget, operationId: string, signal?: AbortSignal): Promise<PublishedQuoteLeadSet> {
    if (this.claimed.contractVersion !== QUOTE_LEAD_CONTRACT_VERSION) throw new Error("QUOTE_DATA_CONTRACT_MISMATCH");
    this.providerCalls += 1;
    if (this.providerCalls > 1) throw new Error("QUOTE_PROVIDER_CALL_BUDGET_EXCEEDED");
    const operation = operationId.normalize("NFKC").trim();
    if (!operation) throw new Error("QUOTE_OPERATION_ID_REQUIRED");

    const existing = await this.findAttemptLeadSet(target.targetRef);
    if (existing) return projectPublishedQuoteLeadSet(existing);

    const stepKey = `quote:${operation}:buywhere`;
    let permitId: string | null = null;
    let providerSucceeded = false;
    let providerErrorCode = "QUOTE_PROVIDER_FAILED";
    try {
      permitId = await this.callController.acquire({
        tenantId: this.claimed.owner.tenantId,
        turnId: this.claimed.id,
        attempt: this.claimed.attempt,
        fenceToken: this.claimed.fenceToken,
        stepKey,
        provider: "buywhere-quote-v2",
        isRetry: false,
      });
      const controlledFx = new ControlledFxClient(
        this.fxSource,
        this.repository,
        this.callController,
        {
          tenantId: this.claimed.owner.tenantId,
          turnId: this.claimed.id,
          attempt: this.claimed.attempt,
          fenceToken: this.claimed.fenceToken,
          operationId: operation,
        },
      );
      const execution = await new QuoteLookupService(this.quoteProvider, controlledFx).lookup({
        status: "RESOLVED",
        target,
        reasonCodes: [],
        normalizationChanges: [],
      }, signal);
      if (execution.status !== "LOOKUP_COMPLETED") throw new Error("QUOTE_TARGET_UNEXPECTEDLY_UNRESOLVED");
      providerSucceeded = execution.leadSet.provider.status === "OK_RESULTS" || execution.leadSet.provider.status === "OK_EMPTY";
      providerErrorCode = execution.leadSet.provider.failureCode ?? (providerSucceeded ? "NONE" : "QUOTE_PROVIDER_DEGRADED");
      await this.lookupRepository.saveQuoteLookup(this.claimed, execution, buildQuoteProvenance(execution.leadSet));
      return projectPublishedQuoteLeadSet(execution.leadSet);
    } finally {
      if (permitId) {
        await this.callController.release(permitId, providerSucceeded
          ? { success: true }
          : { success: false, errorCode: providerErrorCode });
      }
    }
  }

  private async findAttemptLeadSet(targetRef: string): Promise<Parameters<typeof projectPublishedQuoteLeadSet>[0] | null> {
    const ref = await withOwnerSnapshotTransaction(this.lookupRepository.pool, this.claimed.owner, async (client) => {
      const result = await client.query<{ quote_lead_set_ref: string }>(
        `SELECT quote_lead_set_ref
         FROM interec_agent.quote_lead_sets
         WHERE conversation_id = $1 AND turn_id = $2 AND attempt = $3 AND target_ref = $4
         ORDER BY observed_at DESC LIMIT 1`,
        [this.claimed.conversationId, this.claimed.id, this.claimed.attempt, targetRef],
      );
      return result.rows[0]?.quote_lead_set_ref ?? null;
    });
    return ref
      ? this.lookupRepository.loadQuoteLeadSet(this.claimed.owner, this.claimed.conversationId, ref)
      : null;
  }
}
