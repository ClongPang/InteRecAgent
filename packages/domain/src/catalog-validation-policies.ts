export interface CategoryValidationPolicy {
  schemaVersion: 1;
  version: string;
  categoryId: string;
  aliases: readonly string[];
  broaderQueryTerm: string;
  categorySignals: readonly RegExp[];
  primarySignals: readonly RegExp[];
  accessorySignals: readonly RegExp[];
  modelSignals: readonly RegExp[];
  identityQualifierRules: readonly {
    key: string;
    value: string | number | boolean;
    signals: readonly RegExp[];
  }[];
  attributeValidationRules: readonly {
    key: string;
    value: string | number | boolean;
    queryTerms: readonly string[];
    positiveSignals: readonly RegExp[];
    negativeSignals: readonly RegExp[];
  }[];
}

export interface MarketDefinition {
  schemaVersion: 1;
  version: string;
  marketId: string;
  countryCode: string;
  defaultCurrency: string;
  label: string;
}

export const CATEGORY_VALIDATION_POLICIES = Object.freeze([
  {
    schemaVersion: 1,
    version: "2026-08-01",
    categoryId: "headphones",
    aliases: ["headphone", "headphones", "headset", "headsets", "耳机"],
    broaderQueryTerm: "headphones",
    categorySignals: [/\b(?:headphones?|headsets?|over[\s-]?ear)\b|耳机|头戴/iu],
    primarySignals: [/\b(?:headphones?|headsets?|noise[\s-]?cancell?ing)\b|耳机|降噪/iu],
    accessorySignals: [/\b(?:earpads?|ear[\s-]?cushions?|headphone\s+(?:case|cable|stand)|audio\s+cables?)\b|耳罩|耳垫|耳机套|耳机线/iu],
    modelSignals: [
      /\b[A-Z]{1,8}[\s-]?\d{3,}[A-Z0-9-]*\b/gu,
      /\b[A-Z]{1,8}[\s-]?\d{3,}[A-Z][A-Z0-9-]*\b/giu,
      /\b(?:BOSE\s+)?QUIETCOMFORT(?:\s+(?:ULTRA|SC|SE|35|45))?\b/giu,
      /\bAIRPODS(?:\s+(?:PRO|MAX))(?:\s+\d(?:ND|RD|TH)?\s+GENERATION)?\b/giu,
    ],
    identityQualifierRules: [{
      key: "form_factor",
      value: "over_ear",
      signals: [/\bover[\s-]?(?:ear|the[\s-]ear)\b|\bheadband\b|头戴/iu],
    }],
    attributeValidationRules: [{
      key: "noise_cancelling",
      value: true,
      queryTerms: ["active noise cancelling"],
      positiveSignals: [/\b(?:active\s+noise\s+cancell?ation|noise[\s-]?cancell?ing|ANC)\b|主动降噪|降噪/iu],
      negativeSignals: [/\bopen[\s-]?back\b|开放式/iu],
    }],
  },
  {
    schemaVersion: 1,
    version: "2026-08-01",
    categoryId: "smartphone",
    aliases: ["smartphone", "smartphones", "phone", "mobile phone", "手机", "智能手机"],
    broaderQueryTerm: "smartphone",
    categorySignals: [/\b(?:smartphones?|mobile\s+phones?|iphones?|galaxy\s+s\d+|pixel\s+\d+)\b|智能手机|手机/iu],
    primarySignals: [/\b(?:smartphones?|mobile\s+phones?|iphones?|galaxy\s+s\d+|pixel\s+\d+)\b|智能手机|手机/iu],
    accessorySignals: [/\b(?:phone\s+cases?|screen\s+protectors?|tempered\s+glass|charging\s+cables?|phone\s+holders?|camera\s+lens\s+protectors?)\b|手机壳|保护壳|钢化膜|屏幕保护|充电线|手机支架/iu],
    modelSignals: [
      /\bIPHONE\s+\d{1,2}(?:\s+(?:PRO|PLUS|MINI|MAX)){0,2}\b/giu,
      /\bGALAXY\s+S\d{1,2}(?:\s+(?:FE|PLUS|ULTRA))?\b/giu,
      /\bPIXEL\s+\d{1,2}(?:\s+(?:A|PRO|XL|FOLD)){0,2}\b/giu,
    ],
    identityQualifierRules: [],
    attributeValidationRules: [],
  },
] satisfies readonly CategoryValidationPolicy[]);

export const MARKET_DEFINITIONS = Object.freeze([
  { schemaVersion: 1, version: "2026-08-01", marketId: "US", countryCode: "US", defaultCurrency: "USD", label: "United States" },
  { schemaVersion: 1, version: "2026-08-01", marketId: "SG", countryCode: "SG", defaultCurrency: "SGD", label: "Singapore" },
] satisfies readonly MarketDefinition[]);

export type CategoryId = (typeof CATEGORY_VALIDATION_POLICIES)[number]["categoryId"];
export type MarketId = (typeof MARKET_DEFINITIONS)[number]["marketId"];
export type RegisteredCategoryValidationPolicy = (typeof CATEGORY_VALIDATION_POLICIES)[number];
export type RegisteredMarketDefinition = (typeof MARKET_DEFINITIONS)[number];

export function resolveCategoryValidationPolicy(value: string): RegisteredCategoryValidationPolicy | null {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  return CATEGORY_VALIDATION_POLICIES.find((policy) => policy.categoryId === normalized || policy.aliases.includes(normalized)) ?? null;
}

export function inferCategoryValidationPolicies(value: string): RegisteredCategoryValidationPolicy[] {
  return CATEGORY_VALIDATION_POLICIES.filter((policy) => policy.categorySignals.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }));
}

export function inferCategoryValidationPolicy(value: string): RegisteredCategoryValidationPolicy | null {
  const explicit = inferCategoryValidationPolicies(value)[0];
  if (explicit) return explicit;
  return CATEGORY_VALIDATION_POLICIES.find((policy) => policy.modelSignals.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  })) ?? null;
}

export function canonicalCategoryValidationPolicy(value: string): RegisteredCategoryValidationPolicy | null {
  const explicit = resolveCategoryValidationPolicy(value);
  if (explicit) return explicit;
  const semanticText = value.normalize("NFKC").replace(/[_/]+/g, " ").trim();
  return inferCategoryValidationPolicy(semanticText);
}

export function resolveMarketDefinition(value: string): RegisteredMarketDefinition | null {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  return MARKET_DEFINITIONS.find((market) => market.marketId === normalized) ?? null;
}

function normalizedModel(value: string): string {
  const upper = value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, " ");
  return /^([A-Z]{1,8})[\s-]?(\d{3,}[A-Z0-9-]*)$/.test(upper) ? upper.replace(/[\s-]/g, "") : upper;
}

export function canonicalModels(value: string, categoryId?: string): string[] {
  const resolved = categoryId ? resolveCategoryValidationPolicy(categoryId) : null;
  const selected: readonly CategoryValidationPolicy[] = categoryId ? (resolved ? [resolved] : []) : CATEGORY_VALIDATION_POLICIES;
  const found: string[] = [];
  for (const policy of selected) {
    for (const pattern of policy.modelSignals) {
      pattern.lastIndex = 0;
      for (const match of value.matchAll(pattern)) if (match[0]) found.push(normalizedModel(match[0]));
    }
  }
  return [...new Set(found)];
}

export function canonicalProductModel(value: string, categoryId?: string): string | null {
  const base = canonicalModels(value, categoryId)[0] ?? null;
  if (!base) return null;
  if (resolveCategoryValidationPolicy(categoryId ?? "")?.categoryId !== "smartphone") return base;
  const capacity = value.normalize("NFKC").match(/\b(\d+)\s*(GB|TB)\b/iu);
  return capacity ? `${base} ${capacity[1]}${capacity[2]!.toUpperCase()}` : base;
}

export function validationPatternMatches(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function identityQualifierMatchesTarget(
  policy: CategoryValidationPolicy,
  key: string,
  value: unknown,
  targetText: string | null | undefined,
): boolean {
  if (!targetText) return false;
  const rule = policy.identityQualifierRules.find((candidate) => candidate.key === key && candidate.value === value);
  return Boolean(rule && validationPatternMatches(rule.signals, targetText));
}
