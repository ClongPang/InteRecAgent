import { Type } from "typebox";

const quoteConditionPreferenceSchema = Type.Union([
  Type.Literal("NEW"),
  Type.Literal("NEW_OR_UNSPECIFIED"),
  Type.Literal("REFURBISHED"),
  Type.Literal("USED"),
  Type.Literal("ANY"),
]);

const quoteLeadReferentSchema = Type.Union([
  Type.Object({ kind: Type.Literal("QUOTE_LEAD_REF"), quoteLeadRef: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("DISPLAY_RANK"), rank: Type.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("FOCUS") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("COMPARISON") }, { additionalProperties: false }),
]);

const quoteOperationBase = { opId: Type.String({ minLength: 1, maxLength: 80 }) };

const identitySourceClaimSchema = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 200 }),
  span: Type.Object({
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const identityHypothesisSchema = Type.Object({
  sourceMessageOrdinal: Type.Integer({ minimum: 0, maximum: 7 }),
  model: identitySourceClaimSchema,
  brand: Type.Union([identitySourceClaimSchema, Type.Null()]),
  productType: Type.Union([identitySourceClaimSchema, Type.Null()]),
  qualifiers: Type.Array(identitySourceClaimSchema, { maxItems: 6 }),
  selectedVariantRef: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
  confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
}, { additionalProperties: false });

/** The only model-facing operation set after the quote-lead cutover. */
export const quoteTurnOperationSchema = Type.Union([
  Type.Object({
    ...quoteOperationBase,
    kind: Type.Literal("SET_QUOTE_TARGET"),
    sourceMessageOrdinal: Type.Integer({ minimum: 0, maximum: 7 }),
    sourceSpan: Type.Optional(Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
    identityHypothesis: identityHypothesisSchema,
    target: Type.Object({
      proposedModel: Type.String({ minLength: 1, maxLength: 200 }),
      brand: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
      productType: Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()]),
      requiredQualifiers: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 6, uniqueItems: true }),
      conditionPreference: quoteConditionPreferenceSchema,
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("REQUEST_QUOTE_MODEL_CONFIRMATION") }, { additionalProperties: false }),
  Type.Object({
    ...quoteOperationBase,
    kind: Type.Literal("DECLINE_UNSUPPORTED_QUOTE_TARGET"),
    reasonCode: Type.Union([Type.Literal("ACCESSORY_OR_PART"), Type.Literal("SERVICE")]),
  }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("CONFIRM_QUOTE_TARGET"), confirmationId: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("LOOKUP_QUOTES") }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("REFRESH_QUOTES") }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("EXCLUDE_QUOTE_LEADS"), referents: Type.Array(quoteLeadReferentSchema, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("RESTORE_QUOTE_LEADS"), referents: Type.Array(quoteLeadReferentSchema, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("SET_QUOTE_COMPARISON"), referents: Type.Array(quoteLeadReferentSchema, { minItems: 2, maxItems: 4 }) }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("SET_QUOTE_FOCUS"), referent: Type.Union([quoteLeadReferentSchema, Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("INSPECT_QUOTE_LEADS"), referents: Type.Array(quoteLeadReferentSchema, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }),
  Type.Object({ ...quoteOperationBase, kind: Type.Literal("INSPECT_QUOTE_STATUS") }, { additionalProperties: false }),
]);

export const quoteTurnPlanSchema = Type.Object({
  userIntentSummary: Type.String({ minLength: 1, maxLength: 400 }),
  ops: Type.Array(quoteTurnOperationSchema, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });

export const quoteAssistantOutcomeSchema = Type.Union([
  Type.Literal("CHAT"),
  Type.Literal("CLARIFICATION"),
  Type.Literal("QUOTE_LEADS"),
  Type.Literal("NO_QUOTE_LEADS"),
  Type.Literal("DEGRADED"),
]);
