import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { developmentEvaluationModelFailureCode, type DevelopmentEvaluationCase } from "@interec/agent";

import type { AcceptConversationTurnInput, ConversationRepository } from "./conversation-repository-types.js";
import { ConversationWorker, type AgentTraceCorrelation } from "./conversation-worker.js";
import { PostgresConversationSearchRepository } from "./conversation-search-repository.js";
import type { LangfusePromptLink } from "./langfuse-prompt.js";
import type { PiModelRuntime } from "./model-factory.js";
import { PostgresConversationRepository } from "./postgres-conversation-repository.js";
import { PostgresProviderCallController } from "./provider-call-controller.js";
import type { FxPort, MarketSearchResult, ProductSearchPort } from "./providers.js";
import { ReplayFxPort, ReplayProductSearchPort, type ReplayProviderFixture } from "./replay-providers.js";
import { observeTurnEnqueue, telemetryTraceIdForTurn } from "./telemetry.js";

export interface DevelopmentEvaluationTrialArtifact extends Record<string, unknown> {
  trialId: string;
  taskId: string;
  runIndex: number;
  status: "COMPLETED" | "FAILED";
  environmentAction: string;
  userTurns: string[];
  turnIds: string[];
  turnEvidence: Array<Record<string, unknown>>;
  finalState: unknown;
  replayCalls: unknown[];
  queryAliases: Array<{ actualQuery: string; fixtureQuery: string; market: string }>;
  startedAt: string;
  completedAt: string;
  failure: string | null;
  traceCorrelation?: AgentTraceCorrelation;
}

export interface DevelopmentEvaluationTrialExecutorOptions {
  promptLink?: LangfusePromptLink;
}

export interface EvaluationExperimentTraceContext {
  datasetRunName: string;
  datasetItemId: string;
  experimentWrapperTraceId: string;
}

export function evaluationImplementationFingerprint(root = process.cwd()): string {
  const sourceFiles = (relativeRoot: string): string[] => readdirSync(resolve(root, relativeRoot), { withFileTypes: true }).flatMap((entry) => {
    const path = `${relativeRoot}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
  const paths = [
    ...sourceFiles("packages/domain/src"),
    ...sourceFiles("packages/agent/src"),
    ...sourceFiles("packages/runtime/src"),
  ].sort();
  const hash = createHash("sha256");
  for (const path of paths) hash.update(path).update("\0").update(readFileSync(resolve(root, path))).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

interface Barrier {
  reached: Promise<void>;
  enter(): Promise<void>;
  release(): void;
}

function barrier(): Barrier {
  let announce!: () => void;
  let continueRun!: () => void;
  const reached = new Promise<void>((resolveReached) => { announce = resolveReached; });
  const released = new Promise<void>((resolveReleased) => { continueRun = resolveReleased; });
  let announced = false;
  return {
    reached,
    async enter() {
      if (!announced) {
        announced = true;
        announce();
        await released;
      }
    },
    release: () => continueRun(),
  };
}

async function reachedWithin(value: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`DEVELOPMENT_EVAL_BARRIER_TIMEOUT:${label}`)), 90_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function reachedBeforeRunEnds(value: Promise<void>, run: Promise<boolean>, label: string): Promise<void> {
  await Promise.race([
    reachedWithin(value, label),
    run.then(() => { throw new Error(`DEVELOPMENT_EVAL_INTERRUPT_POINT_NOT_REACHED:${label}`); }),
  ]);
}

function fixtureQueryFor(seed: DevelopmentEvaluationCase["fixtureSeed"], actualQuery: string): string {
  const normalized = actualQuery.normalize("NFKC").toUpperCase();
  if (seed === "HEADPHONES_XM5" || seed === "HEADPHONES_ACCESSORY_TRAPS") return "WH1000XM5";
  if (seed === "HEADPHONES_XM4") return /XM5|WH.?1000XM5/u.test(normalized) ? "WH1000XM5" : "WH1000XM4";
  if (seed === "SMARTPHONE_IPHONE16PRO_256") return normalized.includes("128GB") ? "IPHONE 16 PRO 128GB" : "IPHONE 16 PRO 256GB";
  if (seed === "SMARTPHONE_PIXEL9PRO_256") return "PIXEL 9 PRO 256GB";
  if (seed === "OPEN_WASHER") return "front load washing machine";
  if (seed === "OPEN_OFFICE_CHAIR") return "ergonomic office chair";
  if (seed === "OPEN_TO_HEADPHONES") return /XM5|WH.?1000XM5/u.test(normalized) ? "WH1000XM5" : "portable audio device";
  throw new Error(`DEVELOPMENT_EVAL_FIXTURE_SEED_UNMAPPED:${seed satisfies never}`);
}

function evaluationProductSearchPort(
  base: ReplayProductSearchPort,
  fixtureSeed: DevelopmentEvaluationCase["fixtureSeed"],
  environmentAction: string,
  aliases: Array<{ actualQuery: string; fixtureQuery: string; market: string }>,
  providerBarrier?: Barrier,
): ProductSearchPort {
  return {
    async search(query, market, limit, signal): Promise<MarketSearchResult> {
      if (providerBarrier) await providerBarrier.enter();
      if (environmentAction === "SG_PROVIDER_UNAVAILABLE" && market === "SG") throw Object.assign(new Error("BUYWHERE_UNAVAILABLE"), { retryable: false });
      if (environmentAction === "US_PROVIDER_TIMEOUT" && market === "US") throw Object.assign(new Error("BUYWHERE_TIMEOUT"), { retryable: false });
      if (environmentAction === "ALL_PROVIDERS_UNAVAILABLE") throw Object.assign(new Error("BUYWHERE_UNAVAILABLE"), { retryable: false });
      const fixtureQuery = fixtureQueryFor(fixtureSeed, query);
      aliases.push({ actualQuery: query, fixtureQuery, market });
      return base.search(fixtureQuery, market, limit, signal);
    },
  };
}

function commitBarrierRepository(repository: PostgresConversationRepository, commitBarrier?: Barrier): ConversationRepository {
  if (!commitBarrier) return repository;
  return new Proxy(repository as unknown as ConversationRepository, {
    get(target, property) {
      const value = Reflect.get(target as unknown as object, property);
      if (property === "commitTurn" && typeof value === "function") {
        return async (...args: unknown[]) => {
          await commitBarrier.enter();
          return value.apply(repository, args);
        };
      }
      return typeof value === "function" ? value.bind(repository) : value;
    },
  });
}

async function collectTurnEvidence(repository: PostgresConversationRepository, turnId: string): Promise<Record<string, unknown>> {
  const result = await repository.pool.query<Record<string, unknown>>(
    `SELECT t.status, t.attempt, t.error_code, t.created_at, t.completed_at, t.trace_id,
            ta.root_observation_id, ta.plan_json, ta.draft_goal_json, ta.draft_dialogue_json, ta.draft_working_set_json, ta.draft_json,
            ar.outcome, ar.rendered_text, ae.envelope_json, cl.ledger_json
       FROM interec_agent.turns t
       LEFT JOIN interec_agent.turn_attempts ta ON ta.turn_id = t.id AND ta.attempt = t.attempt
       LEFT JOIN interec_agent.assistant_responses ar ON ar.turn_id = t.id
       LEFT JOIN interec_agent.assistant_envelopes ae ON ae.response_id = ar.id
       LEFT JOIN interec_agent.claim_ledgers cl ON cl.response_id = ar.id
      WHERE t.id = $1`,
    [turnId],
  );
  const tools = await repository.pool.query<Record<string, unknown>>(
    `SELECT step_key, status, request_json, result_json, error_code
       FROM interec_agent.tool_executions WHERE turn_id = $1 ORDER BY created_at, step_key`,
    [turnId],
  );
  const searchResults = await repository.pool.query<Record<string, unknown>>(
    `SELECT rw.wave_no, rw.status AS wave_status, rw.coverage_json, rw.top_reason_code,
            ms.market, ms.status AS market_status, ms.result_count, ms.error_code
       FROM interec_agent.research_waves rw
       LEFT JOIN interec_agent.market_searches ms ON ms.research_wave_id = rw.id
      WHERE rw.turn_id = $1 ORDER BY rw.wave_no, ms.market`,
    [turnId],
  );
  const eligibilityResults = await repository.pool.query<Record<string, unknown>>(
    `SELECT oq.status, oq.reason_codes, count(*)::int AS count
       FROM interec_agent.offer_qualifications oq
      WHERE oq.turn_id = $1 GROUP BY oq.status, oq.reason_codes ORDER BY oq.status, oq.reason_codes::text`,
    [turnId],
  );
  const planReviews = await repository.pool.query<Record<string, unknown>>(
    `SELECT proposal_number, decision, policy_version, violations_json, proposal_json, reviewed_plan_json
       FROM interec_agent.turn_plan_reviews
      WHERE turn_id = $1 ORDER BY attempt, proposal_number`,
    [turnId],
  );
  return {
    ...(result.rows[0] ?? { status: "MISSING" }),
    toolExecutions: tools.rows,
    search: searchResults.rows,
    eligibilityCounts: eligibilityResults.rows,
    planReviews: planReviews.rows,
  };
}

function assertModelProviderAvailable(turnEvidence: Array<Record<string, unknown>>): void {
  for (const evidence of turnEvidence) {
    const draft = evidence["draft_json"];
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) continue;
    const code = developmentEvaluationModelFailureCode((draft as Record<string, unknown>)["fallbackReasonCode"]);
    if (code) throw new Error(`DEVELOPMENT_EVAL_${code}`);
  }
}

export class DevelopmentEvaluationTrialExecutor {
  public constructor(
    private readonly repository: PostgresConversationRepository,
    private readonly fixture: ReplayProviderFixture,
    private readonly pi: PiModelRuntime,
    private readonly options: DevelopmentEvaluationTrialExecutorOptions = {},
  ) {}

  private createWorker(
    repository: ConversationRepository,
    productPort: ProductSearchPort,
    fxPort: FxPort,
    suffix: string,
    traceCorrelation?: AgentTraceCorrelation,
  ): ConversationWorker {
    return new ConversationWorker(
      repository,
      new PostgresConversationSearchRepository(this.repository.pool),
      new PostgresProviderCallController(this.repository.pool),
      productPort,
      fxPort,
      this.pi,
      {
        workerId: `development-eval-${suffix}-${randomUUID()}`,
        leaseSeconds: 60,
        heartbeatSeconds: 10,
        ...(this.options.promptLink ? { promptLink: this.options.promptLink } : {}),
        ...(traceCorrelation ? {
          traceCorrelation: (turn) => {
            const turnIndex = Number(/-turn-(\d+)$/u.exec(turn.clientTurnId)?.[1] ?? 0);
            return { ...traceCorrelation, ...(turnIndex > 0 ? { turnIndex } : {}) };
          },
        } : {}),
      },
    );
  }

  private async resetCallControllerState(): Promise<void> {
    await this.repository.pool.query(
      `UPDATE interec_agent.provider_permits
          SET status = 'EXPIRED', completed_at = clock_timestamp(), error_code = 'DEVELOPMENT_EVAL_TRIAL_ENDED'
        WHERE tenant_id LIKE 'development-eval-%' AND status = 'ACTIVE'`,
    );
    await this.repository.pool.query(
      `UPDATE interec_agent.provider_circuits
          SET consecutive_failures = 0, open_until = NULL, updated_at = clock_timestamp()
        WHERE provider IN ('buywhere', 'fxratesapi')`,
    );
  }

  public async execute(
    testCase: DevelopmentEvaluationCase,
    runIndex: number,
    experimentTrace?: EvaluationExperimentTraceContext,
  ): Promise<DevelopmentEvaluationTrialArtifact> {
    if (!Number.isSafeInteger(runIndex) || runIndex < 1) throw new Error("DEVELOPMENT_EVAL_RUN_INDEX_INVALID");
    await this.resetCallControllerState();
    const trialId = `${testCase.taskId}-run-${runIndex}`;
    const traceCorrelation: AgentTraceCorrelation = {
      trialId,
      taskId: testCase.taskId,
      runIndex,
      ...(experimentTrace ?? {}),
    };
    const trialStartedAt = new Date().toISOString();
    const productReplay = new ReplayProductSearchPort(this.fixture.productSearch);
    const frozenFx = new ReplayFxPort(this.fixture.fx);
    const fxReplay: FxPort = {
      async getRate(base, signal) {
        const snapshot = await frozenFx.getRate(base, signal);
        return { ...snapshot, id: randomUUID() };
      },
    };
    const queryAliases: Array<{ actualQuery: string; fixtureQuery: string; market: string }> = [];
    const providerBarrier = testCase.environmentAction === "INTERRUPT_DURING_PROVIDER" ? barrier() : undefined;
    const commitBarrier = testCase.environmentAction === "INTERRUPT_BEFORE_COMMIT" ? barrier() : undefined;
    const productPort = evaluationProductSearchPort(productReplay, testCase.fixtureSeed, testCase.environmentAction, queryAliases, providerBarrier);
    const owner = { tenantId: `development-eval-${randomUUID()}`, ownerId: "development-evaluator" };
    const conversation = await this.repository.createConversation(owner);
    const acceptEvaluationTurn = async (input: AcceptConversationTurnInput) => {
      const telemetryTraceId = telemetryTraceIdForTurn(input.conversationId, input.clientTurnId);
      return observeTurnEnqueue({
        traceId: telemetryTraceId,
        conversationId: input.conversationId,
        tenantId: input.owner.tenantId,
        ownerId: input.owner.ownerId,
        operation: "accept_turn",
        inputType: input.input.type,
      }, (active) => this.repository.acceptTurn({
        ...input,
        telemetryTraceId,
        ...(active.rootObservationId ? { telemetryRootObservationId: active.rootObservationId } : {}),
      }));
    };
    const turnEvidence: Array<Record<string, unknown>> = [];
    const turnIds: string[] = [];
    const collectOutstandingTurnEvidence = async (): Promise<void> => {
      while (turnEvidence.length < turnIds.length) turnEvidence.push(await collectTurnEvidence(this.repository, turnIds[turnEvidence.length]!));
    };
    let worker = this.createWorker(commitBarrierRepository(this.repository, commitBarrier), productPort, fxReplay, "worker", traceCorrelation);
    try {
      if (testCase.environmentAction.startsWith("INTERRUPT_")) {
        const first = await acceptEvaluationTurn({
          conversationId: conversation.id,
          owner,
          clientTurnId: `${trialId}-turn-1`,
          expectedRevision: 0,
          input: { type: "MESSAGE", content: testCase.userTurns[0]! },
          deadlineSeconds: 180,
        });
        turnIds.push(first.id);
        let oldRun: Promise<boolean> | null = null;
        if (testCase.environmentAction !== "INTERRUPT_WITH_MESSAGE_BATCH") {
          oldRun = worker.runOnce(first.id);
          await reachedBeforeRunEnds((providerBarrier ?? commitBarrier)!.reached, oldRun, testCase.environmentAction);
        }
        const second = await acceptEvaluationTurn({
          conversationId: conversation.id,
          owner,
          clientTurnId: `${trialId}-turn-2`,
          expectedRevision: 0,
          input: { type: "MESSAGE", content: testCase.userTurns[1]! },
          deadlineSeconds: 180,
        });
        turnIds.push(second.id);
        providerBarrier?.release();
        commitBarrier?.release();
        if (oldRun) await oldRun;
        worker = this.createWorker(this.repository, productPort, fxReplay, "recovery", traceCorrelation);
        await worker.runOnce(second.id);
        await collectOutstandingTurnEvidence();
        assertModelProviderAvailable(turnEvidence);
      } else {
        for (const [turnOffset, content] of testCase.userTurns.entries()) {
          const projectionBefore = await this.repository.getProjection(conversation.id, owner);
          if (!projectionBefore) throw new Error("DEVELOPMENT_EVAL_PROJECTION_MISSING");
          const focusOfferRef = turnOffset > 0 && testCase.focusDisplayRank !== undefined
            ? projectionBefore.state.workingSet?.displayOfferRefs[testCase.focusDisplayRank - 1]
            : undefined;
          const accepted = await acceptEvaluationTurn({
            conversationId: conversation.id,
            owner,
            clientTurnId: `${trialId}-turn-${turnOffset + 1}`,
            expectedRevision: projectionBefore.conversation.currentRevision,
            input: { type: "MESSAGE", content, ...(focusOfferRef ? { focusOfferRef } : {}) },
            deadlineSeconds: 180,
          });
          turnIds.push(accepted.id);
          if (turnOffset > 0 && /WORKER_RESTART/u.test(testCase.environmentAction)) {
            worker = this.createWorker(this.repository, productPort, fxReplay, "restarted", traceCorrelation);
          }
          await worker.runOnce(accepted.id);
          const completed = await this.repository.getTurn(accepted.id, owner);
          if (!completed || (completed.status !== "COMPLETED" && completed.status !== "FAILED")) throw new Error(`DEVELOPMENT_EVAL_TURN_NOT_TERMINAL:${accepted.id}`);
          if (completed.status === "FAILED") throw new Error(`DEVELOPMENT_EVAL_TURN_FAILED:${completed.errorCode ?? "UNKNOWN"}`);
          await collectOutstandingTurnEvidence();
          assertModelProviderAvailable(turnEvidence);
        }
      }
      await collectOutstandingTurnEvidence();
      return {
        trialId,
        taskId: testCase.taskId,
        runIndex,
        status: "COMPLETED",
        environmentAction: testCase.environmentAction,
        userTurns: testCase.userTurns,
        turnIds,
        turnEvidence,
        finalState: (await this.repository.getProjection(conversation.id, owner))?.state ?? null,
        replayCalls: productReplay.calls,
        queryAliases,
        startedAt: trialStartedAt,
        completedAt: new Date().toISOString(),
        failure: null,
        traceCorrelation,
      };
    } catch (error) {
      providerBarrier?.release();
      commitBarrier?.release();
      await collectOutstandingTurnEvidence();
      return {
        trialId,
        taskId: testCase.taskId,
        runIndex,
        status: "FAILED",
        environmentAction: testCase.environmentAction,
        userTurns: testCase.userTurns,
        turnIds,
        turnEvidence,
        finalState: (await this.repository.getProjection(conversation.id, owner))?.state ?? null,
        replayCalls: productReplay.calls,
        queryAliases,
        startedAt: trialStartedAt,
        completedAt: new Date().toISOString(),
        failure: error instanceof Error ? error.message : "UNKNOWN",
        traceCorrelation,
      };
    }
  }
}
