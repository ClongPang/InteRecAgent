const REQUIRED_ROUTES = ["talk", "clarify", "refilter", "sort", "search"] as const;

export interface ShadowTurnResult {
  route: string;
  reviewerIds: string[];
}

export interface ShadowConversationResult {
  source: "REAL_SHADOW";
  conversationId: string;
  implementationVersion: string;
  modelId: string;
  turns: ShadowTurnResult[];
}

export interface ShadowPolicy {
  minimumRouteCounts: Record<string, number>;
}

export interface ShadowEvaluationReport {
  passed: boolean;
  conversationCount: number;
  turnCount: number;
  threePlusTurnConversationCount: number;
  doubleReviewedTurnCount: number;
  oneImplementationVersion: boolean;
  oneModelId: boolean;
  routeCounts: Record<string, number>;
  failures: string[];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`SHADOW_FIELD_INVALID:${field}`);
  return value.trim();
}

export function parseShadowPolicy(value: unknown): ShadowPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SHADOW_POLICY_INVALID");
  const minimumRouteCounts = (value as Record<string, unknown>)["minimumRouteCounts"];
  if (!minimumRouteCounts || typeof minimumRouteCounts !== "object" || Array.isArray(minimumRouteCounts)) throw new Error("SHADOW_POLICY_ROUTES_INVALID");
  const routes = minimumRouteCounts as Record<string, unknown>;
  for (const route of REQUIRED_ROUTES) {
    const count = routes[route];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) throw new Error(`SHADOW_POLICY_ROUTE_INVALID:${route}`);
  }
  return { minimumRouteCounts: Object.fromEntries(REQUIRED_ROUTES.map((route) => [route, routes[route] as number])) };
}

export function parseShadowResults(value: unknown): ShadowConversationResult[] {
  if (!Array.isArray(value)) throw new Error("SHADOW_RESULTS_MUST_BE_ARRAY");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`SHADOW_FIELD_INVALID:${index}`);
    const item = entry as Record<string, unknown>;
    if (item["source"] !== "REAL_SHADOW") throw new Error(`SHADOW_SOURCE_NOT_REAL:${index}`);
    const conversationId = requiredString(item["conversationId"], `${index}.conversationId`);
    if (seen.has(conversationId)) throw new Error(`SHADOW_CONVERSATION_DUPLICATE:${conversationId}`);
    seen.add(conversationId);
    const rawTurns = item["turns"];
    if (!Array.isArray(rawTurns) || rawTurns.length === 0) throw new Error(`SHADOW_FIELD_INVALID:${index}.turns`);
    const turns = rawTurns.map((turn, turnIndex) => {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) throw new Error(`SHADOW_FIELD_INVALID:${index}.turns.${turnIndex}`);
      const turnItem = turn as Record<string, unknown>;
      const reviewerIds = turnItem["reviewerIds"];
      if (!Array.isArray(reviewerIds) || reviewerIds.some((id) => typeof id !== "string" || !id.trim())) {
        throw new Error(`SHADOW_FIELD_INVALID:${index}.turns.${turnIndex}.reviewerIds`);
      }
      return {
        route: requiredString(turnItem["route"], `${index}.turns.${turnIndex}.route`),
        reviewerIds: [...new Set(reviewerIds.map((id) => (id as string).trim()))],
      };
    });
    return {
      source: "REAL_SHADOW",
      conversationId,
      implementationVersion: requiredString(item["implementationVersion"], `${index}.implementationVersion`),
      modelId: requiredString(item["modelId"], `${index}.modelId`),
      turns,
    };
  });
}

export function evaluateShadowResults(
  records: ShadowConversationResult[],
  policy: ShadowPolicy,
  target?: { implementationVersion: string; modelId: string },
): ShadowEvaluationReport {
  const turns = records.flatMap((record) => record.turns);
  const routeCounts: Record<string, number> = {};
  for (const turn of turns) routeCounts[turn.route] = (routeCounts[turn.route] ?? 0) + 1;
  const conversationCount = records.length;
  const turnCount = turns.length;
  const threePlusTurnConversationCount = records.filter((record) => record.turns.length >= 3).length;
  const doubleReviewedTurnCount = turns.filter((turn) => turn.reviewerIds.length >= 2).length;
  const oneImplementationVersion = new Set(records.map((record) => record.implementationVersion)).size === 1;
  const oneModelId = new Set(records.map((record) => record.modelId)).size === 1;
  const failures = [
    ...(turnCount < 1000 ? [`turn_count:${turnCount}/1000`] : []),
    ...(threePlusTurnConversationCount < 200 ? [`three_plus_turn_conversations:${threePlusTurnConversationCount}/200`] : []),
    ...(doubleReviewedTurnCount < 100 ? [`double_reviewed_turns:${doubleReviewedTurnCount}/100`] : []),
    ...(!oneImplementationVersion ? ["mixed_implementation_versions"] : []),
    ...(!oneModelId ? ["mixed_model_ids"] : []),
    ...(target && records.some((record) => record.implementationVersion !== target.implementationVersion) ? ["unexpected_implementation_version"] : []),
    ...(target && records.some((record) => record.modelId !== target.modelId) ? ["unexpected_model_id"] : []),
    ...Object.entries(policy.minimumRouteCounts)
      .filter(([route, required]) => (routeCounts[route] ?? 0) < required)
      .map(([route, required]) => `route_quota:${route}:${routeCounts[route] ?? 0}/${required}`),
  ];
  return { passed: failures.length === 0, conversationCount, turnCount, threePlusTurnConversationCount, doubleReviewedTurnCount, oneImplementationVersion, oneModelId, routeCounts, failures };
}
