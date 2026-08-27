# Conversation Runtime observability assets

`spec/observability/metrics-contract.json` is the source contract. Runtime instruments emit OTLP metric names with dots; the Prometheus rules and Grafana dashboard assume OpenTelemetry Prometheus translation with dots converted to underscores and unit/counter suffixes enabled (for example `rec_agent.turn.duration` with unit `s` becomes `rec_agent_turn_duration_seconds`).

- Import `ops/grafana/conversation-runtime-dashboard.json` into the target Grafana project and bind its Prometheus datasource.
- Load `ops/prometheus/conversation-alerts.yml` into the target Prometheus-compatible rule engine.
- Configure `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` on API and worker processes.
- Run `npm run observability:check` before deployment. It proves that every contracted metric is declared and recorded by active code, and that required dashboard/alert coverage exists.

Repository artifacts do not prove the target services are receiving data. Production acceptance still requires a real OTLP export smoke, non-empty dashboard panels, alert delivery to the on-call route, and an acknowledged test incident. Record those external artifacts with release/version and time window; never paste credentials, prompts, queries, tenant IDs or raw Provider payloads.
