import { DomainError } from "./errors.js";

export const CLARIFICATION_KINDS = [
  "BUDGET",
  "PURCHASE_MARKET",
  "TARGET_PRODUCT",
  "TARGET_MODEL",
  "CONDITION",
  "DELIVERY_DESTINATION",
  "QUANTITY",
  "FORM_FACTOR",
  "CANDIDATE_REFERENT",
  "TURN_REPHRASE",
] as const;

export type ClarificationKind = typeof CLARIFICATION_KINDS[number];

export interface ClarificationIntent {
  kind: ClarificationKind;
  contextRef?: string;
  interpretations?: string[];
}

interface ClarificationDefinition {
  legacyAliases: readonly string[];
  wording: string;
  rationale: string;
  requiresContextRef?: boolean;
  allowsInterpretations?: boolean;
  response: {
    inputMode: "SINGLE_SELECT" | "FREE_TEXT";
    allowFreeText: boolean;
    allowSkip: boolean;
    examples?: readonly string[];
    options?: readonly ClarificationOptionDefinition[];
  };
}

export interface ClarificationOptionDefinition {
  id: string;
  label: string;
  answerText: string;
  goalValue?: unknown;
}

export interface ClarificationResponseSpec {
  inputMode: "SINGLE_SELECT" | "FREE_TEXT";
  allowFreeText: boolean;
  allowSkip: boolean;
  examples: string[];
  options: Array<{ id: string; label: string }>;
}

export const CLARIFICATION_REGISTRY: Readonly<Record<ClarificationKind, ClarificationDefinition>> = {
  BUDGET: {
    legacyAliases: ["budget"],
    wording: "预算大概是多少？",
    rationale: "预算用于过滤明显超出范围的报价；如果暂时不想限制，也可以跳过。",
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: true, examples: ["3000 元以内", "预算不限"] },
  },
  PURCHASE_MARKET: {
    legacyAliases: ["retrieval_markets", "retrieval_market", "market"],
    wording: "想比较哪些购买市场？可选美国、新加坡或两边都比较；如果暂时不确定，也可以说“先都看看”。",
    rationale: "购买市场决定本轮检索的数据来源、币种和可购买性范围，不是商品偏好。",
    response: {
      inputMode: "SINGLE_SELECT", allowFreeText: true, allowSkip: true,
      options: [
        { id: "US", label: "美国", answerText: "只比较美国市场", goalValue: ["US"] },
        { id: "SG", label: "新加坡", answerText: "只比较新加坡市场", goalValue: ["SG"] },
        { id: "US_SG", label: "两边都比较", answerText: "比较美国和新加坡市场", goalValue: ["US", "SG"] },
      ],
    },
  },
  TARGET_PRODUCT: {
    legacyAliases: ["target_product"],
    wording: "你想买哪类商品或哪个具体型号？例如“通勤用头戴式耳机”或“Sony WH-1000XM5”。",
    rationale: "商品类别或型号是开始检索的必要范围。",
    allowsInterpretations: true,
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: false, examples: ["通勤用头戴式耳机", "Sony WH-1000XM5"] },
  },
  TARGET_MODEL: {
    legacyAliases: ["target_model", "model"],
    wording: "有指定的具体型号吗？",
    rationale: "具体型号可以减少不同代际或配置混在一起；没有指定型号可以跳过。",
    allowsInterpretations: true,
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: true, examples: ["Sony WH-1000XM5", "没有指定型号"] },
  },
  CONDITION: {
    legacyAliases: ["condition"],
    wording: "只考虑全新商品，还是也接受翻新或二手？",
    rationale: "商品成色会影响价格、保修和可比性。",
    response: {
      inputMode: "SINGLE_SELECT", allowFreeText: true, allowSkip: true,
      options: [
        { id: "NEW", label: "只看全新", answerText: "只考虑全新商品", goalValue: "NEW" },
        { id: "ANY", label: "成色不限", answerText: "商品成色不限", goalValue: "ANY" },
      ],
    },
  },
  DELIVERY_DESTINATION: {
    legacyAliases: ["delivery_destination"],
    wording: "商品最终需要送到哪个国家或地区？",
    rationale: "收货地会影响配送可达性、税费和保修判断。",
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: true, examples: ["中国大陆", "新加坡"] },
  },
  QUANTITY: {
    legacyAliases: ["quantity"],
    wording: "需要购买多少件？如果数量不影响选择，也可以说“一件”或“不限”。",
    rationale: "数量可能影响库存与批量报价；普通单件购买可以跳过。",
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: true, examples: ["1 件", "3 件"] },
  },
  FORM_FACTOR: {
    legacyAliases: ["form_factor"],
    wording: "你偏好哪种产品形态？如果没有偏好，也可以直接说“不限”。",
    rationale: "产品形态用于缩小候选，但不应在没有偏好时阻塞检索。",
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: true, examples: ["头戴式", "形态不限"] },
  },
  CANDIDATE_REFERENT: {
    legacyAliases: ["referent"],
    wording: "你指的是当前候选中的哪一个？",
    requiresContextRef: true,
    rationale: "需要先确定候选对象，才能安全读取或修改对应信息。",
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: false, examples: ["第一个", "价格 1900 元的那个"] },
  },
  TURN_REPHRASE: {
    legacyAliases: ["turn_rephrase"],
    wording: "请换一种说法告诉我你想继续调整、比较或了解什么。",
    rationale: "上一轮没有形成可安全执行的结构化意图。",
    response: { inputMode: "FREE_TEXT", allowFreeText: true, allowSkip: false, examples: ["比较前两个候选的价格", "只看新加坡市场"] },
  },
};

const kindSet = new Set<string>(CLARIFICATION_KINDS);
const kindByLegacyAlias = new Map<string, ClarificationKind>();
for (const kind of CLARIFICATION_KINDS) {
  for (const alias of CLARIFICATION_REGISTRY[kind].legacyAliases) {
    if (kindByLegacyAlias.has(alias)) throw new Error(`DUPLICATE_CLARIFICATION_ALIAS:${alias}`);
    kindByLegacyAlias.set(alias, kind);
  }
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DomainError(code, `${code}: a non-empty string is required`);
  return value.trim();
}

export function clarificationFromLegacySlotId(slotId: string): ClarificationIntent {
  const normalized = requiredText(slotId, "INVALID_CLARIFICATION_SLOT").toLocaleLowerCase("en-US");
  if (normalized.startsWith("referent:")) {
    return { kind: "CANDIDATE_REFERENT", contextRef: requiredText(normalized.slice("referent:".length), "INVALID_CLARIFICATION_CONTEXT") };
  }
  const kind = kindByLegacyAlias.get(normalized);
  if (!kind) throw new DomainError("UNKNOWN_CLARIFICATION_SLOT", `Unknown clarification protocol value: ${normalized}`);
  return { kind };
}

export function normalizeClarificationIntent(value: unknown): ClarificationIntent {
  if (typeof value === "string") return clarificationFromLegacySlotId(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_CLARIFICATION_INTENT", "Clarification intent must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["slotId"] === "string") return clarificationFromLegacySlotId(record["slotId"]);
  const kind = requiredText(record["kind"], "INVALID_CLARIFICATION_KIND").toLocaleUpperCase("en-US");
  if (!kindSet.has(kind)) throw new DomainError("UNKNOWN_CLARIFICATION_KIND", `Unknown clarification kind: ${kind}`);
  const definition = CLARIFICATION_REGISTRY[kind as ClarificationKind];
  const contextRef = typeof record["contextRef"] === "string" && record["contextRef"].trim()
    ? record["contextRef"].trim()
    : undefined;
  if (definition.requiresContextRef && !contextRef) {
    throw new DomainError("CLARIFICATION_CONTEXT_REQUIRED", `Clarification ${kind} requires contextRef`);
  }
  if (!definition.requiresContextRef && contextRef) {
    throw new DomainError("CLARIFICATION_CONTEXT_NOT_ALLOWED", `Clarification ${kind} does not accept contextRef`);
  }
  const rawInterpretations = record["interpretations"];
  if (rawInterpretations !== undefined && !definition.allowsInterpretations) {
    throw new DomainError("CLARIFICATION_INTERPRETATIONS_NOT_ALLOWED", `Clarification ${kind} does not accept interpretations`);
  }
  const interpretations = rawInterpretations === undefined
    ? undefined
    : Array.isArray(rawInterpretations)
      ? rawInterpretations.map((item) => requiredText(item, "INVALID_CLARIFICATION_INTERPRETATION"))
      : (() => { throw new DomainError("INVALID_CLARIFICATION_INTERPRETATIONS", "Clarification interpretations must be an array"); })();
  if (interpretations && (interpretations.length < 2 || interpretations.length > 4
    || interpretations.some((item) => item.length > 80)
    || new Set(interpretations).size !== interpretations.length)) {
    throw new DomainError("INVALID_CLARIFICATION_INTERPRETATIONS", "Clarification interpretations require 2-4 unique values of at most 80 characters");
  }
  return {
    kind: kind as ClarificationKind,
    ...(contextRef ? { contextRef } : {}),
    ...(interpretations ? { interpretations } : {}),
  };
}

export function clarificationKey(intent: ClarificationIntent): string {
  const normalized = normalizeClarificationIntent(intent);
  return normalized.contextRef ? `${normalized.kind}:${normalized.contextRef}` : normalized.kind;
}

export function clarificationWording(intent: ClarificationIntent): string {
  const normalized = normalizeClarificationIntent(intent);
  if (normalized.interpretations) return "你提到的商品有多种可能含义，具体想买哪一种？";
  return CLARIFICATION_REGISTRY[normalized.kind].wording;
}

export function clarificationRationale(intent: ClarificationIntent): string {
  const normalized = normalizeClarificationIntent(intent);
  if (normalized.interpretations) return "先确认商品含义，可以避免按错误品类检索和比较。";
  return CLARIFICATION_REGISTRY[normalized.kind].rationale;
}

export function clarificationResponseSpec(intent: ClarificationIntent): ClarificationResponseSpec {
  const normalized = normalizeClarificationIntent(intent);
  const response = CLARIFICATION_REGISTRY[normalized.kind].response;
  return {
    inputMode: response.inputMode,
    allowFreeText: response.allowFreeText,
    allowSkip: response.allowSkip,
    examples: [...(normalized.interpretations ?? response.examples ?? [])],
    options: (response.options ?? []).map(({ id, label }) => ({ id, label })),
  };
}

export function clarificationOption(intent: ClarificationIntent, optionId: string): ClarificationOptionDefinition {
  const normalized = normalizeClarificationIntent(intent);
  const requested = requiredText(optionId, "INVALID_CLARIFICATION_OPTION");
  const option = CLARIFICATION_REGISTRY[normalized.kind].response.options?.find((item) => item.id === requested);
  if (!option) throw new DomainError("INVALID_CLARIFICATION_OPTION", `Option ${requested} is not valid for ${normalized.kind}`);
  return structuredClone(option);
}

export function legacyClarificationSlotId(intent: ClarificationIntent): string {
  const normalized = normalizeClarificationIntent(intent);
  if (normalized.kind === "CANDIDATE_REFERENT") return `referent:${normalized.contextRef}`;
  return CLARIFICATION_REGISTRY[normalized.kind].legacyAliases[0]!;
}
