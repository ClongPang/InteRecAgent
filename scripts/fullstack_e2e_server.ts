import { createHash } from "node:crypto";

import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  ConversationWorker,
  PostgresConversationRepository,
  PostgresConversationSearchRepository,
  PostgresProviderCallController,
  runConversationMigrations,
  verifyConversationSchema,
  type CommitConversationTurnInput,
  type FinalCommitResult,
  type FxPort,
  type ProductSearchPort,
} from "@interec/runtime";

import { createConversationApp, HmacJwtIdentityVerifier } from "../packages/api/src/index.js";

const AUTH_SECRET = "interec-fullstack-e2e-secret-0123456789abcdef";
const AUTH_ISSUER = "interec-fullstack-e2e";
const AUTH_AUDIENCE = "interec-fullstack-browser";
const TEST_TENANT_PREFIX = "browser-e2e-";

type Scenario =
  | "coverage"
  | "clarification-search"
  | "retry-after-commit-failure"
  | "sse-recovery";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requireIsolatedTestDatabase(connectionString: string): void {
  const database = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//u, ""));
  if (database !== "interec_test") {
    throw new Error(`FULLSTACK_E2E_REQUIRES_INTEREC_TEST_DATABASE:${database || "missing"}`);
  }
}

function coverageResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
      userIntentSummary: "inspect the latest durable search coverage",
      ops: [{ opId: "coverage", kind: "INSPECT_SEARCH_COVERAGE" }],
      leftover: [],
    })),
    fauxAssistantMessage(fauxToolCall("publish_reply", {
      outcome: "CHAT",
      blocks: [{ type: "TRANSITION", transitionCode: "CHECKED_PREMISE" }],
      nextMoves: [],
    })),
  ];
}

function retryAfterCommitFailureResponses() {
  const [plan, firstPublish] = coverageResponses();
  const [, secondPublish] = coverageResponses();
  const [, thirdPublish] = coverageResponses();
  return [plan!, firstPublish!, secondPublish!, thirdPublish!, ...coverageResponses()];
}

function clarificationResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("commit_turn_plan", {
      userIntentSummary: "record the known headphone goal and ask which purchase markets to compare",
      ops: [
        {
          opId: "target",
          kind: "GOAL_SET_TARGET",
          sourceMessageOrdinal: 0,
          target: {
            categoryId: "headphones",
            canonicalModel: null,
            itemRole: "PRIMARY_PRODUCT",
            condition: "ANY",
          },
        },
        {
          opId: "budget",
          kind: "GOAL_SET_BUDGET",
          sourceMessageOrdinal: 0,
          budget: { amount: "2500", currency: "CNY" },
        },
        {
          opId: "market-question",
          kind: "REQUEST_CLARIFICATION",
          clarification: { kind: "PURCHASE_MARKET" },
          uncertainty: { type: "MISSING_USER_INFORMATION", userResolvable: true },
          reasonCode: "MISSING_REQUIRED_GOAL_FIELD",
        },
      ],
      leftover: [],
    })),
    fauxAssistantMessage(fauxToolCall("publish_reply", {
      outcome: "CLARIFICATION",
      blocks: [{ type: "QUESTION", clarification: { kind: "PURCHASE_MARKET" } }],
      nextMoves: [],
    })),
  ];
}

class FullstackE2ERepository extends PostgresConversationRepository {
  private injectCommitFailure = false;
  private faultTurnId: string | null = null;
  private injectedFailures = 0;

  public prepareScenario(scenario: Scenario): void {
    this.injectCommitFailure = scenario === "retry-after-commit-failure";
    this.faultTurnId = null;
    this.injectedFailures = 0;
  }

  public faultStatus(): { turnId: string | null; injectedFailures: number } {
    return { turnId: this.faultTurnId, injectedFailures: this.injectedFailures };
  }

  public override async commitTurn(input: CommitConversationTurnInput): Promise<FinalCommitResult | null> {
    if (this.injectCommitFailure) {
      this.faultTurnId ??= input.turnId;
      if (input.turnId === this.faultTurnId) {
        this.injectedFailures += 1;
        throw Object.assign(new Error("E2E_INJECTED_COMMIT_FAILURE"), { code: "E2E_INJECTED_COMMIT_FAILURE" });
      }
    }
    return super.commitTurn(input);
  }
}

function deterministicProductSource(): ProductSearchPort {
  return {
    search: async (query, market) => {
      const products = market === "US"
        ? [{
            id: "us-sony-wh1000xm5",
            title: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
            price: { amount: "299", currency: "USD" },
            merchant: "US Audio",
            url: "https://audio.example.com/sony-wh1000xm5",
            country_code: "US",
            category_path: ["Portable Audio", "Headphones"],
            availability: "in_stock",
          }]
        : [{
            id: "sg-bose-quietcomfort-ultra",
            title: "Bose QuietComfort Ultra Noise Cancelling Headphones",
            price: { amount: "399", currency: "SGD" },
            merchant: "SG Audio",
            url: "https://audio.example.sg/bose-quietcomfort-ultra",
            country_code: "SG",
            category_path: ["Electronics", "Headphones"],
            availability: "in_stock",
          }];
      const rawPayload = { data: products };
      return {
        market,
        products,
        artifactRef: `sha256:${createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex")}`,
        rawPayload,
        observedAt: "2026-08-31T08:00:00.000Z",
      };
    },
  };
}

function deterministicFxSource(): FxPort {
  return {
    getRate: async (base) => ({
      id: base === "USD"
        ? "11111111-1111-4111-8111-111111111111"
        : base === "SGD"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      base,
      quote: "CNY",
      rate: base === "USD" ? "7.2" : base === "SGD" ? "5.4" : "1",
      provider: "fullstack-e2e",
      observedAt: "2026-08-31T08:00:00.000Z",
      expiresAt: "2026-09-01T08:00:00.000Z",
    }),
  };
}

async function cleanTestConversations(repository: PostgresConversationRepository): Promise<void> {
  await repository.pool.query(
    "UPDATE interec_agent.conversations SET active_turn_id = NULL WHERE tenant_id LIKE $1",
    [`${TEST_TENANT_PREFIX}%`],
  );
  await repository.pool.query(
    "DELETE FROM interec_agent.conversations WHERE tenant_id LIKE $1",
    [`${TEST_TENANT_PREFIX}%`],
  );
}

if (process.env["RUN_FULLSTACK_E2E"] !== "1") throw new Error("RUN_FULLSTACK_E2E_REQUIRED");
const databaseUrl = required("INTEREC_DATABASE_URL");
requireIsolatedTestDatabase(databaseUrl);

const repository = new FullstackE2ERepository(databaseUrl, 8);
await runConversationMigrations(repository.pool);
await cleanTestConversations(repository);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const worker = new ConversationWorker(
  repository,
  new PostgresConversationSearchRepository(repository.pool),
  new PostgresProviderCallController(repository.pool),
  deterministicProductSource(),
  deterministicFxSource(),
  { model: faux.getModel(), streamFn: models.streamSimple.bind(models), apiKey: "fullstack-e2e" },
  { workerId: "browser-fullstack-e2e", leaseSeconds: 5, heartbeatSeconds: 1 },
);

const app = createConversationApp({
  repository,
  identityVerifier: new HmacJwtIdentityVerifier({
    secret: AUTH_SECRET,
    issuer: AUTH_ISSUER,
    audience: AUTH_AUDIENCE,
  }),
  ssePollMs: 20,
  sseMaxDurationMs: 300,
  readiness: async () => {
    const client = await repository.pool.connect();
    try {
      await verifyConversationSchema(client);
    } finally {
      client.release();
    }
  },
});

app.post("/__e2e/scenarios/:scenario", async (request, reply) => {
  const scenario = String((request.params as { scenario?: string }).scenario ?? "") as Scenario;
  const allowed: readonly Scenario[] = ["coverage", "clarification-search", "retry-after-commit-failure", "sse-recovery"];
  if (!allowed.includes(scenario)) return reply.status(404).send({ error: { code: "E2E_SCENARIO_NOT_FOUND" } });
  repository.prepareScenario(scenario);
  faux.setResponses(scenario === "clarification-search"
    ? clarificationResponses()
    : scenario === "retry-after-commit-failure"
      ? retryAfterCommitFailureResponses()
      : coverageResponses());
  return { scenario, ready: true };
});

app.get("/__e2e/fault-status", async () => repository.faultStatus());

await app.listen({ host: "127.0.0.1", port: 8081 });

let stopping = false;
const workerLoop = (async () => {
  while (!stopping) {
    const worked = await worker.runOnce();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 20));
  }
})();

let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopping = true;
  await workerLoop;
  await app.close();
  await cleanTestConversations(repository);
  await repository.close();
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
