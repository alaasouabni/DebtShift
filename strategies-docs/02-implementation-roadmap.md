# Implementation roadmap

The milestones are ordered by dependency and risk. A milestone is complete only when its exit criteria pass; code existence alone is insufficient.

## Milestone 0 - Repository and engineering foundation

**Goal:** establish a reproducible monorepo and shared quality controls.

### Tasks

- [x] Initialize Git and the root workspace.
- [x] Select and pin the Node package manager and runtime version.
- [x] Configure TypeScript project references and path boundaries.
- [x] Scaffold `web`, `api`, `worker`, and shared packages.
- [x] Initialize the Foundry workspace.
- [x] Initialize the Rust/near-sdk workspace.
- [x] Add root lint, formatting, type-check, test, and build commands.
- [x] Add environment-schema validation and `.env.example` files without secrets.
- [x] Add Docker Compose for PostgreSQL and Redis.
- [x] Add continuous integration for initial quality commands.
- [x] Add contribution, local setup, and architecture overview documents.

### Exit criteria

- A clean checkout installs and builds with documented commands.
- All scaffold tests pass.
- No generated secret or machine-specific path is committed.
- CI executes the same checks used locally.

## Milestone 1 - Domain model, authorization schemas, and persistence

**Goal:** make the workflow, identifiers, amounts, and evidence types precise before external side effects exist.

### Tasks

- [x] Implement chain, protocol, market, token, address, amount, and block-reference schemas.
- [x] Implement canonical identifier construction with explicit ABI encoding.
- [x] Define `RefinanceIntent`, `ExecutionPlan`, `ProviderQuote`, `Migration`, `Evidence`, and `LedgerEntry`.
- [x] Define EIP-712 domains and typed structures.
- [x] Add EOA signature and EIP-1271 verification interfaces.
- [x] Define phase transitions and phase-entry predicates.
- [x] Create PostgreSQL migrations for wallets, snapshots, intents, plans, quotes, migrations, commands, evidence, actions, transport legs, ledger entries, audit events, and outbox messages.
- [x] Add uniqueness and optimistic-version constraints.
- [x] Implement transaction helpers and migration-row locking.
- [x] Add deterministic unit fixtures for hashes and phase derivation.

### Exit criteria

- Cross-language hash fixtures are documented for TypeScript, Solidity, and Rust.
- Invalid transition, nonce replay, and ambiguous identifier tests fail as expected.
- Database constraints prevent duplicate actions and event sequences.

## Milestone 2 - Contract-backed sandbox vertical slice

**Goal:** complete one migration through every application layer without external protocol dependencies.

### Tasks

- [x] Start two Anvil chains with stable chain IDs and deterministic accounts.
- [x] Deploy test USDC, test WETH, source lending mock, target lending mock, and test vault.
- [x] Seed a borrower source position and vault liquidity.
- [x] Implement the transport simulator with configurable delays and terminal outcomes; reported
      asset movement is backed by local-chain transactions and verified receipts/balances.
- [x] Implement the initial migration worker and transactional outbox consumer.
- [x] Implement API endpoints for position, quote, authorization, execute, status, events, and evidence.
- [x] Implement a minimal web flow for wallet, route review, signature, execution, and timeline.
- [x] Persist and display source, transport, destination, settlement, and receipt evidence.
- [x] Execute the happy path end to end.
- [x] Execute refund and timeout paths into recovery.

### Exit criteria

- One command seeds and runs the happy-path demonstration.
- One command runs the refund/recovery demonstration.
- Repeating an execute request produces no duplicate transfer.
- Restarting the worker at each phase resumes correctly.

## Milestone 3 - EVM security and protocol adapters

**Goal:** replace generic execution with bounded contracts and validate real protocol behavior.

### Tasks

- [x] Implement the source adapter and exact authorization checks.
- [x] Implement the destination adapter and post-state checks.
- [x] Implement per-migration escrow accounting.
- [x] Implement the test liquidity vault with principal and fee separation.
- [x] Implement migration-specific supplementary-funding and settlement escrow with exact use and
      refund authorization.
- [x] Make liquidity reservation require a fresh, plan-bound, zero-shortfall feasibility proof.
- [x] Add consumed nonces, deadline checks, allowlists, pause scopes, and residual refunds.
- [x] Add reentrancy protection and safe token handling.
- [x] Emit and verify every contract-owned canonical migration event, and bind transport, recovery,
      and terminal events to their authoritative durable offchain/registry evidence instead of
      fabricating them on one EVM chain.
- [x] Implement Aave V3 position reads and source transaction construction.
- [x] Implement Morpho Blue market identity, position reads, authorization requirements, and target transaction construction.
- [x] Route the signed destination adapter through an immutable, exact-market Morpho module using
      atomic native authorization enable/supply/borrow/revoke semantics and post-state deltas.
- [x] Prove the bounded aToken-allowance source-close mechanism on a pinned Aave fork.
- [x] Keep the smart-account or borrower-transaction alternative disabled because the preferred
      atomic EOA mechanism passed; retain it only as a documented future fallback.
- [x] Add pinned Morpho destination fork tests.
- [x] Add contract invariants proving confirmed borrower funding is isolated and `SETTLED` requires
      exact solver repayment rather than a ledger receivable.

### Exit criteria

- Unit, fuzz, and invariant tests pass.
- Mutating any signed route field causes execution to revert.
- Source close and target open pass against pinned real protocol state.
- No contract can transfer active-migration assets to an unsigned receiver.
- No vault reservation or solver payout can bypass the signed financing structure and secured
  supplementary-funding evidence.

## Milestone 4 - Market intelligence and optimizer

**Goal:** produce executable, explainable, and deterministic route recommendations.

### Tasks

- [x] Implement Aave and Morpho snapshot adapters with block references.
- [x] Normalize rates without losing native units or calculation provenance.
- [x] Calculate target rate impact after the requested borrow.
- [x] Add gas, approval, transport, slippage, funding, and protocol costs.
- [x] Add exclusive financing-component classification and reject omitted or double-counted costs.
- [x] Calculate source payoff, solver principal and fee, capitalized costs, separately paid costs,
      borrower debt prepayment, and confirmed external funding as one reconciled analysis.
- [x] Calculate protocol capacity, DebtShift policy capacity, safe market liquidity, signed capacity,
      required destination borrowing, and exact funding shortfall.
- [x] Implement borrower-funded fees, safe fee capitalization, partial debt prepayment, and fail-closed
      rejection as the only supported shortfall outcomes.
- [x] Add break-even, scenario, and net-benefit calculations.
- [x] Add Aave health-factor and Morpho LTV/LLTV safety policies.
- [x] Add oracle freshness and liquidity requirements.
- [x] Add adverse collateral-price and rate-drift scenarios.
- [x] Add golden fixtures rejecting the `10,000 USDC` capacity / `10,100 USDC` obligation case and
      accepting it only with `100 USDC` of finalized supplementary funding or additional safe
      capacity.
- [x] Return human-readable rejection reasons for ineligible routes.
- [x] Add golden fixtures reproducing the specification’s example economics.
- [x] Implement the deterministic Route/Risk Agent and its read-only tool contracts.
- [x] Implement agent modes `DETERMINISTIC`, `LOCAL_AI`, and `USER_API`, with `DETERMINISTIC` as the default.
- [x] Implement an optional Ollama explanation provider using the pinned local model.
- [x] Implement an optional user-supplied API provider through a provider-neutral interface.
- [x] Add UI settings for provider preset, model, API key, and optional compatible endpoint.
- [x] Keep user API keys in memory for the active request/session only; never store them in PostgreSQL, browser storage, logs, traces, or analytics.
- [x] Add URL validation, provider allowlists, redaction, timeouts, response-size limits, and SSRF protections.
- [x] Implement deterministic explanation templates for machines without Ollama.
- [x] Prove that agent and model components cannot call execution, signing, reservation, or transfer code.
- [x] Add cache, retry, rate-limit, and fallback policies from the data-source strategy.

### Exit criteria

- Calculations are deterministic and covered by golden tests.
- Every eligible route has exact execution caps and safety outputs.
- Every eligible route has a current zero-shortfall proof; unresolved or unconfirmed funding makes it
  ineligible regardless of APR savings.
- Display-only USD provider values never enter authorization calculations.
- The same inputs always produce the same route eligibility and ranking regardless of whether Ollama is enabled.
- The application starts and remains fully functional without any AI API key or local model.
- Switching explanation providers cannot change route ranking, financial values, or signed fields.

## Milestone 5 - Durable orchestration and recovery

**Goal:** implement every phase and recovery branch using verified evidence.

### Tasks

- [x] Implement command handlers for reserve, source close, route, destination verification, target open, settlement, and final receipt.
- [x] Add feasibility evidence and revalidation checkpoints before reservation, source close, target
      borrow, and settlement.
- [ ] Implement provisional, confirmed, finalized, and retracted evidence states.
- [ ] Persist financing analyses, exclusive component classifications, funding contributions,
      checkpoint feasibility evidence, and settlement obligations.
- [x] Add chain-specific finality configuration.
- [x] Add canonical-block and transaction-receipt rechecks before each subsequent financial side
      effect, append-only retractions, and manual incident handling for deep reorgs.
- [x] Add transport polling with strict unknown-status behavior.
- [x] Add destination balance and receipt reconciliation.
- [x] Add retry budgets and deadline-aware scheduling.
- [ ] Add each recovery policy and operator escalation state.
- [x] Persist recovery cases atomically with opening evidence, exact residual custody/receivable
      claims, phase changes, and failed-safe resolution.
- [x] Add pre-source-close price and liquidity deterioration handling that releases unused capacity,
      preserves the source position, and requires fresh borrower authorization.
  - [x] Destination-liquidity deterioration records the newer failed feasibility proof and releases
        the undrawn reservation in one vault transaction, verifies zero receivable and an unchanged
        source position, and ends in the explicit terminal `REQUOTE_REQUIRED` outcome.
  - [x] A mutable collateral-price shock proves the same fail-closed outcome, including the exact
        newer safe capacity and shortfall.
- [x] Add post-source-close price, liquidity, rate, and risk-parameter deterioration recovery without
      unsafe borrowing or false settlement.
  - [x] Destination-liquidity deterioration after source closure appends a newer failed feasibility
        proof, records exact destination collateral custody and source-vault exposure, opens durable
        recovery, returns destination collateral, and never opens the unsafe target position.
  - [x] Mutable price, rate, and protocol-risk-parameter fixtures prove that refreshed state and the
        signed minimum-APR-reduction policy supersede the earlier passing plan.
- [x] Add exact receipt-linked balanced ledger reconciliation as a mandatory `SETTLED` predicate,
      including recovery-reserve, destination escrow, principal, fee, residual, and signed-cost basis.
- [x] Add durable stale-migration, stale-recovery, signed-deadline, unknown-custody,
      terminal-command, and missing-settlement-ledger alerts with deterministic deduplication and
      automatic resolution.

### Exit criteria

- Every allowed transition has a passing integration test.
- Every disallowed transition has a negative test.
- Chaos tests prove no duplicate movement after worker, Redis, RPC, or API interruption.
- Shock tests prove a newer failed capacity check supersedes an older passing quote and preserves
  collateral custody, solver receivables, and signed recovery limits.

## Milestone 6 - Complete API and web product

**Goal:** deliver the complete borrower and operator experience.

### Tasks

- [ ] Implement wallet challenge/session authentication.
- [ ] Complete OpenAPI schemas and generated client types.
- [ ] Complete positions, markets, quotes, intents, plans, execute, cancel, events, and evidence endpoints.
- [ ] Implement SSE reconnect and cursor recovery.
- [ ] Build source position and risk views.
- [ ] Build route comparison and economic explanation views.
- [ ] Display financing classifications, maximum safe capacity, confirmed external funding, required
      destination borrowing, exact shortfall, resolution status, and checkpoint provenance.
- [ ] Build the exact authorization review and signing flow.
- [ ] Build the migration timeline with provider and verified states separated.
- [ ] Build evidence, ledger, residual asset, and recovery views.
- [ ] Add accessible error handling and responsive layouts.

### Exit criteria

- The complete happy and failure journeys can be performed from the UI.
- Reloading or reconnecting does not lose migration history.
- The UI never describes a provider success as a completed refinance.

## Milestone 7 - NEAR agreement and receipt registry

**Goal:** register immutable commitments and final receipt hashes on NEAR.

### Tasks

- [x] Implement contract initialization and administrative roles.
- [x] Register intent hash, execution-plan hash, actors, and supported networks.
- [x] Append verifier attestations with evidence identifiers and schemes.
- [x] Enforce verifier authorization and duplicate protection.
- [x] Register one immutable final receipt hash and terminal status.
- [x] Add read views for agreement, attestations, and receipt lookup.
- [x] Add Rust unit tests and NEAR sandbox integration tests.
- [ ] Deploy to NEAR testnet using a documented deployment manifest.
- [ ] Verify application and registry receipt hashes match.

### Exit criteria

- Local sandbox and testnet smoke tests pass.
- Unauthorized attestation and duplicate finalization attempts fail.
- The UI links the final NEAR transaction and verifies its stored hash.

## Milestone 8 - Production execution modes and complete mainnet route

**Goal:** implement one complete production Aave-to-Morpho refinance through official 1Click, while
retaining contract-backed sandbox, public testnet, and mainnet-readonly modes that use the same core
workflow.

### Tasks

- [x] Replace simulator-specific worker construction with provider-neutral source, liquidity,
      transport, destination, settlement, canonicality, and registry ports.
- [x] Add validated `sandbox`, `testnet`, `mainnet-readonly`, and `mainnet` composition roots with no
      production fallback to simulation.
- [x] Add fail-closed `MAINNET_EXECUTION_ENABLED`, defaulting to `false`, and enforce it at the API
      and every irreversible worker command boundary.
- [x] Validate the 1Click client against the current official OpenAPI/API reference.
- [x] Encode the absence of public 1Click testnet as an environment rule without making simulation
      the primary workflow.
- [x] Fetch/version the live token catalog and map asset IDs by chain and contract address.
- [x] Retain `dry: true` quotes in `mainnet-readonly` and implement committed quotes only in `mainnet`.
- [x] Implement committed quote validation, deposit-address binding, origin transaction submission,
      strict status normalization, refund handling, and raw-payload persistence.
- [x] Independently verify origin receipt, destination receipt, delivered asset, amount, receiver,
      confirmations, and canonical block before target open.
- [x] Connect production source close, vault/escrow, official transport, Morpho target open, atomic
      settlement, residual return, and NEAR receipt registration.
- [x] Add bounded retry, timeout, rate limit, circuit breaker, and fail-closed unknown-status behavior.
- [x] Restrict the first deployment to one versioned route and explicit principal, collateral, fee,
      slippage, gas, receiver, deadline, and recovery-exposure limits.
- [x] Require a separately isolated recovery reserve before source close.
- [x] Keep all mainnet writes disabled through development, sandbox, testnet, fork, and acceptance
      verification.
- [ ] Deploy production with writes disabled and simulate every intended transaction against current
      state before requesting final execution approval.
- [ ] After explicit owner approval only, enable writes, attempt one small complete refinance, disable
      writes immediately afterward, and preserve completion or recovery evidence.

### Exit criteria

- All four modes select the expected adapters and reject invalid combinations at startup.
- The same command/evidence workflow passes contract-backed sandbox and public testnet execution.
- Pinned forks prove production Aave and Morpho adapter paths at recorded blocks.
- `mainnet-readonly` provides live positions, markets, catalog, and dry quotes without write clients.
- `mainnet` with execution disabled constructs and simulates the complete transaction sequence but
  cannot broadcast any irreversible command.
- The first real attempt occurs last, is explicitly approved, stays within every signed/configured
  limit, and ends with complete evidence or a correctly opened recovery case.
- No deployment configuration contains or implies a public 1Click testnet.

## Milestone 9 - Security, observability, and operational hardening

**Goal:** make failures visible, bounded, and reproducible.

### Tasks

- [ ] Complete the security test matrix and risk-register evidence.
- [ ] Run static analysis and dependency vulnerability checks.
- [ ] Add structured logs, traces, and Prometheus metrics.
- [ ] Add dashboards for phases, latency, failures, health, and ledger imbalance.
- [ ] Complete alerts for reservation shortfall, receipt mismatch, and accounting imbalance.
  - [x] Persist and exercise deadline-approach and stale-recovery alerts.
- [ ] Alert on feasibility expiry, missing supplementary funding, capacity deterioration, solver
      exposure, and payout failure after collateral delivery.
- [ ] Add database backup/restore and migration rollback drills.
- [ ] Add secret rotation and relayer-key replacement procedures.
- [ ] Generate an SBOM and container provenance metadata.

### Exit criteria

- Critical alerts are exercised in tests or a controlled drill.
- No unresolved critical or high risk remains for the test-funds release.
- Recovery runbooks can be followed from a clean operator session.

## Milestone 10 - Reproducible release and demonstration

**Goal:** produce the final hackathon deliverable.

### Tasks

- [ ] Add one-command environment setup.
- [ ] Add deterministic happy-path and refund demo scripts.
- [ ] Produce deployment manifests and contract-address records.
- [ ] Produce an architecture guide, API guide, threat model, and operations guide.
- [ ] Capture expected transaction hashes and evidence examples.
- [ ] Run the complete acceptance suite from a clean checkout.
- [ ] Record known limitations and the mainnet-readiness backlog.

### Exit criteria

- Every requirement in `09-definition-of-done.md` passes.
- A clean machine can reproduce both demonstration scenarios from documentation.
- Mainnet-funded execution remains disabled.
