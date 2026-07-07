import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiClient, createFeedbackRequest, type ApiClient } from "./api/client";
import {
  evaluationFixture,
  feedbackUpdatedFixture,
  recommendationFixture
} from "./test/fixtures/chat";
import type { ChatTurnResponse, ProductRecommendation } from "./types/contracts";
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
        </div>
      </div>
    </article>
  );
}

function ProductEvidenceDrawer({ product, onClose }: {
  product: ProductRecommendation | null;
  onClose: () => void;
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
  if (!turn.clarification) {
    return null;
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
      </div>
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

function ConsumerWorkspace({ client, initialTurn }: Required<Pick<AppProps, "client" | "initialTurn">>) {
  const [turn, setTurn] = useState(initialTurn);
  const [draft, setDraft] = useState("Show me something similar but cheaper");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [error, setError] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<ProductRecommendation | null>(null);

  async function submitMessage(message: string) {
    setStatus("submitting");
    setError("");
    try {
      const nextTurn = await client.chat({ session_id: turn.session_id, message });
      setTurn(nextTurn);
      setDraft("");
      setStatus("idle");
    } catch {
      setStatus("error");
      setError("We could not finish this recommendation. Try again.");
    }
  }

  async function submitFeedback(text: string, type: string, productId: string) {
    setStatus("submitting");
    setError("");
    try {
      const nextTurn = await client.chat(createFeedbackRequest(turn, text, type, productId));
      setTurn(nextTurn);
      setStatus("idle");
    } catch {
      setStatus("error");
      setError("We could not update recommendations from feedback.");
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
          {error && <div className="error" role="alert">{error}</div>}
          <ClarificationBox turn={turn} onAnswer={submitMessage} />
          <UnsupportedBox turn={turn} />
          <WhatChanged turn={turn} />
          <section className="product-list" aria-label="Recommendation results">
            {turn.products.map((product) => (
              <ProductCard
                key={product.product_id}
                product={product}
                onFeedback={submitFeedback}
                onInspect={setSelectedProduct}
              />
            ))}
          </section>
          <ProductEvidenceDrawer product={selectedProduct} onClose={() => setSelectedProduct(null)} />
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
  const [error, setError] = useState("");
  useEffect(() => {
    client
      .getInternalTrace("turn_001")
      .then((nextTrace) => setTrace(nextTrace as unknown as Record<string, unknown>))
      .catch(() => setError("Trace could not be loaded."));
  }, [client]);
  return (
    <main className="internal-page">
      <h1>Internal Trace Console</h1>
      {error && <p role="alert">{error}</p>}
      <p>Turn: {String(trace?.turn_id ?? "loading")}</p>
      <pre aria-label="Raw trace JSON">{JSON.stringify(trace ?? { loading: true }, null, 2)}</pre>
    </main>
  );
}

function EvaluationDashboard({ client }: { client: ApiClient }) {
  const [metricsData, setMetricsData] = useState(evaluationFixture);
  useEffect(() => {
    client.runEvaluation().then(setMetricsData).catch(() => setMetricsData(evaluationFixture));
  }, [client]);
  const metrics = useMemo(() => Object.entries(metricsData.metrics), [metricsData]);
  return (
    <main className="internal-page">
      <h1>Evaluation dashboard</h1>
      <section aria-label="Evaluation metrics">
        {metrics.map(([name, value]) => (
          <div className="metric" key={name}>
            <span>{name}</span>
            <strong>{Math.round(value * 100)}%</strong>
          </div>
        ))}
      </section>
      <p>Failure cases: {metricsData.case_failures.length}</p>
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
