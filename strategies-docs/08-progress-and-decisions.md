# Progress and decisions

This file is updated throughout implementation. It is the first place to inspect when resuming work.

## Milestone tracker

| Milestone                           | Status      | Started    | Completed  | Evidence / notes                                                                                                                                                    |
| ----------------------------------- | ----------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy documentation              | COMPLETE    | 2026-11-08 | 2026-11-10 | Twelve implementation documents plus this tracker created and cross-checked, including financing and production-provider boundaries.                                |
| M0 Repository foundation            | COMPLETE    | 2026-11-08 | 2026-11-08 | Clean `npm ci`; full TypeScript gate; API/web smoke checks; Compose validation; Foundry build; NEAR fmt/test/clippy/WASM gate all pass.                             |
| M1 Domain and persistence           | COMPLETE    | 2026-11-08 | 2026-11-09 | Runtime schemas, canonical/EIP-712 hashing, signature interfaces, evidence-derived phases, 19-table migration, constraints, and cross-language fixtures pass.       |
| M2 Simulated vertical slice         | COMPLETE    | 2026-11-09 | 2026-11-09 | Browser/API/outbox/worker/dual-Anvil happy, refund, timeout, replay, and restart-at-every-phase checks pass with real PostgreSQL/Redis smoke evidence.              |
| M3 EVM adapters and fork validation | IN_PROGRESS | 2026-11-09 | -          | Direct Aave/Morpho/Chainlink adapters and identity/freshness tests exist; pinned public-fork validation remains.                                                    |
| M4 Market intelligence              | IN_PROGRESS | 2026-11-09 | -          | Deterministic optimizer, Route/Risk Agent, local onchain comparison, explanation providers, SSRF boundary, and memory-only provider UI pass package/API/web checks. |
| M5 Orchestration and recovery       | NOT_STARTED | -          | -          | -                                                                                                                                                                   |
| M6 Complete API and web product     | NOT_STARTED | -          | -          | -                                                                                                                                                                   |
| M7 NEAR registry                    | NOT_STARTED | -          | -          | -                                                                                                                                                                   |
| M8 Live read-only integrations      | IN_PROGRESS | 2026-11-10 | -          | Live registry/provider wiring and authenticated 1Click dry-only client implemented; external smoke and catalog/cache work remain.                                   |
| M9 Security and operations          | NOT_STARTED | -          | -          | -                                                                                                                                                                   |
| M10 Reproducible release            | NOT_STARTED | -          | -          | -                                                                                                                                                                   |

## Current active task

- **Task:** M3/M4 - harden real protocol adapters and implement deterministic market intelligence.
- **Status:** IN_PROGRESS
- **Next verification:** Validate configured Aave V3 and Morpho Blue reads on pinned public forks,
  then add live catalog caching, retry, rate-limit, and circuit-breaker behavior.

## Decision log

### ADR-001 - Test-funds release before real-fund execution

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Build the complete local/testnet version first. Real-fund mainnet execution is deferred.
- **Reason:** The workflow includes non-atomic cross-chain credit exposure and requires contract, integration, operational, and recovery validation before funds are at risk.

### ADR-002 - Greenfield modular monorepo

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Use one repository with web, API, worker, shared packages, EVM contracts, NEAR contract, infrastructure, and tests.
- **Reason:** The workspace has no existing application, and shared types and fixtures are essential across languages and services.

### ADR-003 - Three initial application processes

- **Status:** PROVISIONAL
- **Date:** 2026-11-08
- **Decision:** Deploy web, API, and worker processes. Keep indexing, optimization, transport, and solver modules inside packages until independent scaling is justified.
- **Reason:** This preserves clear boundaries without introducing unnecessary distributed deployment failure modes during the first release.

### ADR-004 - Initial demonstration route

- **Status:** PROVISIONAL
- **Date:** 2026-11-08
- **Decision:** Use a Base-like Aave V3 source, Arbitrum-like Morpho Blue target, WETH-like collateral, and USDC-like debt.
- **Reason:** This exercises protocol and chain changes while keeping solver settlement denominated in the same debt asset.
- **Validation required:** Confirm live deployments, market availability, and current 1Click asset support before any live-read integration.

### ADR-005 - PostgreSQL controls workflow state

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** PostgreSQL evidence and transitions are authoritative; BullMQ provides at-least-once delivery only.
- **Reason:** Queue acknowledgement cannot prove financial side effects.

### ADR-006 - Two borrower signatures

- **Status:** PROVISIONAL
- **Date:** 2026-11-08
- **Decision:** Use a policy-level refinance intent and a short-lived exact execution plan.
- **Reason:** The committed provider quote, recipients, funding reservation, and exact limits must be bound after discovery.

### ADR-007 - Pre-funded test vault before solver marketplace

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Demonstrate temporary liquidity with a permissioned test vault.
- **Reason:** A permissionless solver system requires additional credit, collateral, default, and legal design that is unnecessary for the first acceptance target.

### ADR-008 - No public 1Click testnet dependency

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Use the DebtShift transport simulator for every funded local, CI, and testnet-oriented flow. Restrict the public production 1Click service to token discovery and `dry: true` quotes in `mainnet-readonly`.
- **Reason:** The public NEAR Intents/1Click stack has no testnet deployment. Treating a simulator as 1Click testnet would misrepresent the evidence and create unsafe environment assumptions.
- **Implementation consequence:** NEAR testnet validates only the DebtShift receipt registry; its receipt hash may commit to clearly labeled simulated transport evidence.

### ADR-009 - Hybrid proof with isolated mainnet canary

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Keep the complete debt-refinancing demonstration on test assets, and add one real production 1Click transfer between team-controlled wallets under a strict canary capability.
- **Reason:** The NEAR Hackathon Unstoppable DeFi track emphasizes cross-chain settlement through NEAR Intents. A real canary provides verifiable integration evidence while avoiding unaudited mainnet lending and solver exposure.
- **Limits:** One allowlisted route, fixed token-unit cap, dedicated low-balance wallet, manual deposit confirmation, controlled recipient/refund addresses, and no access to lending adapters or solver funds.

### ADR-010 - Deterministic financial agent with local explanation model

- **Status:** AMENDED BY ADR-012
- **Date:** 2026-11-08
- **Decision:** Implement the DebtShift Route/Risk Agent as deterministic TypeScript policy and tools. The original explanation option was local Ollama with `qwen3.5:4b`, `qwen3.5:2b`, and deterministic-template fallbacks; ADR-012 expands this to a user-supplied API while retaining the deterministic financial agent as the default.
- **Reason:** Financial eligibility, ranking, amounts, and authorization must be reproducible and auditable. Local inference avoids a paid API and keeps the model outside the execution trust boundary.
- **Limits:** The explanation model receives structured read-only data and has no signing, transaction, reservation, receiver-selection, or policy-override capability.

### ADR-011 - Free public data with onchain execution truth

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Use free official RPCs and public protocol APIs for discovery and analytics. Re-read execution-critical state directly from contracts before every irreversible step.
- **Reason:** This avoids mandatory paid services without trusting an indexed API as financial authorization.
- **Limits:** Public endpoints have no guaranteed SLA; freshness gates, caching, provider health checks, and fail-closed behavior are mandatory.

### ADR-012 - User-selectable explanation provider

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Default to the deterministic financial agent. Allow the user to optionally choose local Ollama or enter credentials for a supported remote AI API. All AI providers share an explanation-only interface.
- **Reason:** The core product remains free and reproducible while users may choose their preferred model provider without changing financial logic.
- **Credential policy:** API credentials are memory-only, request/session scoped, redacted everywhere, and never persisted in browser storage or the application database.
- **Security boundary:** Provider selection and model output cannot alter route eligibility, ranking, amounts, receivers, signed fields, workflow phases, or execution commands.

### ADR-013 - npm workspaces and Turborepo foundation

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Pin Node.js 22.16.0, npm 10.9.2, TypeScript 6.0.3, and Turborepo 2.11.10. Use npm workspaces for dependency ownership and Turborepo only for local/CI task orchestration.
- **Reason:** The selected Node version is installed, satisfies the application toolchain engine constraints, and is reproducible. TypeScript 6.0.3 is the newest stable line accepted by the selected TypeScript ESLint release; TypeScript 7 is intentionally not used until that peer constraint is compatible.
- **Boundary:** The package lock is authoritative. CI uses `npm ci` and invokes the same root scripts as local development.

### ADR-014 - Drizzle and explicit PostgreSQL migrations

- **Status:** APPROVED
- **Date:** 2026-11-08
- **Decision:** Use Drizzle ORM with node-postgres and checked-in SQL migrations. Financial and workflow constraints remain explicit database constraints; row locking and transactional outbox operations may use typed SQL where the ORM abstraction is insufficient.
- **Reason:** This preserves TypeScript schema inference while retaining direct control over bigint token units, partial indexes, uniqueness rules, check constraints, `FOR UPDATE`, and `SKIP LOCKED` behavior.

### ADR-015 - In-process PostgreSQL migration verification

- **Status:** APPROVED
- **Date:** 2026-11-09
- **Decision:** Execute checked-in SQL migrations in PGlite during unit tests, while retaining PostgreSQL as the production/local-service database and adding container integration tests at the M2/M5 gates.
- **Reason:** This gives every checkout a fast, isolated PostgreSQL-compatible constraint test even when Docker Desktop is unavailable; it does not replace real PostgreSQL integration coverage.

### ADR-016 - Zero-shortfall proof before temporary liquidity commitment

- **Status:** APPROVED
- **Date:** 2026-11-09
- **Decision:** A solver- or test-vault-financed migration is ineligible unless maximum safe
  destination borrowing capacity plus finalized, plan-bound external funding covers the exact solver
  principal, solver fee, and every other financed cost. The component ledger must classify each cost
  exactly once and report a zero funding shortfall before reservation and source closure.
- **Resolution modes:** Borrower-funded supplementary escrow, safe debt capitalization, verified
  borrower partial debt repayment, or migration rejection. Future deposits, wallet balances,
  speculative capacity, and unsecured promises do not count.
- **Execution consequence:** Revalidate before reservation, source close, target borrow, and payout. A
  failed post-source-close check cannot authorize unsafe borrowing; it activates only signed,
  pre-funded forward or recovery paths and preserves explicit solver exposure.
- **Reason:** A destination position may safely support the original debt while lacking capacity for
  solver fees and other financed costs. Per-chain smart contracts cannot eliminate this asynchronous
  cross-chain financing risk.

### ADR-017 - Explicit production provider boundary

- **Status:** APPROVED
- **Date:** 2026-11-10
- **Decision:** Select market providers once at the application composition root through validated
  `SIMULATOR`, `LIVE_READ_ONLY`, or `DISABLED` capabilities. Application services depend only on
  ports; production modules cannot import simulator implementations.
- **Live behavior:** Aave, Morpho, and Chainlink state comes from direct RPC reads configured by a
  versioned runtime registry. 1Click read-only access is pinned to the official origin and exposes
  only catalog and `dry: true` quote methods.
- **Safety consequence:** Production configuration failure stops the live path. It never activates
  fixture values. The isolated mainnet canary disables all lending market providers.
- **Release consequence:** Live lending routes remain analysis-only and are marked adapter-unapproved
  until pinned forks, audits, execution authorization, and future mainnet gates are satisfied.

## Open decisions

| ID   | Decision                                  | Needed by            | Resolution method                                                                      |
| ---- | ----------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| D-03 | Exact local protocol mock depth           | M2                   | Preserve adapter interfaces while keeping deterministic fixtures maintainable.         |
| D-04 | Safe Aave EOA source-close mechanism      | M3                   | Resolve through pinned fork tests; fall back to smart account or borrower transaction. |
| D-05 | Exact live Aave and Morpho markets        | M8                   | Discover current deployments, liquidity, asset identity, and oracle readiness.         |
| D-06 | NEAR verifier threshold and key ownership | M7                   | Define testnet actors and operational model.                                           |
| D-07 | Future production upgrade policy          | Future mainnet phase | Decide after audit and governance requirements exist.                                  |

## Implementation journal

### 2026-11-10 - Simulator/production boundary and live read-only providers

- Moved API market fixtures and dual-Anvil worker execution beneath explicit `simulator/`
  namespaces and renamed the worker implementation to `DualAnvilSimulationExecutionPort`.
- Replaced direct `Local*` dependencies in route analysis, preparation, and migration services with
  startup-selected protocol and market-intelligence ports.
- Added environment validation that requires simulator providers locally, live providers in
  `mainnet-readonly`, and disabled lending providers in `mainnet-canary`.
- Added the schema-validated `LIVE_MARKET_CONFIG_JSON` registry with no production address defaults.
- Wired live Aave source reads, Morpho identity/rate/liquidity reads, Chainlink price/freshness and
  sequencer checks, live gas prices, and authenticated 1Click dry quotes into read-only route
  analysis.
- Added an official-origin-pinned 1Click client with no committed quote, deposit, or broadcast
  capability; provider USD display fields are not used in financial calculations.
- Live lending routes remain deliberately execution-unapproved. Pinned fork validation and external
  credentialed smoke tests remain open M3/M8 gates.
- Focused verification passed: domain 17 tests, intents 13 tests, protocols 8 tests, API 5 tests,
  worker 14 tests, domain/protocol/API/worker type checks, and API/worker lint.

### 2026-11-09 - Solver-financing feasibility correction

- Added the canonical sources-and-uses model in
  `11-refinancing-feasibility-model.md`, including exact capacity, required-borrow, and shortfall
  equations.
- Made zero shortfall and finalized supplementary-funding evidence mandatory before solver or test-
  vault reservation and source closure.
- Defined borrower-funded fees, safe debt capitalization, verified partial debt repayment, and
  fail-closed rejection as the supported resolution paths.
- Added execution-time revalidation, capacity-deterioration recovery, solver exposure limits, and an
  explicit statement that cross-chain contracts do not guarantee repayment.
- Propagated the model into product scope, architecture, authorization, escrow, orchestration,
  testing, operations, security, agent, roadmap, and completion requirements.
- This is a documentation and implementation-plan correction; corresponding code and contract tasks
  remain unchecked until their tests pass.

### 2026-11-08 - Strategy initialization

- Reviewed the full DebtShift technical specification and diagrams.
- Confirmed that the workspace contains no existing application repository.
- Approved a test-funds-first implementation direction.
- Created the strategy documentation structure.
- Cross-checked document links, milestone dependencies, terminology, status markers, and release boundaries.
- No application or contract implementation has started.

### 2026-11-08 - 1Click network constraint clarified

- Confirmed that the public 1Click/NEAR Intents stack is mainnet-only and has no public testnet deployment.
- Kept the transport simulator as the funded E2E implementation.
- Restricted live 1Click integration in the first release to production catalog reads and `dry: true` quotes.
- Clarified that NEAR testnet is used for the DebtShift registry, not for 1Click routing.

### 2026-11-08 - Hybrid live proof approved

- Added a separately isolated `mainnet-canary` environment.
- Required one genuine, capped 1Click transfer for the hackathon demonstration.
- Kept the complete Aave-to-Morpho debt migration on test assets with fork-validated protocol integrations.
- Prohibited the canary from calling lending adapters, migration escrow, or liquidity-vault code.

### 2026-11-08 - Agent and free data stack selected

- Selected a deterministic TypeScript Route/Risk Agent for all financial decisions.
- Selected local Ollama `qwen3.5:4b` for optional explanations with smaller-model and template fallbacks.
- Selected public Aave, Morpho, Base, Arbitrum, NEAR, and 1Click data sources with direct onchain verification for execution-critical state.
- Added explicit caching, rate-limit, freshness, and fallback requirements.

### 2026-11-08 - Pluggable explanation provider approved

- Made the deterministic financial agent the default mode.
- Added optional local Ollama and user-supplied API modes.
- Required memory-only API credential handling and provider-network protections.
- Kept every AI provider outside financial policy, authorization, and execution.

### 2026-11-08 - Implementation started

- Initialized the Git repository and modular npm workspace.
- Pinned Node.js, npm, TypeScript, Turborepo, Next.js, NestJS, Foundry, Rust, and near-sdk versions.
- Scaffolded the web, API, worker, shared packages, Foundry workspace, near-sdk workspace, Docker services, and CI workflow.
- Added strict environment validation that rejects production transport in local/testnet modes and rejects general funded mainnet refinancing.
- Selected Drizzle with explicit PostgreSQL migrations for durable workflow persistence.

### 2026-11-08 - M0 repository foundation completed

- Proved the lockfile with `npm ci --ignore-scripts`.
- Passed `npm run check`: formatting, lint, TypeScript graph checks, tests, and all production builds.
- Smoke-tested the built API health endpoint and production Next.js server.
- Validated the Docker Compose configuration for PostgreSQL and Redis.
- Passed `npm run check:evm` with Foundry 1.9.0 and solc 0.8.30.
- Passed `npm run check:near` with Rust 1.95.0, near-sdk 5.30.1, cargo-near 0.23.0, and NASM 3.02; the optimized registry WASM hash was `ff3ca2e733472873111485ffff9130ad284635e1ed12927dea43c4b2d008eeb8`.
- Confirmed `npm audit --omit=dev` reports zero production vulnerabilities. Recorded the moderate, development-only lint dependency advisory as R-29 instead of applying incompatible major downgrades.
- Recorded a Windows-only cargo-near ABI-generation linker issue; the validated M0 WASM build uses `--no-abi`, while ABI generation remains an explicit M7 requirement.

### 2026-11-09 - M1 domain and persistence completed

- Implemented strict financial primitives, asset/market/position snapshots, two-layer authorization schemas, provider quotes, migrations, evidence, ledger entries, and audit events in `packages/domain`.
- Implemented explicit ABI identifiers, EIP-712 intent/plan digests, EOA verification, an EIP-1271 verification interface, exact route integrity checks, and evidence-derived phase predicates.
- Added the initial checked-in Drizzle migration with 19 durable PostgreSQL tables, integer base-unit columns, nonce/action/event/idempotency uniqueness, optimistic versions, append-only evidence/audit records, and serializable row-locking helpers.
- Executed the migration in PGlite and proved rejection of malformed identities, unsafe amounts, nonce replay, duplicate actions, and duplicate audit sequences.
- Added and documented one pinned machine-readable hash fixture reproduced by TypeScript and Solidity for all five identifiers and by Rust/NEAR for the cross-system migration ID.
- Verification passed: 13 domain tests, 5 database migration/constraint tests, Foundry canonical fixture, two Rust tests, TypeScript lint/typecheck, Solidity formatting, Rust formatting, and Clippy with warnings denied.

### 2026-11-09 - M2 dual-chain contract foundation

- Implemented exact-delta test ERC-20 handling, source and destination lending mocks, per-migration escrow, a principal/fee-aware test liquidity vault, and replay-protected source/destination adapters.
- Added Foundry happy-path and refund-path tests covering source closure, isolated collateral, destination opening, payout, settlement, residual recovery obligations, and duplicate-call rejection.
- Added a viem deployment harness that starts disposable Anvil chains `31337` and `31338`, deploys every local contract, seeds a borrower position and vault liquidity, and verifies onchain terminal balances.
- `npm run demo:happy` completed with a closed source position, destination position of `9.9` collateral / `10,050` debt units, and zero vault receivable.
- `npm run demo:recovery` completed with borrower collateral refunded, no destination position, and the exact `10,000,000,000` source-debt receivable retained for recovery accounting.
- CI now runs all Foundry tests and both dual-chain demonstrations in the EVM job.

### 2026-11-09 - M2 durable worker and simulated transport

- Implemented the explicitly labelled `DEBTSHIFT_SIMULATOR` provider with deterministic committed
  quotes, configurable processing delay and terminal outcome, restart-safe state restoration,
  idempotent origin binding, and independent delivery/refund verification.
- Implemented atomic migration creation, evidence-derived phase advancement, transactional command
  and outbox insertion, BullMQ publishing/consumption, command lifecycle recovery, and evidence-before-
  side-effect processing.
- Wired the worker runtime to PostgreSQL, Redis/BullMQ, the outbox publisher, stale-command recovery,
  graceful draining, and strict environment validation.
- Added a local viem execution port that is structurally disabled outside local/CI/testnet simulator
  modes. It executes the source vault, source adapter, source/destination escrows, destination adapter,
  and settlement transactions and reconciles existing contract events before retrying a broadcast.
- Persisted the independently observed destination amount and required target opening to consume that
  value rather than a quoted estimate.
- Added PGlite migration coverage and dual-Anvil integration tests proving the entire durable command
  chain reaches `SETTLED` on success and `FAILED_SAFE` on a verified refund, including a transport-poll
  restart and full borrower collateral recovery.
- Worker verification now passes 12 tests across command contracts, handler recovery behavior, the
  concrete two-chain port, and the PostgreSQL-compatible outbox/evidence workflow. CI runs this suite
  in the Foundry-enabled EVM job.

### 2026-11-09 - M2 signed API, borrower web flow, and real-service smoke

- Added canonical local source-position discovery with historical block provenance and a live-state
  recheck immediately before accepting execution.
- Added route preparation that issues and persists the simulator quote, derives the migration and
  route hashes, and returns exact intent/plan fields for two EIP-712 wallet signatures.
- Strengthened API binding checks across borrower, position, markets, tokens, quote, receivers,
  amounts, fee caps, debt caps, nonce-derived migration ID, intent lifetime, and quote lifetime.
- Added dual-Anvil API integration coverage proving live position preparation, both borrower
  signatures, durable creation, and execute-request deduplication.
- Replaced the static web preview with the working browser-wallet journey: source position,
  exact route review, two signatures, execute request, phase polling, simulator warning, and the
  finalized evidence timeline.
- Added a persistent `local:chains` launcher, a reliable cross-platform Foundry wrapper, and a
  runtime Drizzle migration command that is verified against PostgreSQL 17.
- Ran the built API and worker against real PostgreSQL 17 and Redis 8 containers plus two Anvil
  chains. `npm run smoke:local` reached `SETTLED` with 11 evidence records through HTTP, PostgreSQL,
  the transactional outbox, BullMQ, and all source/destination contract actions.

### 2026-11-09 - M2 simulated vertical slice completed

- Added signed-deadline timeout handling that records `MIGRATION_EXPIRED`, opens recovery only for
  known simulator custody, and returns all test collateral before ending `FAILED_SAFE`.
- Reconstructed the processor and simulator before every durable command attempt in integration
  tests, proving state restoration from PostgreSQL at every phase and between transport polls.
- Replayed every concrete contract action after finalization and proved event reconciliation returns
  the original transaction instead of moving value twice.
- M2 now passes 14 worker tests plus API, database, domain, Foundry, web build, and a real
  PostgreSQL/Redis HTTP-to-chain smoke. All M2 tasks and exit criteria are satisfied.

### 2026-11-09 - M4 deterministic Route/Risk Agent and comparison surface

- Added an exact-integer optimizer with rate-impact projection, seven-part cost accounting,
  gross/stress/net benefit, break-even, liquidity and freshness gates, LTV and health-factor
  policies, deterministic ranking, and structured rejection codes.
- Reproduced the technical specification's $10,000 debt / 9% to 5% APR example exactly at 90 and
  180 days, including the $85 cost and 6,701,400-second break-even result.
- Added a capability-limited Route/Risk Agent whose tool contract exposes only source discovery,
  route discovery, and deterministic comparison; capability tests reject signing, broadcasting,
  reservations, and transfers from the agent boundary.
- Added deterministic templates, loopback-only Ollama, and request-scoped OpenAI-compatible user
  API explanations. The decision hash covers only the allowlisted deterministic payload, and model
  failure or malformed output falls back without changing that hash.
- Hardened remote explanation calls with fixed provider presets, optional custom-endpoint gating,
  HTTPS-only URLs, private/reserved IPv4 and IPv6 rejection, DNS-result validation, address pinning
  for the TLS connection, disabled redirects, timeouts, response limits, and strict output schemas.
- Added a local onchain market tool that reads destination liquidity, collateral price, LTV, and
  block provenance together. It returns one executable route and one policy-rejected
  low-liquidity outcome, and route preparation now refuses to sign unless the executable route is
  the deterministic selection.
- Added the web comparison and explanation workspace with costs, savings, break-even, stress
  economics, safety, rejection reasons, provenance, provider selection, and a React-memory-only API
  key field. The default remains fully functional without a model or credential.
- Verification passes: 5 optimizer tests, 7 agent/security tests, 4 API tests including the signed
  dual-Anvil flow, API/web lint and type checks, and production API/web builds.

## Work-session handoff template

Copy and complete this section at the end of each material work session:

```text
Date:
Milestone:
Task completed:
Files changed:
Commands run and results:
Decisions added or changed:
Risks opened or closed:
Current blocker, if any:
Exact next task:
```
