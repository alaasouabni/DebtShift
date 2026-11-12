# Progress and decisions

This file is updated throughout implementation. It is the first place to inspect when resuming work.

## Milestone tracker

| Milestone                           | Status      | Started    | Completed  | Evidence / notes                                                                                                                                                                                                                     |
| ----------------------------------- | ----------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Strategy documentation              | COMPLETE    | 2026-11-08 | 2026-11-12 | The complete strategy set now encodes the production-first architecture, four execution modes, contract-backed sandbox, mainnet write gate, and two-day submission plan.                                                             |
| M0 Repository foundation            | COMPLETE    | 2026-11-08 | 2026-11-08 | Clean `npm ci`; full TypeScript gate; API/web smoke checks; Compose validation; Foundry build; NEAR fmt/test/clippy/WASM gate all pass.                                                                                              |
| M1 Domain and persistence           | COMPLETE    | 2026-11-08 | 2026-11-09 | Runtime schemas, canonical/EIP-712 hashing, signature interfaces, evidence-derived phases, 19-table migration, constraints, and cross-language fixtures pass.                                                                        |
| M2 Contract-backed sandbox slice    | COMPLETE    | 2026-11-09 | 2026-11-09 | Browser/API/outbox/worker/dual-Anvil happy, refund, timeout, replay, and restart-at-every-phase checks pass with real contract transactions and PostgreSQL/Redis smoke evidence.                                                     |
| M3 EVM adapters and fork validation | COMPLETE    | 2026-11-09 | 2026-11-11 | Production Aave and Morpho modules pass the complete signed-adapter flow at pinned Base state; authorization, rollback, event payloads, feasibility, escrow, settlement, unit/fuzz/invariant gates all pass.                         |
| M4 Market intelligence              | IN_PROGRESS | 2026-11-09 | -          | Deterministic optimizer, Route/Risk Agent, local onchain comparison, explanation providers, SSRF boundary, and memory-only provider UI pass package/API/web checks.                                                                  |
| M5 Orchestration and recovery       | IN_PROGRESS | 2026-11-09 | -          | Durable command/outbox workflow, restart/replay coverage, financing checkpoints, refund/timeout recovery, market deterioration, and source/destination reorg guards pass; remaining recovery, alerting, and ledger branches remain.  |
| M6 Complete API and web product     | NOT_STARTED | -          | -          | -                                                                                                                                                                                                                                    |
| M7 NEAR registry                    | IN_PROGRESS | 2026-11-11 | -          | Production-shaped registry, storage accounting, role controls, ordered attestations, immutable receipt lookup, eight Rust unit tests, WASM build, and a compiling sandbox test exist; the supported Linux sandbox run and CI remain. |
| M8 Production execution modes       | IN_PROGRESS | 2026-11-10 | -          | Live reads and dry-only client exist, but the worker is simulator-bound. It must be refactored to one workflow with sandbox, testnet, mainnet-readonly, and full mainnet compositions before deployment.                             |
| M9 Security and operations          | NOT_STARTED | -          | -          | -                                                                                                                                                                                                                                    |
| M10 Reproducible release            | NOT_STARTED | -          | -          | -                                                                                                                                                                                                                                    |

## Submission-critical mode

- **Time remaining:** two days as stated by the project owner on 2026-11-12; confirm the exact portal
  cutoff and timezone.
- **Priority source:** `14-submission-critical-plan.md` overrides milestone ordering until the
  submission is packaged.
- **P0 order:** freeze strategy/modes; provider-neutral workflow; complete production adapters;
  funding/authorization/recovery invariants; contract-backed sandbox; fork/provider validation;
  testnet/hosted deployment; acceptance gate; mainnet deployment disabled; real attempt last.
- **Parallel owner:** the frontend contributor follows `13-frontend-handoff.md` while backend and
  contract work continues.
- **Mainnet rule:** no canary or controlled mode. `mainnet` is the complete workflow and remains
  write-disabled until every prior gate and explicit final approval pass.

## Current active task

- **Task:** P0.2 - extract the worker into one provider-neutral workflow and mode-specific composition
  roots.
- **Status:** NOT_STARTED
- **Next verification:** Prove that production handlers import only execution ports, sandbox is an
  adapter for the same handlers, and `mainnet-readonly` cannot construct write-capable providers.

## Decision log

### ADR-001 - Test-funds release before real-fund execution

- **Status:** SUPERSEDED BY ADR-022
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

- **Status:** AMENDED BY ADR-022
- **Date:** 2026-11-08
- **Decision:** Because 1Click has no public testnet, use an explicitly labeled transport adapter in
  sandbox and testnet. It must move value through real deployed test contracts and transactions.
  Use the official service for read-only discovery and dry quotes in `mainnet-readonly`, and for the
  complete committed transport lifecycle in `mainnet`.
- **Reason:** The public NEAR Intents/1Click stack has no testnet deployment. Treating a simulator as 1Click testnet would misrepresent the evidence and create unsafe environment assumptions.
- **Implementation consequence:** Testnet validates real public-chain contracts and the DebtShift
  receipt registry while labeling the transport boundary as simulated; no fake provider response may
  be presented as public 1Click testnet evidence.

### ADR-009 - Hybrid proof with isolated mainnet canary

- **Status:** SUPERSEDED BY ADR-022
- **Supersession:** Do not implement this decision. ADR-022 replaces the isolated transfer with the
  complete, guarded production workflow.
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

- **Status:** AMENDED BY ADR-022
- **Date:** 2026-11-10
- **Decision:** Select providers once at the application composition root for `sandbox`, `testnet`,
  `mainnet-readonly`, or `mainnet`. Application services depend only on ports; production modules
  cannot import sandbox implementations.
- **Live behavior:** Aave, Morpho, and oracle state comes from direct RPC reads configured by a
  versioned runtime registry. The official 1Click client exposes catalog and dry quotes in
  `mainnet-readonly`, and the committed deposit/status/refund lifecycle in `mainnet`.
- **Safety consequence:** Invalid production configuration fails startup and never activates fixture
  values. `mainnet-readonly` cannot construct write providers. `mainnet` cannot broadcast unless
  `MAINNET_EXECUTION_ENABLED=true` and all workflow authorization and policy checks pass.
- **Release consequence:** The complete route is implemented and verified first; the one bounded
  mainnet attempt is last and requires the gates in ADR-022.

### ADR-018 - Reuse the allowlisted source-domain execution-plan signature at destination

- **Status:** APPROVED
- **Date:** 2026-11-10
- **Decision:** The destination adapter recomputes the borrower's execution-plan digest using the
  explicitly allowlisted source chain ID and source-adapter address, then verifies the original EOA
  or EIP-1271 authorization before opening the target position. It does not accept a looser executor-
  supplied destination instruction or require a third borrower authorization type.
- **Settlement consequence:** A destination verifier must additionally append a current feasibility
  attestation for the same plan hash. The adapter enforces the attested required borrow, settlement
  asset, solver principal, exact fee, capitalized cost, supplementary-funding evidence, safe capacity,
  zero shortfall, and expiry before lending or payout.
- **Escrow consequence:** Transported collateral, destination loan proceeds, supplementary funding,
  and solver repayment are separate migration/token balance classes. Supplementary funding is bound
  to chain, escrow, token, depositor, amount, exact-use hash, refund receiver, and deadline and can
  move only through the atomic signed settlement path or the post-deadline refund path.
- **Reason:** The existing execution plan is already the borrower's exact authorization. Verifying
  its original domain on the destination chain retains one canonical plan while preventing a local
  executor from substituting borrowers, receivers, amounts, funding evidence, or source domains.

### ADR-019 - Atomic bounded aToken claim for Aave EOA source closure

- **Status:** APPROVED
- **Date:** 2026-11-11
- **Decision:** Keep the signed `SourceAdapter` as the authorization/vault boundary and place Aave
  protocol calls behind an immutable `AaveV3SourceLending` module. The borrower approves exactly the
  signed collateral minimum in the reserve's aToken; one adapter transaction repays current bounded
  variable debt, proves zero remaining debt, transfers that exact aToken claim, withdraws underlying
  collateral to migration escrow, and verifies the receiver delta.
- **Atomicity consequence:** Missing allowance, excess accrued debt, incomplete repayment, wrong
  reserve identity, aToken transfer failure, or withdrawal mismatch reverts the vault draw, debt
  repayment, nonce consumption, and collateral movement together. The module clears temporary
  approvals and must retain neither debt asset nor aTokens.
- **Evidence:** Four deterministic Foundry tests prove success and rollback boundaries. The pinned
  Base block `55,600,000` test passed through the complete vault/adapter/Aave path against the real
  Aave pool, then released escrowed collateral and opened the pinned Morpho market. Base's official
  free RPC returned the expected block hash
  `0xc22ea6ebea74eb93bf081cee853c017b276a6264012407e56e01c0233467f542`.
- **Fallback:** Smart-account or borrower-submitted source transactions remain possible future
  alternatives for unsupported reserves, but are not selected for this route.

### ADR-020 - Deep EVM reorgs halt for manual canonical-state reconciliation

- **Status:** APPROVED
- **Date:** 2026-11-11
- **Decision:** Every worker command revalidates the canonical block hash, configured confirmation
  depth, and transaction receipt of active chain evidence before its next financial side effect.
  Mismatches create append-only `RETRACTED` records that supersede the orphaned evidence.
- **Recovery consequence:** If no irreversible action exists, the stale plan ends
  `REQUOTE_REQUIRED`. Otherwise a durable recovery incident records the affected evidence and
  uncertain custody, but no generic recovery transaction is automatically queued. An operator must
  reconcile current protocol, escrow, transport, and vault state before selecting an action.
- **Reason:** A generic refund or retry can duplicate value after a deep reorg or transaction
  re-inclusion. Halting preserves history and prevents the database from authorizing a new side
  effect from an orphaned chain history.

### ADR-021 - Atomic temporary native Morpho authorization for EOA target opening

- **Status:** APPROVED
- **Date:** 2026-11-11
- **Decision:** Bind an immutable `MorphoBlueTargetLending` module to one Morpho singleton, one exact
  initialized market, and one `DestinationAdapter`. An EOA borrower signs Morpho's native
  authorization twice: enable that module at nonce `N`, then disable it at nonce `N + 1`.
- **Atomicity consequence:** One adapter transaction consumes enable, exact collateral supply, exact
  borrow, disable, settlement-escrow assignment, and payout. An invalid or expired signature,
  supply/borrow mismatch, receiver mismatch, failed revocation, or settlement failure reverts the
  complete destination transaction, including Morpho position and nonce changes.
- **State consequence:** The module rejects an existing collateral/debt position in the exact market,
  proves authorization is false and nonce is `N + 2`, verifies collateral/borrow-share/receiver
  deltas, clears temporary approval, and permits only unchanged pre-existing token dust.
- **Account consequence:** This is the selected EOA path. Smart accounts require a future explicit
  direct-authorization or borrower-controlled batch mechanism and are never silently treated as EOAs.
- **Evidence:** Five focused Foundry tests, the full 27-test EVM gate with three 16,384-call invariant
  runs, and the complete pinned Base block `55,600,000` workflow pass. The fork deploys both production
  protocol modules and both signed adapters, consumes the two native Morpho signatures, leaves no new
  module/adapter/escrow residual, disables authorization, and settles the vault receivable.

### ADR-022 - Production-first workflow with contract-backed simulation and four modes

- **Status:** APPROVED
- **Date:** 2026-11-12
- **Deadline context:** Two days remain for submission; implementation priority is governed by
  `14-submission-critical-plan.md`.
- **Decision:** Implement one normal provider-neutral refinance workflow first. Production adapters
  cover real Aave source close, vault/escrow funding, official 1Click committed transport, exact
  Morpho target open, solver settlement, residual return, and receipt registration. Sandbox and
  testnet adapters exercise that same workflow; they do not own separate business logic.
- **Modes:** The only product modes are `sandbox`, `testnet`, `mainnet-readonly`, and `mainnet`.
  The prior `mainnet-canary` and `mainnet-controlled` concepts are removed.
- **Sandbox consequence:** The hosted sandbox uses real private-chain contracts, signatures,
  transactions, receipts, balances, events, and persistence. The external transport provider alone
  is simulated, and every reported movement references an actual chain transaction.
- **Testnet consequence:** Public testnet contracts and the NEAR testnet registry are real; transport
  is explicitly simulated because 1Click has no public testnet.
- **Mainnet consequence:** `mainnet-readonly` has no write runtime. `mainnet` is the complete real
  workflow and is guarded by required `MAINNET_EXECUTION_ENABLED`, default `false`. The switch is
  server-side, restart-bound, and cannot replace signatures, funding, allowlists, roles, or pauses.
- **Release order:** Complete development, recovery, sandbox, testnet, fork, provider, security,
  deployment, and non-broadcast mainnet verification first. Deploy mainnet with writes disabled.
  Present exact exposure and obtain explicit approval. Attempt one small real transaction last,
  then immediately disable writes and preserve completion or recovery evidence.
- **Scope consequence:** Support one configured route and defer multi-protocol expansion and optional
  agent work that does not unblock the route. Limits are versioned policy, not hardcoded workflow
  behavior.
- **Supersedes/amends:** Supersedes ADR-001 and ADR-009; amends ADR-008 and ADR-017.

## Open decisions

| ID   | Decision                                  | Needed by            | Resolution method                                                              |
| ---- | ----------------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| D-03 | Exact local protocol mock depth           | M2                   | Preserve adapter interfaces while keeping deterministic fixtures maintainable. |
| D-05 | Exact live Aave and Morpho markets        | M8                   | Discover current deployments, liquidity, asset identity, and oracle readiness. |
| D-06 | NEAR verifier threshold and key ownership | M7                   | Define testnet actors and operational model.                                   |
| D-07 | Future production upgrade policy          | Future mainnet phase | Decide after audit and governance requirements exist.                          |

## Implementation journal

The journal preserves historical implementation context. Entries before ADR-022 may mention the
superseded canary architecture; approved ADR statuses and the current strategy documents are the
operative source of truth.

### 2026-11-12 - Submission architecture corrected before implementation

- Project owner clarified that judges should inspect normal functional production code, while
  simulation remains a contract-backed sandbox/test adapter rather than the primary workflow.
- Removed the isolated 1Click canary and future `mainnet-controlled` model from the approved design.
- Approved four modes: `sandbox`, `testnet`, `mainnet-readonly`, and complete `mainnet`.
- Required `MAINNET_EXECUTION_ENABLED=false` by default and the real transaction only after all
  development, simulation, testnet, fork, security, deployment, and approval gates pass.
- Recorded that two days remain for submission as of this date; optional agent expansion and
  multi-route support cannot displace the end-to-end production path.
- No implementation or mainnet transaction was changed or executed as part of this strategy update.

### 2026-11-11 - M3 EVM adapters and canonical event surface completed

- Added canonical `MigrationAuthorized` emission after exact plan/signature validation while retaining
  the legacy `ExecutionPlanConsumed` log as a temporary compatibility alias.
- Classified canonical migration events by their truthful authority. Seven contract-owned events are
  emitted on the source/destination EVMs; provider dispatch, recovery opening, and terminal completion
  remain durable workflow/NEAR records rather than fabricated logs on one chain.
- Added a complete contract-path test that verifies exact emitter, event signature, indexed
  migration/plan/asset/actor topics, and ABI payloads for reservation, authorization, supplementary
  funding, source close, destination collateral assignment/open, and liquidity settlement.
- Added a 1,000-run property test over collateral and debt amounts for the atomic Morpho
  enable/supply/borrow/revoke path.
- The complete EVM gate now passes 29 tests: the property run, all deterministic unit/integration
  tests, and all three 256-run / 16,384-call invariants. This satisfies the M3 unit, fuzz, invariant,
  signed-mutation, pinned-protocol, receiver, and financing-boundary exit criteria.

### 2026-11-11 - Production Morpho destination module and signed-adapter fork path

- Generalized `DestinationAdapter` over a minimal target-lending interface and added an immutable
  `MorphoBlueTargetLending` module that validates all five registered market parameters at deployment
  and binds once to the adapter.
- Implemented the native EOA authorization pair: signed enable at nonce `N`, exact collateral supply
  and borrow on behalf of the borrower, then signed disable at nonce `N + 1` inside one destination
  transaction. Completion proves authorization removal, nonce advancement, exact position and receiver
  deltas, cleared approval, and no new residual balance.
- Added shared TypeScript builders for Morpho's nonstandard chain/address-only EIP-712 domain and the
  Solidity-compatible authorization-pair encoding, with malformed-signature rejection tests.
- Added a registered-market Morpho fixture and five Foundry tests covering success, invalid-revocation
  rollback, existing-position rejection, immutable adapter binding, and unsolicited-dust resistance.
- Replaced the direct borrower-to-Morpho fork leg with the complete production path: independent
  escrows, signed source and destination adapters, current feasibility, exact 10 WETH transport,
  temporary native authorization, target opening, settlement payout, zero residuals, and vault
  repayment.
- Verification passed twice against Base block `55,600,000` using the official public RPC. The full
  EVM gate passed 27 tests, including all three 256-run / 16,384-call invariants; protocol package
  tests and type checks also passed. The complete repository formatting, lint, typecheck, test, and
  production-build gate passed afterward. No mainnet transaction or funded action occurred.

### 2026-11-11 - Canonical evidence and deep-reorg guard

- Added independent source/destination confirmation-depth configuration and made every local chain
  write wait for its configured depth before producing finalized evidence.
- Added a pre-command canonicality guard that re-reads the recorded block, current tip, and receipt.
  Missing blocks/receipts, changed hashes, moved or reverted receipts, lost depth, and unknown chain
  IDs fail closed before the handler can broadcast its next transaction.
- Activated the existing append-only evidence supersession column. Retractions now remove orphaned
  finalized evidence from phase predicates without deleting history; an orphaned active reservation
  is also removed from durable capacity accounting.
- Deep-reorg recovery records are marked for manual review, so the workflow opens a durable incident
  but deliberately derives no generic recovery command while custody is uncertain.
- Added real two-Anvil chaos cases. One reverts the source chain until the finalized reservation
  receipt disappears; the other reverts destination delivery and mines a different canonical block
  at the same height. Neither closes the source or opens the target after detection, neither queues
  automatic recovery, and both preserve superseding retraction evidence.
- Verification passed: the complete repository formatting/lint/typecheck/test/build gate, including
  21 domain tests, 15 database tests, and 28 worker tests with all 12 durable dual-chain workflows.

### 2026-11-11 - Mutable market-shock matrix completed

- Made the deterministic destination fixture's collateral price, protocol maximum LTV, and borrow
  APR owner-controlled test state while retaining constructor defaults for existing scenarios.
- Extended every execution-time financing revalidation with the observed price, protocol LTV,
  target APR, signed maximum target APR, and structured policy-failure codes. A target rate above
  `source APR - signed minimum APR reduction` now contributes zero policy capacity.
- Added real dual-Anvil pre-source price and rate shocks. Price deterioration proves exact safe
  capacity `8,599,500,000` and shortfall `1,450,500,000`; rate deterioration proves zero policy
  capacity and the full `10,050,000,000` shortfall. Both atomically release undrawn capacity, leave
  source debt/collateral unchanged, create no receivable, and end `REQUOTE_REQUIRED`.
- Added post-source price, rate, and protocol-LTV shocks. They prove capacities of `8,687,250,000`,
  `0`, and `8,910,000,000` respectively, never open a target position, preserve exact solver/custody
  evidence, return destination collateral through recovery, and end `FAILED_SAFE`.
- Verification passed: the complete repository formatting/lint/typecheck/test/build gate, all 25
  worker tests including 10 durable dual-chain workflows, and the dedicated 22-test Foundry gate
  with all three 16,384-call invariant runs.

### 2026-11-11 - Pinned Aave source-ownership gate resolved

- Generalized `SourceAdapter` over a minimal `ISourceLending` protocol boundary without changing its
  signed-plan, nonce, vault, escrow, pause, or executor controls.
- Added `AaveV3SourceLending` with immutable pool/token bindings and one-time source-adapter binding.
  It reads accrued variable debt inside execution, enforces the signed cap, repays on behalf of the
  borrower, proves debt is zero, claims exactly the signed aToken amount, withdraws underlying to the
  adapter, verifies the receiver delta, and clears temporary approvals.
- Added a deterministic Aave pool fixture and four Foundry tests proving the successful path,
  all-or-nothing rollback without aToken allowance, all-or-nothing rollback above the debt cap, and
  immutable adapter binding. The EVM gate now passes 22 tests.
- Added reserve-token discovery and the exact aToken authorization transaction builder in the
  protocol package. The fork fixture now uses separate collateral-reserve aToken and debt-reserve
  variable-debt identities and a dedicated code-free EOA.
- Ran the complete pinned Base fork at block `55,600,000` against `https://mainnet.base.org`. It
  matched the committed block hash, tolerated six additional USDC base units of bounded in-flight
  interest, cleared Aave debt, isolated exactly 10 WETH in escrow, retained no module balances,
  explicitly released 5 WETH as the transport handoff, and opened/read the pinned Morpho market.

### 2026-11-11 - Pre-source capacity deterioration and explicit requote

- Added the terminal `REQUOTE_REQUIRED` phase and evidence type. It is distinct from expiry and
  recovery: the source position remains intact, no solver receivable exists, and the stale signed
  plan cannot be silently reused.
- Added `recordFailedFeasibilityAndRelease` to the test liquidity vault. The verifier/operator-only
  call validates the active reservation and exact plan amounts, requires a genuinely failed newer
  proof, appends that proof, and releases undrawn capacity atomically.
- The worker converts a fresh pre-source capacity failure into `FINANCING_REVALIDATION` plus
  `REQUOTE_REQUIRED`, then reconciles the release event and verifies onchain that the reservation is
  released, the vault receivable is zero, and the borrower's source collateral and debt are exact
  and unchanged.
- Persistence migration `0005_mute_luminals.sql` adds the new phase. Workflow persistence releases
  the matching active reservation in the same transaction as evidence/phase advancement, and no
  further command is derived from the terminal result.
- Added Foundry, domain, database, handler, processor, and real dual-Anvil coverage. The dual-chain
  scenario consumes destination liquidity after reservation but before source closure, proves exact
  safe capacity `7,272,727,272` and shortfall `2,777,272,728`, releases all undrawn capacity, creates
  no receivable or recovery case, and leaves source collateral/debt untouched.
- Verification passed: the complete root formatting/lint/typecheck/test/build gate, including 19
  domain tests, 15 database tests, and 20 worker tests with all five durable dual-chain scenarios;
  the separate EVM gate passed the then-current 18 Foundry tests. The later M3 journal entry records
  the explicit public-fork run and expanded contract gate.

### 2026-11-10 - Post-source destination-capacity recovery

- Added a typed post-source capacity-failure boundary. When fresh destination liquidity can no
  longer cover the signed complete obligation, the worker appends the newer failed feasibility to
  the destination adapter and converts its finalized receipt into `FINANCING_REVALIDATION` and
  `RECOVERY_OPENED` evidence instead of treating the condition as an ordinary command failure.
- Recovery evidence is built from direct chain reads: transported collateral in the destination
  escrow's collateral category and the source vault reservation's actual principal receivable,
  exact fee claim, total claim, and status. Secured supplementary funding is retained as a separate
  residual claim.
- `recovery_cases` is now written and updated in the same serializable transaction as append-only
  evidence and phase derivation. Duplicate evidence cannot duplicate or reopen a resolved case;
  `RECOVERY_COMPLETED` cannot resolve a missing case; migration detail reads now include recovery
  cases for API/frontend consumers.
- Recovery execution now checks destination escrow first and returns its exact transported
  collateral to the signed refund receiver. It preserves the source-vault receivable explicitly
  rather than fabricating source-side custody after a destination-funded failure.
- Added handler and PGlite coverage plus a real two-Anvil shock workflow that closes the source,
  delivers `9.9` destination collateral, consumes destination lending liquidity, proves the exact
  failed capacity/shortfall, opens no target position, returns all destination collateral, retains
  the `10,000,000,000` principal plus `50,000,000` fee claim, and ends `FAILED_SAFE` with a durable
  recovery case.
- Focused verification passed: repository-wide TypeScript typecheck, 4 database workflow tests,
  6 worker handler tests, and all 4 durable dual-chain workflow scenarios.

### 2026-11-10 - Plan-bound destination settlement and supplementary funding

- Replaced the destination adapter's executor-only amount tuple with verification of the canonical
  borrower-signed execution plan against an allowlisted source chain/adapter EIP-712 domain, including
  nonce, deadline, migration ID, collateral minimum, target-debt cap, principal cap, fee cap, escrow,
  payout receiver, and refund receiver.
- Added append-only, sequence-ordered destination feasibility attestations. A newer failed proof
  supersedes an older passing proof, and target borrowing requires the latest exact plan, settlement
  asset, required borrow, funding evidence, zero shortfall, capacity, and validity window.
- Split migration escrow accounting into transported collateral, destination loan proceeds,
  supplementary funding, and solver repayment. Added exact-delta token transfers and removed the
  ability for the generic collateral-release path to consume supplementary or loan balances.
- Added migration-specific supplementary-funding commitments bound to the destination chain, escrow,
  asset, depositor, exact amount, authorized settlement use, refund receiver, and deadline. Funding is
  consumed atomically with loan proceeds or refunded permissionlessly to the signed receiver only
  after expiry; administrators have no active-balance sweep function.
- Destination borrowing now sends proceeds into settlement escrow, combines only the attested funding,
  pays exact solver principal and fee, pays an explicitly bounded capitalized-cost recipient when
  configured, and returns any residual to the signed refund receiver.
- The test vault now distinguishes authorized principal from the actual receivable after unused draw
  return and requires the exact attested fee at settlement.
- Updated local deployment, both demo paths, and the dual-Anvil worker to configure source-plan
  domains, record destination proofs from chain timestamps, execute the signed settlement, and verify
  locked/consumed funding records at every financing checkpoint.
- Added three stateful escrow invariant properties covering 49,152 randomized handler calls per
  full invariant run: total token custody always equals all migration categories, funding status
  always matches spendable supplementary balances, and neither collateral, loan proceeds, nor
  funding can cross-consume the other migration's balance.
- Verification passed: 14 Solidity unit tests, three stateful invariant properties, 15 worker tests
  including a complete externally funded fee route, the repository format/lint/type/test/build gate,
  and both happy and recovery demo commands.

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
