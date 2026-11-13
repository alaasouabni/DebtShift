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
