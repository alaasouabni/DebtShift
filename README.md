# DebtShift

DebtShift is a production-oriented cross-chain debt refinancing system. It discovers an
existing lending position, deterministically compares safer or cheaper target routes, obtains
bounded wallet authorization, coordinates a durable refinance, and records verifiable evidence.

DebtShift has one provider-neutral refinance workflow. The contract-backed sandbox and public
testnet exercise that workflow through mode-specific adapters; they are not separate simulated
business implementations. The sandbox executes real private-chain contracts and transactions and
simulates only the unavailable external 1Click testnet boundary. Mainnet targets the complete
Aave-to-1Click-to-Morpho workflow, not an isolated transport canary.

The four runtime modes are `sandbox`, `testnet`, `mainnet-readonly`, and `mainnet`.
`mainnet-readonly` requires a complete runtime market registry and direct Aave, Morpho, Chainlink,
and authenticated 1Click reads. Production modes cannot fall back to fixture values. Mainnet writes
additionally require the restart-bound server switch `MAINNET_EXECUTION_ENABLED=true`; it defaults
to `false`. See `strategies-docs/12-production-provider-boundaries.md` for the enforced boundary.

## Repository

- `apps/web`: Next.js borrower dashboard.
- `apps/api`: NestJS REST and SSE control-plane API.
- `apps/worker`: durable command, evidence, and recovery worker.
- `packages/*`: domain, persistence, optimizer, agent, protocol, transport, and SDK modules.
- `contracts/evm`: Foundry workspace for bounded migration contracts and test markets.
- `contracts/near`: near-sdk workspace for the agreement and receipt registry.
- `infra`: local services, monitoring, and deployment assets.
- `strategies-docs`: approved scope, architecture, security rules, roadmap, and completion gates.

## Prerequisites

- Node.js 22.16.0 and npm 10.9.2.
- Docker Engine with Docker Compose v2.
- Foundry 1.9.0 for EVM contract work.
- Rust 1.95.0, `wasm32-unknown-unknown`, and near-sdk tooling for the NEAR contract.

Only Node and Docker are required for the initial TypeScript workspace. Contract-specific setup is
documented in `docs/local-setup.md`.

## Start

Run the complete contract-backed sandbox with one command:

```sh
cp .env.example .env
npm ci
npm run infra:up
npm run smoke:local
```

This builds and starts PostgreSQL, Redis, both private chains, migrations, the API, worker, and web
application. Open `http://localhost:3000`; API documentation is at
`http://localhost:3001/docs`; Prometheus text metrics are at
`http://localhost:3001/v1/metrics`. Stop the stack with `npm run infra:down`.
The checked-in OpenAPI 3.1 contract is `docs/openapi.json`; deterministic operation, request, and
response types are exported by `@debtshift/sdk`. Run `npm run openapi:generate` after changing an API
contract, or `npm run openapi:check` to reject generated-artifact drift.
An authorized migration is placed in the page URL as `?migration=0x...`, so reload restores its
durable timeline, evidence, ledger, and recovery state. Live updates use the cursor-resumable
`GET /v1/migrations/:migrationId/stream` SSE endpoint and fall back to the last PostgreSQL audit
sequence after a disconnect.

Start the same stack with the optional local observability profile using:

```sh
npm run infra:observability:up
```

This selects the local OTLP collector for the API and worker, provisions Prometheus and the
read-only DebtShift Grafana dashboard, and starts Jaeger. Grafana is bound to
`http://127.0.0.1:3002`, Prometheus to `http://127.0.0.1:9090`, and Jaeger to
`http://127.0.0.1:16686`. Use `npm run infra:observability:down` to stop the profile. Tracing is a
deployment-selected feature and remains a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is blank.
Only W3C trace context and reviewed low-risk attributes are emitted; request bodies, wallet
signatures, provider payloads, credentials, and raw URLs are excluded.

Connecting a wallet also proves API identity through a five-minute, one-time EIP-4361 challenge.
The API returns an eight-hour opaque `HttpOnly`, `SameSite=Strict` session cookie and persists only
its SHA-256 hash. This login signature is not financial authorization: refinance execution still
requires the separate bounded intent and exact execution-plan EIP-712 signatures. All borrower and
migration routes are scoped to the authenticated wallet; production public URLs must use HTTPS.

For application hot reload instead, start only the service dependencies:

```sh
npm run infra:dependencies
npm run db:migrate --workspace @debtshift/database
npm run local:chains # keep this terminal open
```

Then start the applications in another terminal:

```sh
npm run dev
```

Run all currently enabled quality gates with:

```sh
npm run check
```

With Foundry, Rust, and cargo-near installed, run the complete workspace gate with:

```sh
npm run check:all
```

Public-testnet release operations are separately gated. Run the keyless account/funding inventory
with `npm run check:public-testnet-funding`; after canonical Morpho and DebtShift EVM deployment,
use the exact guarded `npm run fund:testnet-vault` operation and remove its key before running
`npm run check:testnet-vault-funding`. These commands do not enable workflow or mainnet writes. The
required ordering, manifests, approvals, recovery rules, and evidence are documented in
`strategies-docs/22-public-testnet-funding-readiness.md` and
`strategies-docs/23-testnet-vault-funding.md`.

Run the reproducible dual-chain contract demonstrations with:

```sh
npm run demo:happy
npm run demo:recovery
```

Each command starts and stops two private Anvil chains and uses disposable test assets only.
`npm run smoke:local` targets the running full sandbox and submits a signed HTTP-to-chain migration.
Without NEAR registry credentials the local development stack reaches financially final `SETTLED`
and keeps receipt registration retryable; a credentialed hosted stack reaches `COMPLETED` only
after the registry receipt is verified.

Exercise the PostgreSQL recovery controls against isolated sibling databases with:

```sh
npm run ops:drill:database-restore
npm run ops:drill:database-migration-recovery
```

The first command verifies an exact source backup/restore without mutating the source. The second
starts from an empty disposable database, applies every checked-in migration, proves transactional
DDL rollback, applies a forward candidate, restores the pre-change backup, and proves that the
checked-in migrator remains idempotent. Neither command points a worker at its temporary database.

## Safety boundary

No real or funded borrower private key belongs in this repository or backend; only Foundry's
well-known disposable Anvil keys are used for local tests. Mainnet writes are fail-closed by default
and the first bounded transaction requires the documented verification gates and explicit financial
authorization. The default Route/Risk Agent is deterministic and requires no AI service.
Optional local or user-supplied AI providers can explain an already-computed result but cannot rank
routes, alter signed fields, or invoke execution.

The solver-financing architecture also requires a zero-shortfall proof before temporary liquidity is
committed: safe destination borrowing plus finalized supplementary funding must cover principal,
solver fees, and every financed cost. Cross-chain smart contracts bound custody and actions but do
not make the migration atomic or guarantee solver repayment. The exact model and recovery rules are
defined in `strategies-docs/11-refinancing-feasibility-model.md` and remain part of the production
implementation and verification gates.

See `strategies-docs/README.md` for the implementation source of truth.
