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

## Milestone 2 - Deterministic simulated vertical slice

**Goal:** complete one migration through every application layer without external protocol dependencies.

### Tasks

- [x] Start two Anvil chains with stable chain IDs and deterministic accounts.
- [x] Deploy test USDC, test WETH, source lending mock, target lending mock, and test vault.
- [x] Seed a borrower source position and vault liquidity.
- [x] Implement the transport simulator with configurable delays and terminal outcomes.
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

- [ ] Implement the source adapter and exact authorization checks.
- [ ] Implement the destination adapter and post-state checks.
- [ ] Implement per-migration escrow accounting.
- [ ] Implement the test liquidity vault with principal and fee separation.
- [ ] Add consumed nonces, deadline checks, allowlists, pause scopes, and residual refunds.
- [ ] Add reentrancy protection and safe token handling.
- [ ] Emit the canonical migration events.
- [ ] Implement Aave V3 position reads and source transaction construction.
- [ ] Implement Morpho Blue market identity, position reads, authorization requirements, and target transaction construction.
- [ ] Prove or reject the bounded aToken-allowance source-close mechanism on a pinned Aave fork.
- [ ] If rejected, implement the documented smart-account or borrower-transaction alternative.
- [ ] Add pinned Morpho destination fork tests.

### Exit criteria

- Unit, fuzz, and invariant tests pass.
- Mutating any signed route field causes execution to revert.
- Source close and target open pass against pinned real protocol state.
- No contract can transfer active-migration assets to an unsigned receiver.

## Milestone 4 - Market intelligence and optimizer

**Goal:** produce executable, explainable, and deterministic route recommendations.

### Tasks

- [ ] Implement Aave and Morpho snapshot adapters with block references.
- [x] Normalize rates without losing native units or calculation provenance.
- [x] Calculate target rate impact after the requested borrow.
- [x] Add gas, approval, transport, slippage, funding, and protocol costs.
- [x] Add break-even, scenario, and net-benefit calculations.
- [x] Add Aave health-factor and Morpho LTV/LLTV safety policies.
- [x] Add oracle freshness and liquidity requirements.
- [x] Add adverse collateral-price and rate-drift scenarios.
- [x] Return human-readable rejection reasons for ineligible routes.
- [x] Add golden fixtures reproducing the specification’s example economics.
- [x] Implement the deterministic Route/Risk Agent and its read-only tool contracts.
- [x] Implement agent modes `DETERMINISTIC`, `LOCAL_AI`, and `USER_API`, with `DETERMINISTIC` as the default.
- [ ] Implement an optional Ollama explanation provider using the pinned local model.
- [x] Implement an optional user-supplied API provider through a provider-neutral interface.
- [x] Add UI settings for provider preset, model, API key, and optional compatible endpoint.
- [x] Keep user API keys in memory for the active request/session only; never store them in PostgreSQL, browser storage, logs, traces, or analytics.
- [x] Add URL validation, provider allowlists, redaction, timeouts, response-size limits, and SSRF protections.
- [x] Implement deterministic explanation templates for machines without Ollama.
- [x] Prove that agent and model components cannot call execution, signing, reservation, or transfer code.
- [ ] Add cache, retry, rate-limit, and fallback policies from the data-source strategy.

### Exit criteria

- Calculations are deterministic and covered by golden tests.
- Every eligible route has exact execution caps and safety outputs.
- Display-only USD provider values never enter authorization calculations.
- The same inputs always produce the same route eligibility and ranking regardless of whether Ollama is enabled.
- The application starts and remains fully functional without any AI API key or local model.
- Switching explanation providers cannot change route ranking, financial values, or signed fields.

## Milestone 5 - Durable orchestration and recovery

**Goal:** implement every phase and recovery branch using verified evidence.

### Tasks

- [ ] Implement command handlers for reserve, source close, route, destination verification, target open, settlement, and final receipt.
- [ ] Implement provisional, confirmed, finalized, and retracted evidence states.
- [ ] Add chain-specific finality configuration.
- [ ] Add canonical-block rechecks and reorg handling.
- [ ] Add transport polling with strict unknown-status behavior.
- [ ] Add destination balance and receipt reconciliation.
- [ ] Add retry budgets and deadline-aware scheduling.
- [ ] Add each recovery policy and operator escalation state.
- [ ] Add balanced ledger checks before settlement.
- [ ] Add stale migration and deadline alerts.

### Exit criteria

- Every allowed transition has a passing integration test.
- Every disallowed transition has a negative test.
- Chaos tests prove no duplicate movement after worker, Redis, RPC, or API interruption.

## Milestone 6 - Complete API and web product

**Goal:** deliver the complete borrower and operator experience.

### Tasks

- [ ] Implement wallet challenge/session authentication.
- [ ] Complete OpenAPI schemas and generated client types.
- [ ] Complete positions, markets, quotes, intents, plans, execute, cancel, events, and evidence endpoints.
- [ ] Implement SSE reconnect and cursor recovery.
- [ ] Build source position and risk views.
- [ ] Build route comparison and economic explanation views.
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

- [ ] Implement contract initialization and administrative roles.
- [ ] Register intent hash, execution-plan hash, actors, and supported networks.
- [ ] Append verifier attestations with evidence identifiers and schemes.
- [ ] Enforce verifier authorization and duplicate protection.
- [ ] Register one immutable final receipt hash and terminal status.
- [ ] Add read views for agreement, attestations, and receipt lookup.
- [ ] Add Rust unit tests and NEAR sandbox integration tests.
- [ ] Deploy to NEAR testnet using a documented deployment manifest.
- [ ] Verify application and registry receipt hashes match.

### Exit criteria

- Local sandbox and testnet smoke tests pass.
- Unauthorized attestation and duplicate finalization attempts fail.
- The UI links the final NEAR transaction and verifies its stored hash.

## Milestone 8 - Live 1Click validation and isolated canary

**Goal:** validate the mainnet-only public 1Click integration and execute one tightly controlled transport canary without exposing lending positions or solver capital.

### Tasks

- [ ] Generate or validate the 1Click client against the current OpenAPI schema.
- [ ] Encode the absence of a public 1Click testnet as an environment capability rule.
- [ ] Fetch and version the live token catalog.
- [ ] Map live asset IDs by chain and contract address.
- [ ] Implement `dry: true` quotes as the default and only quote mode outside the isolated canary capability.
- [ ] Reject unknown provider fields or statuses safely while retaining raw payloads for diagnostics.
- [ ] Add live Aave and Morpho read-only position discovery behind configuration flags.
- [ ] Add circuit breakers and rate limits.
- [ ] Add a separate `mainnet-canary` capability that is disabled by default.
- [ ] Restrict the canary to one configured origin chain, destination chain, origin asset, destination asset, recipient, and refund receiver.
- [ ] Enforce a fixed maximum input in token base units.
- [ ] Require an explicit user confirmation after showing the committed quote, deposit address, minimum output, deadline, and refund receiver.
- [ ] Send the deposit from a dedicated, low-balance wallet controlled by the project team.
- [ ] Poll real 1Click status and independently verify origin and destination receipts.
- [ ] Persist and display the real correlation ID, quote terms, transaction hashes, delivered amount, and terminal status.
- [ ] Prove that canary mode cannot call lending adapters, reserve solver liquidity, or create a debt migration.
- [ ] Label all simulator receipts and UI states so they cannot be mistaken for live 1Click execution.

### Exit criteria

- Live read-only mode displays current supported assets and dry route information.
- Automated tests prove committed quotes and deposits are disabled outside `mainnet-canary`.
- One successful, independently verified mainnet canary is recorded for the demo.
- The canary’s actual input does not exceed the configured token-unit cap.
- The canary has no authority or code path to touch lending positions or solver funds.
- No deployment configuration contains or implies a 1Click testnet base URL.

## Milestone 9 - Security, observability, and operational hardening

**Goal:** make failures visible, bounded, and reproducible.

### Tasks

- [ ] Complete the security test matrix and risk-register evidence.
- [ ] Run static analysis and dependency vulnerability checks.
- [ ] Add structured logs, traces, and Prometheus metrics.
- [ ] Add dashboards for phases, latency, failures, health, and ledger imbalance.
- [ ] Add alerts for reservation shortfall, deadline approach, stale recovery, receipt mismatch, and accounting imbalance.
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
