# DebtShift

DebtShift is a test-funds-first cross-chain debt refinancing demonstrator. It discovers an
existing lending position, deterministically compares safer or cheaper target routes, obtains
bounded wallet authorization, coordinates a durable refinance, and records verifiable evidence.

The complete refinance demonstration uses local/forked Aave V3 and Morpho Blue environments with
a clearly labeled 1Click-compatible simulator. Production 1Click is limited to read-only catalog
and dry-quote access plus one separately gated, manually approved, low-value transport canary. The
canary is not a live debt refinance.

Simulator fixtures live only under explicit `simulator/` namespaces. `mainnet-readonly` instead
requires a complete runtime market registry and uses direct Aave, Morpho, and Chainlink RPC reads
plus authenticated 1Click dry quotes; it cannot fall back to fixture values. See
`strategies-docs/12-production-provider-boundaries.md` for the enforced boundary.

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

```sh
cp .env.example .env
npm ci
npm run infra:up
npm run db:migrate --workspace @debtshift/database
npm run local:chains # keep this terminal open
```

Then, in another terminal:

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
For an automated real-service check after starting the local chains, API, and worker, run
`npm run smoke:local`.

## Safety boundary

No real or funded borrower private key belongs in this repository or backend; only Foundry's
well-known disposable Anvil keys are used for local tests. Real-fund lending and automated mainnet
refinancing are disabled. The default Route/Risk Agent is deterministic and requires no AI service.
Optional local or user-supplied AI providers can explain an already-computed result but cannot rank
routes, alter signed fields, or invoke execution.

The solver-financing architecture also requires a zero-shortfall proof before temporary liquidity is
committed: safe destination borrowing plus finalized supplementary funding must cover principal,
solver fees, and every financed cost. Cross-chain smart contracts bound custody and actions but do
not make the migration atomic or guarantee solver repayment. The exact model and recovery rules are
defined in `strategies-docs/11-refinancing-feasibility-model.md` and remain part of the production
implementation and verification gates.

See `strategies-docs/README.md` for the implementation source of truth.
