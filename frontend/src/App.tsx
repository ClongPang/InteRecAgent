import { Fragment, FormEvent, useEffect, useMemo, useState } from "react";
import { apiClient, createFeedbackRequest, type ApiClient } from "./api/client";
import {
  evaluationFixture,
  feedbackUpdatedFixture,
  recommendationFixture
} from "./test/fixtures/chat";
import type {
  CatalogReadinessResponse,
  ChatRequest,
  ChatTurnResponse,
  EvaluationDatasetReadinessResponse,
  ProductRecommendation,
  ProfileReadinessResponse,
  ReplayResult,
  SessionState,
  SystemReadinessResponse,
  VectorIndexReadinessResponse
} from "./types/contracts";
import "./App.css";

interface AppProps {
  client?: ApiClient;
  initialTurn?: ChatTurnResponse;
  path?: string;
}

const loadingLabels = [
  "Understanding request",
  "Checking catalog",
  "Verifying constraints",
  "Ranking candidates",
  "Preparing answer"
];

function formatPrice(product: ProductRecommendation) {
  if (product.price === null || product.price === undefined) {
    return "Price unknown";
  }
  return `${product.currency ?? "USD"} ${product.price.toFixed(2)}`;
}

function ProductCard({ product, onFeedback, onInspect }: {
  product: ProductRecommendation;
  onFeedback: (text: string, type: string, productId: string) => void;
  onInspect: (product: ProductRecommendation) => void;
}) {
  const hasEvidence = product.evidence.length > 0;
  const [customFeedback, setCustomFeedback] = useState("");

  function submitCustomFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = customFeedback.trim();
    if (!trimmed) {
      return;
    }
    onFeedback(trimmed, "generic", product.product_id);
    setCustomFeedback("");
  }

  return (
    <article className="product-card" aria-label={`Recommendation ${product.rank}: ${product.title}`}>
      <div className="image-fallback" aria-label="Product image fallback">
        {product.brand?.slice(0, 2).toUpperCase() ?? "IR"}
      </div>
      <div className="product-content">
        <div className="product-heading">
          <span className={`status ${product.constraint_status}`}>{product.constraint_status}</span>
          <span>Rank {product.rank}</span>
        </div>
        <h3>{product.title}</h3>
        <p className="price">{formatPrice(product)}</p>
        <p>{product.rank_reason}</p>
        <div className="tag-row">
          {product.matched_tags.map((tag) => (
            <span className="tag" key={tag}>{tag}</span>
          ))}
        </div>
        <section aria-label="Evidence">
          <h4>Evidence</h4>
          {hasEvidence ? (
            product.evidence.map((item) => <p key={item.text}>{item.text}</p>)
          ) : (
            <p className="warning">Evidence missing</p>
          )}
        </section>
        {product.uncertainties.length > 0 && (
          <section aria-label="Uncertainties">
            <h4>Uncertainties</h4>
            <ul>
              {product.uncertainties.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        )}
        <div className="actions">
          <button type="button" onClick={() => onInspect(product)}>
            View evidence
          </button>
          <button type="button" onClick={() => onFeedback("Too expensive", "price", product.product_id)}>
            Show cheaper
          </button>
          <button type="button" onClick={() => onFeedback("Avoid this brand", "brand", product.product_id)}>
            Avoid brand
          </button>
          <button type="button" onClick={() => onFeedback("Need something more portable", "portable", product.product_id)}>
            More portable
          </button>
        </div>
        <form className="custom-feedback" onSubmit={submitCustomFeedback}>
          <label htmlFor={`custom-feedback-${product.product_id}`}>
            Custom feedback
          </label>
          <input
            id={`custom-feedback-${product.product_id}`}
            value={customFeedback}
            onChange={(event) => setCustomFeedback(event.target.value)}
            placeholder="Tell us what to adjust"
          />
          <button type="submit" disabled={customFeedback.trim().length === 0}>
            Send feedback
          </button>
        </form>
      </div>
    </article>
  );
}

function ProductEvidenceDrawer({ product, onClose, loading = false, error = "" }: {
  product: ProductRecommendation | null;
  onClose: () => void;
  loading?: boolean;
  error?: string;
}) {
  if (!product) {
    return null;
  }
  return (
    <aside className="drawer" aria-label="Product evidence drawer">
      <div className="drawer-header">
        <h2>{product.title}</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {loading && <p className="warning" role="status">Loading full product facts...</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <dl>
        <dt>Brand</dt>
        <dd>{product.brand ?? "unknown"}</dd>
        <dt>Price</dt>
        <dd>{formatPrice(product)}</dd>
        <dt>Constraint status</dt>
        <dd>{product.constraint_status}</dd>
      </dl>
      <section>
        <h3>Evidence</h3>
        {product.evidence.length > 0 ? (
          product.evidence.map((item) => <p key={item.text}>{item.text}</p>)
        ) : (
          <p className="warning">Evidence missing</p>
        )}
      </section>
      <section>
        <h3>Unknown fields</h3>
        {product.uncertainties.length > 0 ? (
          <ul>{product.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul>
        ) : (
          <p>No unknown fields in the current payload.</p>
        )}
      </section>
      {product.claim_evidence && product.claim_evidence.length > 0 && (
        <section aria-label="Claim evidence">
          <h3>Claim evidence</h3>
          <ul>
            {product.claim_evidence.map((claim) => (
              <li key={claim.claim}>
                {claim.supported ? "Supported" : "Unsupported"}: {claim.claim}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function WorkflowPanel({ turn }: { turn: ChatTurnResponse }) {
  const summary = turn.trace_summary;
  return (
    <aside className="workflow-panel" aria-label="Agent workflow panel">
      <h2>Agent Workflow</h2>
      <dl>
        <dt>Task</dt>
        <dd>{summary.task_type}</dd>
        <dt>Intent</dt>
        <dd>{String(summary.intent_summary.category ?? (turn.intent_state.category || "unknown"))}</dd>
        <dt>Clarification</dt>
        <dd>{summary.clarification_decision.should_clarify ? "Question needed" : "No clarification"}</dd>
        <dt>Retrieved</dt>
        <dd>{summary.retrieved_count}</dd>
        <dt>Filtered</dt>
        <dd>{summary.filtered_count}</dd>
        <dt>Evidence</dt>
        <dd>{summary.evidence_sources.join(", ") || "unknown"}</dd>
      </dl>
      {summary.warnings.length > 0 && (
        <div className="warning" role="note">
          {summary.warnings.join(" ")}
        </div>
      )}
    </aside>
  );
}

function ClarificationBox({ turn, onAnswer }: {
  turn: ChatTurnResponse;
  onAnswer: (message: string) => void;
}) {
  const [freeAnswer, setFreeAnswer] = useState("");
  if (!turn.clarification) {
    return null;
  }
  function submitFreeAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (freeAnswer.trim()) {
      onAnswer(freeAnswer.trim());
      setFreeAnswer("");
    }
  }
  return (
    <section className="notice" aria-label="Clarification prompt">
      <h3>{turn.clarification.question}</h3>
      <div className="actions">
        {turn.clarification.options.map((option) => (
          <button type="button" key={option} onClick={() => onAnswer(option)}>
            {option}
          </button>
        ))}
        <button type="button" onClick={() => onAnswer("recommend anyway")}>
          Recommend anyway
        </button>
        {turn.clarification.allow_skip && (
          <button type="button" onClick={() => onAnswer("skip clarification")}>
            Skip
          </button>
        )}
      </div>
      {turn.clarification.allow_free_answer && (
        <form className="clarification-answer" onSubmit={submitFreeAnswer}>
          <label htmlFor="clarification-answer">Clarification answer</label>
          <input
            id="clarification-answer"
            value={freeAnswer}
            onChange={(event) => setFreeAnswer(event.target.value)}
            placeholder="Type your own answer"
          />
          <button type="submit" disabled={freeAnswer.trim().length === 0}>
            Submit answer
          </button>
        </form>
      )}
    </section>
  );
}

function UnsupportedBox({ turn }: { turn: ChatTurnResponse }) {
  if (!turn.unsupported) {
    return null;
  }
  return (
    <section className="notice" aria-label="Unsupported request">
      <h3>Catalog recommendations are still available</h3>
      <p>{turn.unsupported.reason}</p>
      <p>Cannot do: {turn.unsupported.cannot_do.join(", ")}</p>
    </section>
  );
}

function TurnStatusNotice({ turn }: { turn: ChatTurnResponse }) {
  if (turn.status === "partial_support") {
    return (
      <section className="notice" aria-label="Partial support">
        <h3>Some details are limited</h3>
        <p>{turn.message}</p>
      </section>
    );
  }
  if (turn.status === "error") {
    return (
      <section className="notice error" aria-label="Recommendation error">
        <h3>Recommendation could not be completed</h3>
        <p>{turn.message}</p>
      </section>
    );
  }
  return null;
}

function WhatChanged({ turn }: { turn: ChatTurnResponse }) {
  if (!turn.trace_summary.feedback_update) {
    return null;
  }
  return (
    <section className="notice" aria-label="What changed">
      <h3>What changed</h3>
      <p>Feedback type: {String(turn.trace_summary.feedback_update.feedback_type)}</p>
      <p>Price sensitivity: {turn.intent_state.price_sensitivity || "unchanged"}</p>
    </section>
  );
}

function SessionRestore({
  session,
  sessionId,
  status,
  error,
  onSessionIdChange,
  onLoad
}: {
  session: SessionState | null;
  sessionId: string;
  status: "idle" | "loading" | "error";
  error: string;
  onSessionIdChange: (sessionId: string) => void;
  onLoad: () => void;
}) {
  function submitSessionLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onLoad();
  }

  return (
    <section className="session-restore" aria-label="Session restore">
      <form onSubmit={submitSessionLookup}>
        <label htmlFor="session-id">Session ID</label>
        <input
          id="session-id"
          value={sessionId}
          onChange={(event) => onSessionIdChange(event.target.value)}
          placeholder="sess_demo"
        />
        <button type="submit" disabled={status === "loading" || sessionId.trim().length === 0}>
          Load session
        </button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {session && (
        <dl aria-label="Session summary">
          <dt>Session</dt>
          <dd>{session.session_id}</dd>
          <dt>Messages</dt>
          <dd>{session.messages.length}</dd>
          <dt>Intent</dt>
          <dd>{session.current_intent.category || "unknown"}</dd>
        </dl>
      )}
    </section>
  );
}

function ProductComparisonTable({ products }: { products: ProductRecommendation[] }) {
  const comparisonProducts = products.slice(0, 4);
  if (comparisonProducts.length < 2) {
    return null;
  }
  const suggestedProduct = comparisonProducts[0];
  return (
    <section className="comparison" aria-label="Product comparison">
      <h2>Comparison</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Price</th>
            <th scope="col">Constraint</th>
            <th scope="col">Evidence</th>
            <th scope="col">Unknowns</th>
            <th scope="col">Suggested</th>
          </tr>
        </thead>
        <tbody>
          {comparisonProducts.map((product) => (
            <tr key={product.product_id}>
              <th scope="row">{product.title}</th>
              <td>{formatPrice(product)}</td>
              <td>{product.constraint_status}</td>
              <td>{product.evidence.length > 0 ? `${product.evidence.length} source` : "Evidence missing"}</td>
              <td>{product.uncertainties.length > 0 ? product.uncertainties.join(", ") : "None"}</td>
              <td>{product.product_id === suggestedProduct.product_id ? "Suggested choice" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ConsumerWorkspace({ client, initialTurn }: Required<Pick<AppProps, "client" | "initialTurn">>) {
  const [turn, setTurn] = useState(initialTurn);
  const [healthLabel, setHealthLabel] = useState("Checking API");
  const [healthStatus, setHealthStatus] = useState<"checking" | "ok" | "error">("checking");
  const [draft, setDraft] = useState("Show me something similar but cheaper");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [error, setError] = useState("");
  const [retryRequest, setRetryRequest] = useState<ChatRequest | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<ProductRecommendation | null>(null);
  const [drawerStatus, setDrawerStatus] = useState<"idle" | "loading" | "error">("idle");
  const [drawerError, setDrawerError] = useState("");
  const [sessionInput, setSessionInput] = useState(initialTurn.session_id);
  const [sessionSummary, setSessionSummary] = useState<SessionState | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"idle" | "loading" | "error">("idle");
  const [sessionError, setSessionError] = useState("");

  useEffect(() => {
    let isMounted = true;
    client
      .getHealth()
      .then((health) => {
        if (isMounted) {
          setHealthLabel(`${health.service} · ${health.status}`);
          setHealthStatus("ok");
        }
      })
      .catch(() => {
        if (isMounted) {
          setHealthLabel("API status unavailable");
          setHealthStatus("error");
        }
      });
    return () => {
      isMounted = false;
    };
  }, [client]);

  async function submitChatRequest(request: ChatRequest, options: { clearDraftOnSuccess?: boolean } = {}) {
    setStatus("submitting");
    setError("");
    setRetryRequest(request);
    try {
      const nextTurn = await client.chat(request);
      setTurn(nextTurn);
      if (options.clearDraftOnSuccess) {
        setDraft("");
      }
      setStatus("idle");
      setRetryRequest(null);
    } catch {
      setStatus("error");
      setError("We could not finish this recommendation. Try again.");
    }
  }

  async function submitMessage(message: string) {
    await submitChatRequest(
      { session_id: turn.session_id, message },
      { clearDraftOnSuccess: true }
    );
  }

  async function submitFeedback(text: string, type: string, productId: string) {
    await submitChatRequest(createFeedbackRequest(turn, text, type, productId));
  }

  async function retryLastRequest() {
    if (retryRequest) {
      await submitChatRequest(retryRequest, { clearDraftOnSuccess: retryRequest.feedback_text == null });
    }
  }

  async function inspectProduct(product: ProductRecommendation) {
    setSelectedProduct(product);
    setDrawerStatus("loading");
    setDrawerError("");
    try {
      setSelectedProduct(await client.getProduct(product.product_id));
      setDrawerStatus("idle");
    } catch {
      setDrawerStatus("error");
      setDrawerError("Full product facts could not be loaded. Showing current recommendation facts.");
    }
  }

  function closeDrawer() {
    setSelectedProduct(null);
    setDrawerStatus("idle");
    setDrawerError("");
  }

  async function loadSessionSummary() {
    const nextSessionId = sessionInput.trim();
    if (!nextSessionId) {
      return;
    }
    setSessionStatus("loading");
    setSessionError("");
    try {
      setSessionSummary(await client.getSession(nextSessionId));
      setSessionStatus("idle");
    } catch {
      setSessionSummary(null);
      setSessionStatus("error");
      setSessionError("Session summary could not be loaded.");
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(draft);
  }

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="Shopping workspace">
        <div className="chat-results">
          <header>
            <p className="eyebrow">Catalog-backed shopping assistant</p>
            <h1>InteRecAgent</h1>
            <p className={`system-status ${healthStatus}`} aria-label="System status">
              {healthLabel}
            </p>
            <SessionRestore
              session={sessionSummary}
              sessionId={sessionInput}
              status={sessionStatus}
              error={sessionError}
              onSessionIdChange={setSessionInput}
              onLoad={loadSessionSummary}
            />
          </header>
          <section className="thread" aria-label="Chat thread">
            <div className="bubble user">I need wireless headphones under $100 for commuting.</div>
            <div className="bubble assistant">{turn.message}</div>
          </section>
          {status === "submitting" && (
            <section className="loading" aria-label="Loading pipeline">
              {loadingLabels.map((label) => <span key={label}>{label}</span>)}
            </section>
          )}
          {error && (
            <div className="error" role="alert">
              <p>{error}</p>
              <button type="button" onClick={retryLastRequest} disabled={status === "submitting" || !retryRequest}>
                Retry
              </button>
            </div>
          )}
          <ClarificationBox turn={turn} onAnswer={submitMessage} />
          <UnsupportedBox turn={turn} />
          <TurnStatusNotice turn={turn} />
          <WhatChanged turn={turn} />
          <section className="product-list" aria-label="Recommendation results">
            {turn.products.length > 0 ? (
              turn.products.map((product) => (
                <ProductCard
                  key={product.product_id}
                  product={product}
                  onFeedback={submitFeedback}
                  onInspect={inspectProduct}
                />
              ))
            ) : (
              <div className="empty-state" role="status">
                No recommendations to show yet.
              </div>
            )}
          </section>
          <ProductComparisonTable products={turn.products} />
          <ProductEvidenceDrawer
            product={selectedProduct}
            loading={drawerStatus === "loading"}
            error={drawerError}
            onClose={closeDrawer}
          />
          <form className="composer" onSubmit={onSubmit}>
            <label htmlFor="message">Message</label>
            <input
              id="message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask for a recommendation or give feedback"
            />
            <button type="submit" disabled={status === "submitting" || draft.trim().length === 0}>
              Send
            </button>
          </form>
        </div>
        <WorkflowPanel turn={turn} />
      </section>
    </main>
  );
}

function InternalTrace({ client }: { client: ApiClient }) {
  const [trace, setTrace] = useState<Record<string, unknown> | null>(null);
  const [turnInput, setTurnInput] = useState("turn_001");
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void loadTrace("turn_001");
  }, [client]);

  async function loadTrace(turnId: string) {
    setError("");
    setReplay(null);
    try {
      const nextTrace = await client.getInternalTrace(turnId);
      setTrace(nextTrace as unknown as Record<string, unknown>);
      setTurnInput(turnId);
    } catch {
      setError("Trace could not be loaded.");
    }
  }

  function submitTraceLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const turnId = turnInput.trim();
    if (turnId) {
      void loadTrace(turnId);
    }
  }

  async function replayCurrentTurn() {
    const turnId = String(trace?.turn_id ?? "turn_001");
    setError("");
    try {
      setReplay(await client.replayTurn(turnId));
    } catch {
      setError("Replay could not be run.");
    }
  }

  const traceErrors = Array.isArray(trace?.errors)
    ? (trace.errors as Array<Record<string, unknown>>)
    : [];

  return (
    <main className="internal-page">
      <h1>Internal Trace Console</h1>
      {error && <p role="alert">{error}</p>}
      <form className="trace-selector" aria-label="Trace selector" onSubmit={submitTraceLookup}>
        <label htmlFor="trace-turn-id">Turn ID</label>
        <input
          id="trace-turn-id"
          value={turnInput}
          onChange={(event) => setTurnInput(event.target.value)}
          placeholder="turn_001"
        />
        <button type="submit" disabled={turnInput.trim().length === 0}>
          Load trace
        </button>
      </form>
      <p>Turn: {String(trace?.turn_id ?? "loading")}</p>
      <button type="button" onClick={replayCurrentTurn} disabled={!trace}>
        Replay turn
      </button>
      {replay && (
        <section aria-label="Replay result" className="notice">
          <h2>Replay result</h2>
          <p>{replay.replayed ? "Replay completed" : "Trace missing"}</p>
          <p>Stages: {replay.stages.join(" -> ")}</p>
        </section>
      )}
      {trace && (
        <section aria-label="Trace stages" className="stage-list">
          {[
            ["Task route", trace.task_route],
            ["Intent", trace.intent_after],
            ["Retrieval", trace.retrieval],
            ["Filtering", trace.filtering],
            ["Validation", trace.final_validation],
            ["Response", trace.response],
          ].map(([label, value]) => (
            <article className="stage-item" key={String(label)}>
              <h2>{String(label)}</h2>
              <code>{JSON.stringify(value)}</code>
            </article>
          ))}
        </section>
      )}
      {trace && (
        <section aria-label="Trace errors" className="notice">
          <h2>Trace errors</h2>
          {traceErrors.length > 0 ? (
            <ul>
              {traceErrors.map((traceError, index) => (
                <li key={String(traceError.code ?? traceError.message ?? index)}>
                  <strong>{String(traceError.code ?? `error_${index + 1}`)}</strong>
                  {traceError.message ? `: ${String(traceError.message)}` : ""}
                  {traceError.details ? ` (${JSON.stringify(traceError.details)})` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p>No trace errors</p>
          )}
        </section>
      )}
      <pre aria-label="Raw trace JSON">{JSON.stringify(trace ?? { loading: true }, null, 2)}</pre>
    </main>
  );
}

function EvaluationDashboard({ client }: { client: ApiClient }) {
  const [metricsData, setMetricsData] = useState(evaluationFixture);
  const [catalogReadiness, setCatalogReadiness] = useState<CatalogReadinessResponse | null>(null);
  const [taskCaseReadiness, setTaskCaseReadiness] = useState<EvaluationDatasetReadinessResponse | null>(null);
  const [profileReadiness, setProfileReadiness] = useState<ProfileReadinessResponse | null>(null);
  const [indexReadiness, setIndexReadiness] = useState<VectorIndexReadinessResponse | null>(null);
  const [systemReadiness, setSystemReadiness] = useState<SystemReadinessResponse | null>(null);
  const [runInput, setRunInput] = useState(evaluationFixture.run_id);
  const [error, setError] = useState("");
  useEffect(() => {
    client
      .runEvaluation()
      .then((run) => {
        setMetricsData(run);
        setRunInput(run.run_id);
      })
      .catch(() => setMetricsData(evaluationFixture));
    client
      .getCatalogReadiness()
      .then(setCatalogReadiness)
      .catch(() => {
        setCatalogReadiness({
          ready: false,
          catalog_path: "unknown",
          demo_pool_path: "unknown",
          quality_report_path: "unknown",
          product_count: 0,
          demo_pool_count: 0,
          scale_status: "unavailable",
          errors: ["Catalog readiness could not be loaded."],
          warnings: [],
          quality_report: {}
        });
      });
    client
      .getEvaluationDatasetReadiness()
      .then(setTaskCaseReadiness)
      .catch(() => {
        setTaskCaseReadiness({
          ready: false,
          path: "unknown",
          case_count: 0,
          labels: [],
          errors: ["Task case readiness could not be loaded."],
          warnings: []
        });
      });
    client
      .getProfileReadiness()
      .then(setProfileReadiness)
      .catch(() => {
        setProfileReadiness({
          ready: false,
          profiles_path: "unknown",
          summary_path: "unknown",
          profile_count: 0,
          errors: ["Profile readiness could not be loaded."],
          warnings: [],
          summary: {}
        });
      });
    client
      .getVectorIndexReadiness()
      .then(setIndexReadiness)
      .catch(() => {
        setIndexReadiness({
          ready: false,
          index_path: "unknown",
          manifest_path: "unknown",
          product_count: 0,
          errors: ["Vector index readiness could not be loaded."],
          warnings: [],
          manifest: {}
        });
      });
    client
      .getSystemReadiness()
      .then(setSystemReadiness)
      .catch(() => {
        setSystemReadiness({
          ready: false,
          gates: {},
          errors: ["System readiness could not be loaded."],
          warnings: []
        });
      });
  }, [client]);
  const metrics = useMemo(() => Object.entries(metricsData.metrics), [metricsData]);

  async function submitRunLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const runId = runInput.trim();
    if (!runId) {
      return;
    }
    setError("");
    try {
      setMetricsData(await client.getEvaluationRun(runId));
    } catch {
      setError("Evaluation run could not be loaded.");
    }
  }

  return (
    <main className="internal-page">
      <h1>Evaluation dashboard</h1>
      {error && <p role="alert">{error}</p>}
      <form className="trace-selector" aria-label="Evaluation run selector" onSubmit={submitRunLookup}>
        <label htmlFor="evaluation-run-id">Run ID</label>
        <input
          id="evaluation-run-id"
          value={runInput}
          onChange={(event) => setRunInput(event.target.value)}
          placeholder="eval_demo"
        />
        <button type="submit" disabled={runInput.trim().length === 0}>
          Load run
        </button>
      </form>
      <p>Run: {metricsData.run_id}</p>
      <section aria-label="System readiness" className="notice">
        <h2>System readiness</h2>
        {systemReadiness ? (
          <>
            <p>{systemReadiness.ready ? "Ready" : "Not ready"}</p>
            {Object.keys(systemReadiness.gates).length > 0 && (
              <dl>
                {Object.entries(systemReadiness.gates).map(([name, gate]) => (
                  <Fragment key={name}>
                    <dt>{name}</dt>
                    <dd>{gate.ready ? "Ready" : "Not ready"}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
            {systemReadiness.errors.length > 0 && (
              <ul>
                {systemReadiness.errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>Loading system readiness</p>
        )}
      </section>
      <section aria-label="Catalog readiness" className="notice">
        <h2>Catalog readiness</h2>
        {catalogReadiness ? (
          <>
            <p>{catalogReadiness.ready ? "Ready" : "Not ready"}</p>
            <dl>
              <dt>Products</dt>
              <dd>{catalogReadiness.product_count}</dd>
              <dt>Demo pool</dt>
              <dd>{catalogReadiness.demo_pool_count}</dd>
              <dt>Scale</dt>
              <dd>{catalogReadiness.scale_status}</dd>
              <dt>Catalog</dt>
              <dd>{catalogReadiness.catalog_path}</dd>
            </dl>
            {catalogReadiness.errors.length > 0 && (
              <ul>
                {catalogReadiness.errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>Loading catalog readiness</p>
        )}
      </section>
      <section aria-label="Task case readiness" className="notice">
        <h2>Task case readiness</h2>
        {taskCaseReadiness ? (
          <>
            <p>{taskCaseReadiness.ready ? "Ready" : "Not ready"}</p>
            <dl>
              <dt>Cases</dt>
              <dd>{taskCaseReadiness.case_count}</dd>
              <dt>Labels</dt>
              <dd>{taskCaseReadiness.labels.join(", ") || "none"}</dd>
              <dt>Path</dt>
              <dd>{taskCaseReadiness.path}</dd>
            </dl>
            {taskCaseReadiness.errors.length > 0 && (
              <ul>
                {taskCaseReadiness.errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>Loading task case readiness</p>
        )}
      </section>
      <section aria-label="Profile readiness" className="notice">
        <h2>Profile readiness</h2>
        {profileReadiness ? (
          <>
            <p>{profileReadiness.ready ? "Ready" : "Not ready"}</p>
            <dl>
              <dt>Profiles</dt>
              <dd>{profileReadiness.profile_count}</dd>
              <dt>Path</dt>
              <dd>{profileReadiness.profiles_path}</dd>
            </dl>
            {profileReadiness.errors.length > 0 && (
              <ul>
                {profileReadiness.errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>Loading profile readiness</p>
        )}
      </section>
      <section aria-label="Vector index readiness" className="notice">
        <h2>Vector index readiness</h2>
        {indexReadiness ? (
          <>
            <p>{indexReadiness.ready ? "Ready" : "Not ready"}</p>
            <dl>
              <dt>Indexed products</dt>
              <dd>{indexReadiness.product_count}</dd>
              <dt>Path</dt>
              <dd>{indexReadiness.index_path}</dd>
            </dl>
            {indexReadiness.errors.length > 0 && (
              <ul>
                {indexReadiness.errors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>Loading vector index readiness</p>
        )}
      </section>
      <section aria-label="MVP readiness">
        <h2>MVP readiness</h2>
        <p>{metricsData.readiness?.passed ? "Passed" : "Not passed"}</p>
        {metricsData.readiness?.gates && (
          <table>
            <thead>
              <tr>
                <th scope="col">Gate</th>
                <th scope="col">Actual</th>
                <th scope="col">Threshold</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(metricsData.readiness.gates).map(([name, gate]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{String(gate.actual ?? "")}</td>
                  <td>{`${String(gate.operator ?? "")} ${String(gate.threshold ?? "")}`}</td>
                  <td>{gate.passed ? "Pass" : "Fail"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Evaluation metrics">
        {metrics.map(([name, value]) => (
          <div className="metric" key={name}>
            <span>{name}</span>
            <strong>{Math.round(value * 100)}%</strong>
          </div>
        ))}
      </section>
      <section aria-label="Golden cases">
        <h2>Golden cases</h2>
        {metricsData.case_results && metricsData.case_results.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Scenario</th>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {metricsData.case_results.map((result, index) => (
                <tr key={String(result.case_id ?? index)}>
                  <th scope="row">{String(result.case_id ?? `case_${index + 1}`)}</th>
                  <td>{String(result.scenario ?? "")}</td>
                  <td>{`${String(result.expected_task_type ?? "")} -> ${String(result.actual_task_type ?? "")}`}</td>
                  <td>{`${String(result.expected_status ?? "")} -> ${String(result.actual_status ?? "")}`}</td>
                  <td>{result.passed ? "Pass" : "Fail"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No golden case results</p>
        )}
      </section>
      <section aria-label="Evaluation failures">
        <h2>Case failures</h2>
        {metricsData.case_failures.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Expected</th>
                <th scope="col">Actual</th>
              </tr>
            </thead>
            <tbody>
              {metricsData.case_failures.map((failure, index) => (
                <tr key={String(failure.case_id ?? index)}>
                  <th scope="row">{String(failure.case_id ?? `case_${index + 1}`)}</th>
                  <td>{String(failure.expected ?? "")}</td>
                  <td>{String(failure.actual ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No case failures</p>
        )}
      </section>
    </main>
  );
}

export default function App({ client = apiClient, initialTurn = recommendationFixture, path }: AppProps) {
  const currentPath = path ?? window.location.pathname;
  if (currentPath === "/internal/trace") {
    return <InternalTrace client={client} />;
  }
  if (currentPath === "/internal/eval") {
    return <EvaluationDashboard client={client} />;
  }
  return <ConsumerWorkspace client={client} initialTurn={initialTurn} />;
}

export { feedbackUpdatedFixture };
