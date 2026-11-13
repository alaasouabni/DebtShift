# Observability deployment and verification

## Purpose

This document is the executable observability plan for DebtShift. It defines what is collected,
what is forbidden, how context crosses durable boundaries, how to run the local reference stack,
and what a production operator must verify before enabling telemetry.

## Safety contract

Tracing is disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is non-empty. Enabling it never changes a
phase predicate, command hash, authorization digest, idempotency key, provider request, retry
decision, or ledger record.

The only accepted incoming carrier fields are:

- `traceparent`, validated as W3C version, trace ID, span ID, and flags;
- optional `tracestate`, bounded to 512 printable ASCII bytes.

Baggage and unknown fields are rejected. Durable outbox storage keeps trace context in a separate
JSON member and removes it before exposing the command payload to the queue processor. The worker
creates a command-attempt span using that parent and injects the active context into the next
outbox command when evidence advances the migration.

The span attribute allowlist is intentionally small:

- `debtshift.mode`;
- `http.request.method` and `http.response.status_code`;
- `debtshift.command.type`, `debtshift.command.logical_attempt`, and
  `debtshift.command.final_attempt`;
- sanitized `error.type` with no error message.

Never add bodies, query strings, raw paths, wallet or transaction identifiers, signatures, signed
payloads, provider responses, authorization/session headers, private keys, RPC URLs, database URLs,
or arbitrary exception messages to spans. Adding an attribute requires a code and security review;
the runtime rejects any name not present in the allowlist.

## Reference local profile

Run:

```sh
npm run infra:observability:up
```

The override selects `http://jaeger:4318` for the API and worker. The base Compose file keeps the
endpoint blank, so ordinary `npm run infra:up` does not depend on a collector. Reference services
are pinned to Prometheus `3.13.5` LTS, Grafana `13.3.0`, and Jaeger `2.23.0`.

Local endpoints bind only to loopback:

| Component   | Endpoint                           | Verification                                           |
| ----------- | ---------------------------------- | ------------------------------------------------------ |
| API metrics | `http://127.0.0.1:3001/v1/metrics` | Response is Prometheus text with no identifier labels. |
| Prometheus  | `http://127.0.0.1:9090`            | Target `debtshift-api` is up.                          |
| Grafana     | `http://127.0.0.1:3002`            | Folder `DebtShift`, dashboard `DebtShift Operations`.  |
| Jaeger      | `http://127.0.0.1:16686`           | Services include API and worker after one migration.   |

Run `npm run smoke:local`, then verify:

1. `debtshift_metrics_collected_timestamp_seconds` stays fresh.
2. The current migration appears in exactly one phase series.
3. Phase-age, command-attempt, outbox, and alert panels return data.
4. `debtshift_ledger_unexplained_imbalance_units` is zero after settlement.
5. Jaeger's own UI shows an API span and linked worker command spans without forbidden attributes.
6. Stopping the stack drains the worker and produces no exporter credential or payload log.

Stop with:

```sh
npm run infra:observability:down
```

## Production selection

1. Select an OTLP/HTTP collector reachable on the private monitoring network.
2. Use HTTPS for a remote collector. HTTP is accepted only for localhost, private-address, or
   single-label internal collector hosts.
3. Put exporter authentication in the deployment platform's supported secret/header mechanism;
   never embed credentials or query tokens in the endpoint URL. The current reference exporter has
   no custom-header setting, so an authenticated external collector requires a sidecar/private
   gateway selected by the deployment platform.
4. Restrict `/v1/metrics`, Prometheus, Grafana, Jaeger, and OTLP ingress to the monitoring network.
5. Apply retention, access control, tenant isolation, and deletion policy before production data is
   accepted.
6. Verify graceful shutdown exports queued spans and that collector failure does not block or alter
   financial execution.
7. Exercise alert delivery and operator acknowledgement in the selected hosting platform. Local
   dashboard provisioning is evidence for visualization, not proof of external paging delivery.

## Repository verification

Run:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
docker-compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.observability.yml --profile observability config --quiet
```

Tests cover strict carrier validation, baggage rejection, collector URL safety, the attribute
allowlist, no-op startup, outbox context persistence/extraction, metrics rendering, and the existing
workflow suites. The Docker exercise additionally verifies collector reachability and provisioned
dashboard/data-source loading.
