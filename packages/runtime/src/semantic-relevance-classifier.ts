import type { RetrievedListing, SearchGoalSnapshot, SemanticRelevanceSignal } from "@interec/domain";

import type { PiModelRuntime } from "./model-factory.js";

export interface SemanticRelevancePort {
  classify(
    goal: SearchGoalSnapshot,
    listings: readonly RetrievedListing[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, SemanticRelevanceSignal>>;
}

interface SemanticAssessmentPayload {
  assessments?: unknown;
}

const LABELS = new Set(["EXACT", "SUBSTITUTE", "COMPLEMENT", "IRRELEVANT"]);

export function parseSemanticRelevanceResponse(
  value: string,
  allowedListingRefs: ReadonlySet<string>,
  modelId: string,
): ReadonlyMap<string, SemanticRelevanceSignal> {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("SEMANTIC_RELEVANCE_JSON_REQUIRED");
  const parsed = JSON.parse(value.slice(start, end + 1)) as SemanticAssessmentPayload;
  if (!Array.isArray(parsed.assessments)) throw new Error("SEMANTIC_RELEVANCE_ASSESSMENTS_REQUIRED");
  const result = new Map<string, SemanticRelevanceSignal>();
  for (const raw of parsed.assessments) {
    if (!raw || typeof raw !== "object") throw new Error("SEMANTIC_RELEVANCE_ASSESSMENT_INVALID");
    const item = raw as Record<string, unknown>;
    const listingRef = item["listingRef"];
    const label = item["label"];
    const confidence = item["confidence"];
    if (typeof listingRef !== "string" || !allowedListingRefs.has(listingRef) || result.has(listingRef)) {
      throw new Error("SEMANTIC_RELEVANCE_LISTING_REF_INVALID");
    }
    if (typeof label !== "string" || !LABELS.has(label)) throw new Error("SEMANTIC_RELEVANCE_LABEL_INVALID");
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("SEMANTIC_RELEVANCE_CONFIDENCE_INVALID");
    }
    result.set(listingRef, {
      label: label as SemanticRelevanceSignal["label"],
      confidence,
      modelId,
    });
  }
  if (result.size !== allowedListingRefs.size) {
    throw new Error("SEMANTIC_RELEVANCE_ASSESSMENTS_INCOMPLETE");
  }
  return result;
}

export class PiSemanticRelevanceClassifier implements SemanticRelevancePort {
  public constructor(private readonly pi: PiModelRuntime) {}

  public async classify(
    goal: SearchGoalSnapshot,
    listings: readonly RetrievedListing[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, SemanticRelevanceSignal>> {
    const bounded = listings.slice(0, 24);
    if (bounded.length === 0) return new Map();
    const input = {
      target: goal.target,
      hardConstraints: goal.hardConstraints ?? [],
      listings: bounded.map((listing) => ({
        listingRef: listing.listingRef,
        title: listing.title.value,
        categoryPath: listing.categoryPath.value,
        providerProductType: listing.providerProductType.value,
      })),
    };
    const stream = await this.pi.streamFn(this.pi.model, {
      systemPrompt: `Classify query-product relevance for shopping retrieval. Return JSON only as {"assessments":[{"listingRef":"...","label":"EXACT|SUBSTITUTE|COMPLEMENT|IRRELEVANT","confidence":0.0}]}.
EXACT means the listing is the product the user requested and satisfies every qualifier expressed by target.targetText, target.canonicalModel, target.itemRole, and hardConstraints. The requested product may itself be a primary product, accessory, or replacement part. targetText is the user's canonical product phrase: when it narrows a broad category by form factor, modality, subtype, intended product kind, or item role, that narrowing is binding. SUBSTITUTE means the same broad requested item role and category but a different requested model, form factor, modality, subtype, or other target variant. COMPLEMENT means a related product used with the requested target but not the target itself; never label a requested accessory or requested replacement part COMPLEMENT merely because of its absolute item type. IRRELEVANT means none of these.
Judge the product denoted by the complete title, not isolated overlapping words. A target-category word used as a modifier of another product does not make that other product the target. Copy every listingRef exactly. Do not add prose or fields.`,
      messages: [{ role: "user", content: JSON.stringify(input), timestamp: Date.now() }],
    }, {
      apiKey: this.pi.apiKey,
      temperature: 0,
      maxTokens: 2_000,
      sessionId: `semantic-relevance:${bounded.map((listing) => listing.listingRef).join(":").slice(0, 160)}`,
      ...(signal ? { signal } : {}),
    });
    const message = await stream.result();
    if (message.stopReason !== "stop") throw new Error(`SEMANTIC_RELEVANCE_MODEL_${message.stopReason.toUpperCase()}`);
    const text = message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("\n");
    return parseSemanticRelevanceResponse(text, new Set(bounded.map((listing) => listing.listingRef)), String(this.pi.model.id));
  }
}
