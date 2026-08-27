export const REQUIRED_GOLD_TRAJECTORIES = [
  "clarify_then_research",
  "compare_without_research",
  "compound_reject_stance_and_ask",
  "local_market_refilter",
  "target_correction_requires_research",
  "undo_exact_revision",
  "focused_item_unknown_stock",
  "explain_and_warranty_unknown",
  "refresh_and_worker_restart",
  "interrupt_batches_unconsumed_messages",
  "partial_provider_failure",
  "compound_goal_change",
] as const;

export interface GoldTurnResult {
  routeExpected: string;
  routeActual: string;
  schemaValid: boolean;
  hardConstraintStateValid: boolean;
  groundedClaimValid: boolean;
  outOfSetReferenceCount: number;
  wrongProductPromotionCount: number;
  zeroProviderExpected: boolean;
  providerCallCount: number;
  expectedOperationCount: number;
  recalledOperationCount: number;
  referentCheckCount: number;
  referentCorrectCount: number;
  clarificationExpected: boolean;
  resumedWithinTwoTurns: boolean | null;
}

export interface GoldConversationResult {
  source: "REAL_MODEL_HUMAN_REVIEWED";
  conversationId: string;
  implementationVersion: string;
  modelId: string;
  trajectoryId: string;
  reviewerId: string;
  criticalPass: boolean;
  turns: GoldTurnResult[];
}

export interface GoldMetric {
  numerator: number;
  denominator: number;
  value: number;
  threshold: number;
  passed: boolean;
}

export interface GoldEvaluationReport {
  passed: boolean;
  conversationCount: number;
  threePlusTurnConversationCount: number;
  oneImplementationVersion: boolean;
  oneModelId: boolean;
  missingCriticalTrajectories: string[];
  counts: {
    outOfSetReferences: number;
    wrongProductPromotions: number;
    zeroProviderViolations: number;
  };
  metrics: {
    schemaValidity: GoldMetric;
    hardConstraintState: GoldMetric;
    groundedClaimValidity: GoldMetric;
    routeAndMultiOpRecall: GoldMetric;
    referentAccuracy: GoldMetric;
    clarificationResume: GoldMetric;
  };
  failures: string[];
}

function ratio(numerator: number, denominator: number, threshold: number): GoldMetric {
  const value = denominator === 0 ? 0 : numerator / denominator;
  return { numerator, denominator, value, threshold, passed: denominator > 0 && value >= threshold };
}

function requireFiniteCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`GOLD_FIELD_INVALID:${field}`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`GOLD_FIELD_INVALID:${field}`);
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`GOLD_FIELD_INVALID:${field}`);
  return value;
}

function parseTurn(value: unknown, path: string): GoldTurnResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`GOLD_FIELD_INVALID:${path}`);
  const item = value as Record<string, unknown>;
  const clarificationExpected = requireBoolean(item["clarificationExpected"], `${path}.clarificationExpected`);
  const resumed = item["resumedWithinTwoTurns"];
  if (resumed !== null && typeof resumed !== "boolean") throw new Error(`GOLD_FIELD_INVALID:${path}.resumedWithinTwoTurns`);
  return {
    routeExpected: requireString(item["routeExpected"], `${path}.routeExpected`),
    routeActual: requireString(item["routeActual"], `${path}.routeActual`),
    schemaValid: requireBoolean(item["schemaValid"], `${path}.schemaValid`),
    hardConstraintStateValid: requireBoolean(item["hardConstraintStateValid"], `${path}.hardConstraintStateValid`),
    groundedClaimValid: requireBoolean(item["groundedClaimValid"], `${path}.groundedClaimValid`),
    outOfSetReferenceCount: requireFiniteCount(item["outOfSetReferenceCount"], `${path}.outOfSetReferenceCount`),
    wrongProductPromotionCount: requireFiniteCount(item["wrongProductPromotionCount"], `${path}.wrongProductPromotionCount`),
    zeroProviderExpected: requireBoolean(item["zeroProviderExpected"], `${path}.zeroProviderExpected`),
    providerCallCount: requireFiniteCount(item["providerCallCount"], `${path}.providerCallCount`),
    expectedOperationCount: requireFiniteCount(item["expectedOperationCount"], `${path}.expectedOperationCount`),
    recalledOperationCount: requireFiniteCount(item["recalledOperationCount"], `${path}.recalledOperationCount`),
    referentCheckCount: requireFiniteCount(item["referentCheckCount"], `${path}.referentCheckCount`),
    referentCorrectCount: requireFiniteCount(item["referentCorrectCount"], `${path}.referentCorrectCount`),
    clarificationExpected,
    resumedWithinTwoTurns: resumed as boolean | null,
  };
}

export function parseGoldResults(value: unknown): GoldConversationResult[] {
  if (!Array.isArray(value)) throw new Error("GOLD_RESULTS_MUST_BE_ARRAY");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`GOLD_FIELD_INVALID:${index}`);
    const item = entry as Record<string, unknown>;
    if (item["source"] !== "REAL_MODEL_HUMAN_REVIEWED") throw new Error(`GOLD_SOURCE_NOT_REAL_MODEL:${index}`);
    const conversationId = requireString(item["conversationId"], `${index}.conversationId`);
    if (seen.has(conversationId)) throw new Error(`GOLD_CONVERSATION_DUPLICATE:${conversationId}`);
    seen.add(conversationId);
    const turns = item["turns"];
    if (!Array.isArray(turns) || turns.length === 0) throw new Error(`GOLD_FIELD_INVALID:${index}.turns`);
    return {
      source: "REAL_MODEL_HUMAN_REVIEWED",
      conversationId,
      implementationVersion: requireString(item["implementationVersion"], `${index}.implementationVersion`),
      modelId: requireString(item["modelId"], `${index}.modelId`),
      trajectoryId: requireString(item["trajectoryId"], `${index}.trajectoryId`),
      reviewerId: requireString(item["reviewerId"], `${index}.reviewerId`),
      criticalPass: requireBoolean(item["criticalPass"], `${index}.criticalPass`),
      turns: turns.map((turn, turnIndex) => parseTurn(turn, `${index}.turns.${turnIndex}`)),
    };
  });
}

export function evaluateGoldResults(
  records: GoldConversationResult[],
  target?: { implementationVersion: string; modelId: string },
): GoldEvaluationReport {
  const turns = records.flatMap((record) => record.turns);
  const countTrue = (select: (turn: GoldTurnResult) => boolean) => turns.filter(select).length;
  const operationExpected = turns.reduce((sum, turn) => sum + turn.expectedOperationCount, 0);
  const operationRecalled = turns.reduce((sum, turn) => sum + Math.min(turn.recalledOperationCount, turn.expectedOperationCount), 0);
  const routeCorrect = countTrue((turn) => turn.routeActual === turn.routeExpected);
  const referentChecks = turns.reduce((sum, turn) => sum + turn.referentCheckCount, 0);
  const referentCorrect = turns.reduce((sum, turn) => sum + Math.min(turn.referentCorrectCount, turn.referentCheckCount), 0);
  const clarifications = turns.filter((turn) => turn.clarificationExpected);
  const criticalPassed = new Set(records.filter((record) => record.criticalPass).map((record) => record.trajectoryId));
  const missingCriticalTrajectories = REQUIRED_GOLD_TRAJECTORIES.filter((id) => !criticalPassed.has(id));
  const metrics = {
    schemaValidity: ratio(countTrue((turn) => turn.schemaValid), turns.length, 1),
    hardConstraintState: ratio(countTrue((turn) => turn.hardConstraintStateValid), turns.length, 1),
    groundedClaimValidity: ratio(countTrue((turn) => turn.groundedClaimValid), turns.length, 1),
    routeAndMultiOpRecall: ratio(routeCorrect + operationRecalled, turns.length + operationExpected, 0.95),
    referentAccuracy: ratio(referentCorrect, referentChecks, 0.98),
    clarificationResume: ratio(clarifications.filter((turn) => turn.resumedWithinTwoTurns === true).length, clarifications.length, 0.9),
  };
  const counts = {
    outOfSetReferences: turns.reduce((sum, turn) => sum + turn.outOfSetReferenceCount, 0),
    wrongProductPromotions: turns.reduce((sum, turn) => sum + turn.wrongProductPromotionCount, 0),
    zeroProviderViolations: turns.filter((turn) => turn.zeroProviderExpected && turn.providerCallCount !== 0).length,
  };
  const conversationCount = records.length;
  const threePlusTurnConversationCount = records.filter((record) => record.turns.length >= 3).length;
  const oneImplementationVersion = new Set(records.map((record) => record.implementationVersion)).size === 1;
  const oneModelId = new Set(records.map((record) => record.modelId)).size === 1;
  const failures = [
    ...(conversationCount < 100 ? [`conversation_count:${conversationCount}/100`] : []),
    ...(threePlusTurnConversationCount < 50 ? [`three_plus_turn_conversations:${threePlusTurnConversationCount}/50`] : []),
    ...(!oneImplementationVersion ? ["mixed_implementation_versions"] : []),
    ...(!oneModelId ? ["mixed_model_ids"] : []),
    ...(target && records.some((record) => record.implementationVersion !== target.implementationVersion) ? ["unexpected_implementation_version"] : []),
    ...(target && records.some((record) => record.modelId !== target.modelId) ? ["unexpected_model_id"] : []),
    ...missingCriticalTrajectories.map((id) => `critical_trajectory:${id}`),
    ...Object.entries(metrics).filter(([, metric]) => !metric.passed).map(([name]) => `metric:${name}`),
    ...(counts.outOfSetReferences ? [`out_of_set_references:${counts.outOfSetReferences}`] : []),
    ...(counts.wrongProductPromotions ? [`wrong_product_promotions:${counts.wrongProductPromotions}`] : []),
    ...(counts.zeroProviderViolations ? [`zero_provider_violations:${counts.zeroProviderViolations}`] : []),
  ];
  return { passed: failures.length === 0, conversationCount, threePlusTurnConversationCount, oneImplementationVersion, oneModelId, missingCriticalTrajectories: [...missingCriticalTrajectories], counts, metrics, failures };
}
