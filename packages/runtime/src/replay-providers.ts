import type { BuyWhereRawProduct, FxSnapshot, Market } from "@interec/domain";

import type { FxPort, MarketSearchResult, ProductSearchPort } from "./providers.js";

export interface ReplayCallBudget {
  min: number;
  max: number;
}

export type ReplayProductResponse =
  | {
      kind: "SUCCESS";
      artifactRef: string;
      observedAt: string;
      products: BuyWhereRawProduct[];
      rawPayload: unknown;
    }
  | { kind: "ERROR"; code: string; retryable: boolean };

export interface ReplayProductCase {
  caseId: string;
  query: string;
  market: Market;
  requestedLimit: number;
  callBudget: ReplayCallBudget;
  response: ReplayProductResponse;
}

export type ReplayFxResponse =
  | { kind: "SUCCESS"; snapshot: FxSnapshot }
  | { kind: "ERROR"; code: string; retryable: boolean };

export interface ReplayFxCase {
  caseId: string;
  base: string;
  callBudget: ReplayCallBudget;
  response: ReplayFxResponse;
}

export interface ReplayProviderFixture {
  schemaVersion: "interec-replay-provider-v1";
  fixtureVersion: string;
  productSearch: ReplayProductCase[];
  fx: ReplayFxCase[];
}

export interface ReplayCallRecord {
  caseId: string;
  ordinal: number;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`REPLAY_FIELD_INVALID:${path}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`REPLAY_FIELD_UNKNOWN:${path}.${key}`);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`REPLAY_FIELD_INVALID:${path}`);
  return value.trim();
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`REPLAY_FIELD_INVALID:${path}`);
  return Number(value);
}

function parseBudget(value: unknown, path: string): ReplayCallBudget {
  const item = record(value, path);
  exactKeys(item, ["min", "max"], path);
  const min = integer(item["min"], `${path}.min`);
  const max = integer(item["max"], `${path}.max`);
  if (min > max) throw new Error(`REPLAY_CALL_BUDGET_INVALID:${path}`);
  return { min, max };
}

function parseErrorResponse(item: Record<string, unknown>, path: string): { kind: "ERROR"; code: string; retryable: boolean } {
  exactKeys(item, ["kind", "code", "retryable"], path);
  if (typeof item["retryable"] !== "boolean") throw new Error(`REPLAY_FIELD_INVALID:${path}.retryable`);
  return { kind: "ERROR", code: stringValue(item["code"], `${path}.code`), retryable: item["retryable"] };
}

export function parseReplayProviderFixture(value: unknown): ReplayProviderFixture {
  const item = record(value, "fixture");
  exactKeys(item, ["schemaVersion", "fixtureVersion", "productSearch", "fx"], "fixture");
  if (item["schemaVersion"] !== "interec-replay-provider-v1") throw new Error("REPLAY_SCHEMA_INVALID");
  if (!Array.isArray(item["productSearch"]) || !Array.isArray(item["fx"])) throw new Error("REPLAY_COLLECTION_INVALID");
  const productSearch = item["productSearch"].map((value, index): ReplayProductCase => {
    const path = `fixture.productSearch.${index}`;
    const entry = record(value, path);
    exactKeys(entry, ["caseId", "query", "market", "requestedLimit", "callBudget", "response"], path);
    const market = stringValue(entry["market"], `${path}.market`);
    if (market !== "US" && market !== "SG") throw new Error(`REPLAY_MARKET_INVALID:${path}.market`);
    const responsePath = `${path}.response`;
    const response = record(entry["response"], responsePath);
    let parsedResponse: ReplayProductResponse;
    if (response["kind"] === "ERROR") {
      parsedResponse = parseErrorResponse(response, responsePath);
    } else if (response["kind"] === "SUCCESS") {
      exactKeys(response, ["kind", "artifactRef", "observedAt", "products", "rawPayload"], responsePath);
      if (!Array.isArray(response["products"])) throw new Error(`REPLAY_FIELD_INVALID:${responsePath}.products`);
      parsedResponse = {
        kind: "SUCCESS",
        artifactRef: stringValue(response["artifactRef"], `${responsePath}.artifactRef`),
        observedAt: stringValue(response["observedAt"], `${responsePath}.observedAt`),
        products: structuredClone(response["products"]) as BuyWhereRawProduct[],
        rawPayload: structuredClone(response["rawPayload"]),
      };
    } else {
      throw new Error(`REPLAY_RESPONSE_KIND_INVALID:${responsePath}`);
    }
    return {
      caseId: stringValue(entry["caseId"], `${path}.caseId`),
      query: stringValue(entry["query"], `${path}.query`),
      market,
      requestedLimit: integer(entry["requestedLimit"], `${path}.requestedLimit`),
      callBudget: parseBudget(entry["callBudget"], `${path}.callBudget`),
      response: parsedResponse,
    };
  });
  const fx = item["fx"].map((value, index): ReplayFxCase => {
    const path = `fixture.fx.${index}`;
    const entry = record(value, path);
    exactKeys(entry, ["caseId", "base", "callBudget", "response"], path);
    const responsePath = `${path}.response`;
    const response = record(entry["response"], responsePath);
    let parsedResponse: ReplayFxResponse;
    if (response["kind"] === "ERROR") {
      parsedResponse = parseErrorResponse(response, responsePath);
    } else if (response["kind"] === "SUCCESS") {
      exactKeys(response, ["kind", "snapshot"], responsePath);
      const snapshot = record(response["snapshot"], `${responsePath}.snapshot`);
      exactKeys(snapshot, ["id", "base", "quote", "rate", "provider", "observedAt", "expiresAt"], `${responsePath}.snapshot`);
      if (snapshot["quote"] !== "CNY") throw new Error(`REPLAY_FIELD_INVALID:${responsePath}.snapshot.quote`);
      parsedResponse = {
        kind: "SUCCESS",
        snapshot: {
          id: stringValue(snapshot["id"], `${responsePath}.snapshot.id`),
          base: stringValue(snapshot["base"], `${responsePath}.snapshot.base`).toUpperCase(),
          quote: "CNY",
          rate: stringValue(snapshot["rate"], `${responsePath}.snapshot.rate`),
          provider: stringValue(snapshot["provider"], `${responsePath}.snapshot.provider`),
          observedAt: stringValue(snapshot["observedAt"], `${responsePath}.snapshot.observedAt`),
          expiresAt: stringValue(snapshot["expiresAt"], `${responsePath}.snapshot.expiresAt`),
        },
      };
    } else {
      throw new Error(`REPLAY_RESPONSE_KIND_INVALID:${responsePath}`);
    }
    return {
      caseId: stringValue(entry["caseId"], `${path}.caseId`),
      base: stringValue(entry["base"], `${path}.base`).toUpperCase(),
      callBudget: parseBudget(entry["callBudget"], `${path}.callBudget`),
      response: parsedResponse,
    };
  });
  const caseIds = [...productSearch, ...fx].map((entry) => entry.caseId);
  if (new Set(caseIds).size !== caseIds.length) throw new Error("REPLAY_CASE_ID_DUPLICATE");
  return {
    schemaVersion: "interec-replay-provider-v1",
    fixtureVersion: stringValue(item["fixtureVersion"], "fixture.fixtureVersion"),
    productSearch,
    fx,
  };
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("RUN_ABORTED");
}

function replayError(response: { code: string; retryable: boolean }): Error {
  return Object.assign(new Error(response.code), { retryable: response.retryable });
}

abstract class ReplayPortBase<TCase extends { caseId: string; callBudget: ReplayCallBudget }> {
  protected readonly counts = new Map<string, number>();
  public readonly calls: ReplayCallRecord[] = [];

  protected recordCall(testCase: TCase): void {
    const ordinal = (this.counts.get(testCase.caseId) ?? 0) + 1;
    if (ordinal > testCase.callBudget.max) throw new Error(`REPLAY_CALL_BUDGET_EXCEEDED:${testCase.caseId}:${ordinal}/${testCase.callBudget.max}`);
    this.counts.set(testCase.caseId, ordinal);
    this.calls.push({ caseId: testCase.caseId, ordinal });
  }

  public assertCallBudgets(cases: readonly TCase[]): void {
    for (const testCase of cases) {
      const actual = this.counts.get(testCase.caseId) ?? 0;
      if (actual < testCase.callBudget.min || actual > testCase.callBudget.max) {
        throw new Error(`REPLAY_CALL_BUDGET_UNSATISFIED:${testCase.caseId}:${actual}/${testCase.callBudget.min}-${testCase.callBudget.max}`);
      }
    }
  }
}

export class ReplayProductSearchPort extends ReplayPortBase<ReplayProductCase> implements ProductSearchPort {
  public constructor(private readonly cases: readonly ReplayProductCase[]) {
    super();
  }

  public async search(query: string, market: Market, limit: number, signal?: AbortSignal): Promise<MarketSearchResult> {
    abortIfNeeded(signal);
    const testCase = this.cases.find((entry) => entry.query === query && entry.market === market && entry.requestedLimit === limit);
    if (!testCase) throw new Error(`REPLAY_PRODUCT_CALL_UNPLANNED:${query}:${market}:${limit}`);
    this.recordCall(testCase);
    if (testCase.response.kind === "ERROR") throw replayError(testCase.response);
    return {
      market,
      products: structuredClone(testCase.response.products),
      artifactRef: testCase.response.artifactRef,
      rawPayload: structuredClone(testCase.response.rawPayload),
      observedAt: testCase.response.observedAt,
    };
  }

  public assertComplete(): void {
    this.assertCallBudgets(this.cases);
  }
}

export class ReplayFxPort extends ReplayPortBase<ReplayFxCase> implements FxPort {
  public constructor(private readonly cases: readonly ReplayFxCase[]) {
    super();
  }

  public async getRate(base: string, signal?: AbortSignal): Promise<FxSnapshot> {
    abortIfNeeded(signal);
    const normalized = base.toUpperCase();
    const testCase = this.cases.find((entry) => entry.base === normalized);
    if (!testCase) throw new Error(`REPLAY_FX_CALL_UNPLANNED:${normalized}`);
    this.recordCall(testCase);
    if (testCase.response.kind === "ERROR") throw replayError(testCase.response);
    return structuredClone(testCase.response.snapshot);
  }

  public assertComplete(): void {
    this.assertCallBudgets(this.cases);
  }
}
