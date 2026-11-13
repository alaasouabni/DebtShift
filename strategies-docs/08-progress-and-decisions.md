# Progress and decisions

This file is updated throughout implementation. It is the first place to inspect when resuming work.

## Milestone tracker

| Milestone                           | Status      | Started    | Completed  | Evidence / notes                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ----------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy documentation              | COMPLETE    | 2026-11-08 | 2026-11-12 | The complete strategy set now encodes the production-first architecture, four execution modes, contract-backed sandbox, mainnet write gate, and two-day submission plan.                                                                                                                                        |
| M0 Repository foundation            | COMPLETE    | 2026-11-08 | 2026-11-08 | Clean `npm ci`; full TypeScript gate; API/web smoke checks; Compose validation; Foundry build; NEAR fmt/test/clippy/WASM gate all pass.                                                                                                                                                                         |
| M1 Domain and persistence           | COMPLETE    | 2026-11-08 | 2026-11-09 | Runtime schemas, canonical/EIP-712 hashing, signature interfaces, evidence-derived phases, 19-table migration, constraints, and cross-language fixtures pass.                                                                                                                                                   |
| M2 Contract-backed sandbox slice    | COMPLETE    | 2026-11-09 | 2026-11-09 | Browser/API/outbox/worker/dual-Anvil happy, refund, timeout, replay, and restart-at-every-phase checks pass with real contract transactions and PostgreSQL/Redis smoke evidence.                                                                                                                                |
| M3 EVM adapters and fork validation | COMPLETE    | 2026-11-09 | 2026-11-12 | Production Aave and Morpho modules, signed adapters, isolated recovery reserve, and settlement passed the complete current-code workflow at pinned Base block 55,600,000. Unit, fuzz, and invariant gates also pass.                                                                                            |
| M4 Market intelligence              | IN_PROGRESS | 2026-11-09 | -          | Deterministic optimizer, Route/Risk Agent, local onchain comparison, explanation providers, SSRF boundary, and memory-only provider UI pass package/API/web checks.                                                                                                                                             |
| M5 Orchestration and recovery       | IN_PROGRESS | 2026-11-09 | -          | Durable command/outbox workflow, restart/replay coverage, financing checkpoints, refund/timeout/deterioration recovery, reorg guards, exact settlement ledger, all required durable alert classes, and terminal retry-exhaustion/manual financial reconciliation pass; broader operator recovery drills remain. |
| M6 Complete API and web product     | NOT_STARTED | -          | -          | -                                                                                                                                                                                                                                                                                                               |
| M7 NEAR registry                    | IN_PROGRESS | 2026-11-11 | -          | Production-shaped registry, storage accounting, role controls, ordered attestations, immutable receipt lookup, eight Rust unit tests, WASM build, and the Linux sandbox test pass in CI; credentialed public testnet deployment remains.                                                                        |
| M8 Production execution modes       | IN_PROGRESS | 2026-11-10 | -          | Four validated modes, default-off mainnet gate, provider-neutral worker handlers, official committed 1Click lifecycle, real EVM execution, testnet transport, NEAR registry adapters, and production EVM deployment/readiness verification pass focused tests. Live credentialed validation remains.            |
| M9 Security and operations          | IN_PROGRESS | 2026-11-13 | -          | Required alert/security gates, PostgreSQL-backed Prometheus metrics, structured workflow logs, recovery/key-rotation runbooks, and an isolated exact restore drill pass. Tracing, dashboards, migration rollback, and broader provenance remain.                                                                |
| M10 Reproducible release            | IN_PROGRESS | 2026-11-12 | -          | Versioned deployment manifests, guarded deployment/readiness CLIs, green CI, and a clean-volume Docker sandbox with receipt-linked durable ledger reconciliation pass locally. Public hosted URLs, external manifests, and release evidence remain.                                                             |

## Submission-critical mode

- **Time remaining:** one final development/deployment day; confirm the exact portal cutoff and
  timezone before external deployment starts.
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

- **Task:** P0.5/P0.7 - finish safe operational and recovery gates that do not require external
  credentials, then deploy the verified full sandbox image and registry and collect public evidence.
- **Status:** IN_PROGRESS
- **Next verification:** Complete the repository and clean-stack gate for each internal checkpoint.
  When hosting and NEAR credentials are available, deploy the hosted sandbox and NEAR testnet
  registry, run the public testnet workflow, perform an authenticated official 1Click dry quote when
  a token is available, then execute acceptance. The Linux NEAR CI, pinned Base fork, live route,
  official schema, security audit, and clean Docker gates already pass.

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

### ADR-023 - Receipt-linked durable ledger with explicit accounting basis

- **Status:** APPROVED
- **Date:** 2026-11-13
- **Decision:** A finalized settlement writes its validated reconciliation and every component row
  atomically in PostgreSQL. Each row has a stable component identity, contiguous sequence, exact
  chain/token identity, same-migration finalized evidence link, and an explicit accounting basis.
- **Movement basis:** `FINALIZED_MOVEMENT` is reserved for receipt-verified value movement. The
  source payoff, isolated recovery-reserve lock/consumption/refund, collateral custody legs,
  destination loan proceeds, supplementary funding, solver principal/fee payout, capitalized-cost
  payout, and residual return reconcile independently without cross-chain or cross-token netting.
- **Classification basis:** `SIGNED_COST_CLASSIFICATION` records a signed `SEPARATELY_PAID` cost
  exactly once and links it to finalized financing evidence. It is deliberately not represented as
  a paid transaction and cannot increase destination borrowing or satisfy the solver obligation.
- **P0 boundary:** Solver-advanced and capitalized costs remain fail-closed before reservation for
  the initial route because its signed plan has no receipt-verifiable cost recipient. Supporting
  those classes later requires an explicit signed recipient and execution evidence, not a ledger-only
  assertion.
- **Required equations:** Destination loan proceeds plus finalized supplementary funding equal
  principal, fee, capitalized payout, and residual; locked recovery reserve equals consumed
  principal/fee plus refund; unexplained imbalance is exactly zero.
- **Reason:** The terminal evidence bundle previously contained a reconciliation marker but no
  durable ledger rows. A settlement claim must be independently queryable and must distinguish
  observed transfers from signed economic classifications.

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

### 2026-11-13 - Authoritative metrics and structured workflow logs

- Added `GET /v1/metrics` in Prometheus text format. It reads authoritative PostgreSQL aggregates
  for all 14 phases, phase-age histograms, transitions, commands/attempts, evidence, chain finality,
  transport, reservations, recoveries, alerts, outbox, and ledger state without identifiers in
  labels.
- Added structured JSON workflow records for API preparation/authorization and worker command
  start, reconciliation, evidence persistence, evidence-derived phase, retry failure, exhaustion,
  and success. Records contain correlation IDs, command type, phase, and chain where applicable but
  no signed payload, credential, or private key.
- Added one PGlite aggregation integration test, one Prometheus escaping/histogram test, and worker
  lifecycle log assertions. The full repository gate passed: database 17 tests, API 10 tests, worker
  55 tests, formatting, lint, types, and builds.
- Rebuilt the production-shaped local image and exercised the preserved Docker stack. The endpoint
  returned HTTP 200 with the Prometheus content type and real non-zero phase, command, reservation,
  alert, transport, and ledger series.
- After resetting only the disposable Anvil service, the strengthened signed HTTP-to-chain smoke
  reached `SETTLED` with migration
  `0x91a73a4fad92ad8c2aa564efb3063a5ccd13f6c72cacc645d1c294417e948c74`, 17 evidence records,
  16 ledger entries, zero unexplained imbalance, and `metricsVerified: true`; its structured log
  covered the complete executable phase chain. Sandbox NEAR receipt registration remains
  intentionally pending without credentials.
- Mainnet execution remained disabled; no external deployment, credential use, mainnet broadcast,
  or real-fund movement occurred.

### 2026-11-13 - Operator runbooks and isolated database restore drill

- Added executable runbooks for containment, worker restart, RPC failover, Redis reconstruction,
  stuck reservations, transport refunds/unknown custody, destination recovery, capacity loss,
  supplementary funding, solver payout failure, emergency pause, evidence mismatch, and closure.
- Documented add-before-remove EVM relayer and NEAR verifier rotation while preserving the actual
  contract boundary: the first EVM deployment requires a stable owner multisig and does not claim a
  universal ownership-transfer path.
- Added `npm run ops:drill:database-restore`. It creates a custom-format PostgreSQL backup, restores
  only into a randomly named sibling database, verifies the public table set, exact row counts, and
  Drizzle migration history, and removes the isolated database and temporary artifact.
- The drill passed against the preserved Docker stack: 21 public tables, 386 rows, 153,366 backup
  bytes, SHA-256 `2cddef6e57012668c3d8b147eb08c9763212ac0ae6065002fbdb87fb0ab13e60`,
  and no source-database mutation.
- Mainnet execution remained disabled; no deployment, credential use, broadcast, or real-fund
  movement occurred.

### 2026-11-13 - Fail-closed security scans and minimized runtime image

- Added a dedicated CI security job: zero high/critical production npm findings, full-history
  Gitleaks `8.30.1`, and a Trivy `0.76.2` scan of the actual built runtime image. Third-party actions
  added by this gate are pinned to immutable commit SHAs, and the scan emits a retained CycloneDX
  SBOM.
- Gitleaks initially identified thirteen known local-fixture matches across history. The configuration
  allowlists only the exact two public Anvil keys and two deterministic Anvil token addresses; a
  second scan covered all 25 commits and found no unallowlisted leak.
- The first container scan correctly rejected the former Node `22.16.0`/Debian `12.11` image for
  five fixable critical OS findings, vulnerable package-manager dependencies, and additional high
  findings. No CVE or file path was ignored.
- Refreshed Node to `22.23.5`/Debian `12.15` at immutable digest
  `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee` and converted the image to
  a multi-stage runtime without npm, Corepack, Yarn, curl, or unused Foundry binaries. Compose now
  invokes the database migrator and Next server directly with Node.
- The rebuilt `debtshift-app:local` manifest list is
  `sha256:e2613a413de5d1ef6cc97084adf1d4550760cf4bc76a9396c6a5654065b50a08`.
  Trivy reports zero fixable high/critical OS or library findings, and the production npm audit
  reports zero vulnerabilities.
- A separate non-failing inventory reports 35 Debian high/critical package associations for which
  the current security feed supplies no fixed version (`affected`, `fix_deferred`, or
  `will_not_fix`); several CVEs repeat across related util-linux packages. They remain an explicit
  upstream-base review item before any real-fund release and are not represented as resolved.
- A full Compose recreate preserved database/Redis volumes, migration exited `0`, all long-running
  roles became healthy, and `npm run smoke:local` completed a signed contract-backed refinance at
  migration `0xc469782becebcd32b21ac8edf8fc728c9b332a8a0d608fa8ccea2b053d262654`:
  `SETTLED`, 17 evidence records, 16 ledger rows, and zero unexplained imbalance.
- No public-chain write, provider commit, external deployment, mainnet write, or real-fund movement
  occurred. `MAINNET_EXECUTION_ENABLED` remains false.

### 2026-11-13 - Terminal transport and NEAR receipt alerts completed

- Added terminal transport reconciliation against the provider leg, verified destination/refund
  transaction, observed base-unit amount, and durable recovery evidence. A `SUCCESS` state without
  matching destination balance evidence, a refund without exact recovery evidence, or a known
  terminal custody state without recovery now opens `TRANSPORT_TERMINAL_MISMATCH`.
- Added the distinct `DESTINATION_FUNDING_BELOW_MINIMUM` critical condition so a provider-success
  label cannot hide delivery below the signed minimum.
- Added durable NEAR receipt verification for every stored final receipt: agreement identity,
  terminal status, raw receipt hash, canonical bundle re-hash, and deterministic evidence ID must
  all agree. A `COMPLETED` migration with no active finalized NEAR receipt is also critical.
- Expanded the PGlite drill from fourteen to seventeen simultaneous conditions and proved exact
  deduplication, severity escalation, repaired-receipt recognition, terminal resolution, and
  history preservation. The fixture distinguishes the provider's destination transaction from the
  separate on-chain delivery action that anchors the evidence.
- Preserved-state restart validation caught and corrected an initial comparison between those two
  distinct transaction hashes. The corrected worker matched each terminal leg against
  `normalizedPayload.observation.destinationTransactionHash`, resolved all five false alerts
  without modifying application data, and left only the expected three terminal NEAR-finalization
  failures plus five stale sandbox migrations open.
- `npm run check` passes formatting, lint, type checking, all builds, and 180 tests (three
  environment-gated fork tests skipped). The rebuilt `debtshift-app:local` manifest list is
  `sha256:e92e51e638a228823548e5be6df53ab53523184e86a9b03991affe54afa4f309`; the image build also
  passed the Solidity/workspace builds and reported zero production dependency vulnerabilities.
- No external deployment, provider commit, public-chain write, mainnet write, or real-fund movement
  occurred. `MAINNET_EXECUTION_ENABLED` remains false.

### 2026-11-13 - Financial and custody alert coverage completed

- Extended the durable scanner from six workflow-health conditions to fourteen P0 conditions. New
  critical paths cover reservation underfunding, retracted/rejected chain evidence, invalid or
  persistence-divergent settlement ledgers, expired financing feasibility, missing or expired
  supplementary funding, capacity/policy deterioration, outstanding solver exposure, and target
  opening/atomic payout failure after verified destination delivery.
- Financial predicates use only active finalized evidence. A retraction/rejection supersedes its
  original record, supplementary contributions reconcile to signed evidence identifiers and exact
  units, and ledger alerts compare the schema-validated reconciliation with every durable component
  row rather than trusting a phase label.
- Alert scans now bound financial queries to active migration identifiers. The PGlite integration
  drill opens all fourteen conditions, proves deterministic deduplication and deadline severity
  escalation, then resolves all records without deleting their history.
- `npm run check` passes with 180 tests and all production builds. Rebuilt image
  `debtshift-app:local` (manifest list
  `sha256:fef94b68810aca8f564b35ef15fa13c3aec7c7320ad017cc2972707ede3f1919`) reports zero
  production dependency vulnerabilities. The recreated worker started cleanly against preserved
  PostgreSQL/Redis/chain state.
- The first preserved-database scan opened no false new financial conditions. Its eight existing
  alerts are evidence-backed: five stale `SETTLED` migrations and three terminal
  `FINALIZE_NEAR_RECEIPT` commands from the intentionally unconfigured sandbox registry history.
- No external deployment, provider commit, public-chain write, mainnet write, or real-fund movement
  occurred. `MAINNET_EXECUTION_ENABLED` remains false.

### 2026-11-13 - Financial retry exhaustion made durable and recoverable

- Fixed the queue/processor boundary so BullMQ's configured final attempt is explicit. A command
  that exhausts retryable failures now becomes `FAILED_TERMINAL` instead of remaining stranded as
  `FAILED_RETRYABLE` after the queue stops delivering it; the terminal-command alert can therefore
  surface every exhausted command.
- Target opening and solver payout remain one atomic destination transaction. An unconfirmed result
  is retried through receipt reconciliation; exhaustion opens manual target/payout reconciliation
  with last verified destination collateral, the exact solver receivable, and the locked recovery
  reserve. No automatic recovery command is scheduled against uncertain custody.
- Origin dispatch and official 1Click submission/status failures now cross the provider boundary as
  workflow-retryable errors. Dispatch exhaustion records exact vault/collateral custody and solver
  exposure in manual recovery instead of leaving a queue-exhausted command retryable forever.
- Post-payout source-vault settlement is also retried idempotently. Exhaustion blocks `SETTLED` and
  stores the finalized target/payout receipt, exact principal and fee claim, target collateral and
  debt, payout receiver, and locked reserve in a manual recovery case.
- Added processor and queue boundary tests, focused handler tests for both target/payout and
  settlement exhaustion, and a real dual-Anvil/PGlite workflow that reaches `TARGET_OPEN`, injects
  final-attempt settlement failure, and proves terminal command state, open manual recovery, no
  automatic recovery command, and no false ledger rows.
- `npm run check` passes with 180 implemented tests and all production builds. Rebuilt image
  `debtshift-app:local` (manifest list
  `sha256:95908a79fb4a75b6d466aaf6f7db0f0284f7fcd90245f7059ef4d81e13823181`) passed
  Solidity/workspace builds and reports zero production dependency vulnerabilities; the recreated
  worker started cleanly without changing PostgreSQL, Redis, or chain state.
- After reseeding only the disposable Anvil fixture, signed HTTP-to-chain smoke migration
  `0x5c6fd0b0af43503ed3342231d5c6a1943970b200ce4d7034f4c7eb8b3edfe02b` reached `SETTLED` with 17
  evidence records, 16 ledger rows, and zero unexplained imbalance. PostgreSQL and Redis volumes
  were preserved.
- No external deployment, 1Click commit, public-chain write, mainnet write, or real-fund movement
  occurred. `MAINNET_EXECUTION_ENABLED` remains false.

### 2026-11-13 - Durable operator-alert scanner implemented and stack-verified

- Added migration `0009` and the append-preserving `operational_alerts` table with deterministic
  identifiers, per-condition deduplication, warning/critical severity, first/last observation times,
  structured details, and explicit open/resolved lifecycle state.
- The worker now serializes periodic alert scans and emits structured change warnings. The first P0
  set covers signed execution deadlines, stale active migrations, stale recovery cases, unknown
  transport custody, terminal command failures, and a settled migration missing ledger rows.
- Added environment-validated scan, deadline-lead, stale-migration, and stale-recovery thresholds.
  These operational timers do not extend a signed execution deadline or advance workflow state.
- The PostgreSQL-compatible integration test opens all six conditions, proves repeated-scan
  deduplication, escalates a crossed deadline from warning to critical, and resolves every row after
  the affected migrations become terminal. The schema test also asserts the new table and its
  critical identity/deduplication constraints.
- `npm run check` passes formatting, lint, the complete TypeScript graph, 172 implemented tests, and
  all ten production builds. The rebuilt application image passed Solidity and workspace builds;
  its pruned production dependency graph reports zero vulnerabilities.
- Applied migration `0009` to the existing Compose database without deleting PostgreSQL or Redis
  volumes. The scanner immediately exposed five real pre-existing alerts: two terminal NEAR receipt
  commands and three stale settled migrations. This validates useful detection rather than a
  synthetic log-only path.
- Signed HTTP-to-chain smoke migration
  `0x5fd920ecf70cc839fc2fbaa4ad5d4e2bad3528bd427ed460ef6e6bdf2f3f067d` reached `SETTLED` with 17
  evidence records, 16 durable ledger rows, zero unexplained imbalance, and no alert for that fresh
  migration.
- No external deployment, 1Click commit, public-chain write, mainnet write, or real-fund movement
  occurred. `MAINNET_EXECUTION_ENABLED` remains false.
- Checkpoint `76d6eaf` is on `main`; GitHub Actions run `43354856752` passed the TypeScript gate,
  all EVM contract/deployment/API/worker/demo gates, and the Linux NEAR sandbox gate.

### 2026-11-13 - Unknown 1Click state and retry boundary hardened

- Changed official 1Click status parsing so a future undocumented provider state is still validated
  against the signed quote/deposit binding, hashed, and returned as a fail-closed `UNKNOWN`
  observation instead of being discarded by schema parsing.
- The production transport adapter now persists that raw response in `provider_observations`; the
  workflow also records `UNKNOWN` on the transport leg, emits no destination evidence, and performs
  no target action.
- Before the signed deadline, ambiguous custody raises only a retryable command failure. At or after
  the deadline it appends `MIGRATION_EXPIRED` and `RECOVERY_OPENED` with
  `AMBIGUOUS_CUSTODY_DEADLINE_EXCEEDED`, preserving custody uncertainty for an operator rather than
  inventing a provider terminal state.
- Made BullMQ command attempts, exponential base delay, and stale-worker lease recovery explicit,
  bounded, environment-validated configuration. Provider HTTP retry, timeout, token-bucket rate
  limiting, cache/coalescing, and circuit-breaker tests were already present and remain green.
- Focused verification passes: 24 intents tests, 41 domain tests, 46 worker tests, the TypeScript
  project graph, formatting, and Compose configuration validation.
- The complete repository check passed, the updated production image rebuilt with zero npm
  vulnerabilities, and in-place Compose smoke migration
  `0xecf74088a1225d1ec58e8b517c4e964ef214b0533f4261199561b39ba738e110` reached `SETTLED` with
  17 evidence records, 16 durable ledger entries, and zero unexplained imbalance.
- Checkpoint `32886b8` is on `main`; GitHub Actions run `43347466040` passed TypeScript, all EVM
  contract/deployment/API/worker/demo gates, and the Linux NEAR sandbox gate.

### 2026-11-13 - Durable settlement ledger implemented and clean-stack verified

- Found that the contract-backed smoke migration reached `SETTLED` with finalized reconciliation
  evidence while `ledger_entries` remained empty. Added a strict reconciliation schema, migration
  `0008`, evidence-linked component identities, and transactional persistence with conflict checks.
- Encoded exact source payoff, recovery-reserve lock/consumption/refund, source and destination
  collateral custody, destination loan proceeds, supplementary funding, solver principal/fee
  payout, capitalized payout, and residual rules. PostgreSQL rejects missing or cross-migration
  evidence links, duplicate components/sequences, partial persistence, or conflicting replays.
- The first clean smoke correctly failed at `TARGET_OPEN` because the local plan's five legitimate
  `SEPARATELY_PAID` cost estimates had no ledger representation. ADR-023 resolves them as explicit
  signed classifications rather than fabricated payments; solver-advanced and capitalized costs
  remain unsupported by the P0 recipient contract and fail before reservation.
- Final clean-volume Compose smoke migration
  `0xd1a0a73968d4c086654a28e5d3ac79b6458917bca1094ed85f601de92b6ed9a7` reached `SETTLED` with
  17 evidence records, 16 durable ledger rows, exact principal/fee and reserve refund, and zero
  unexplained imbalance. Five rows are visibly marked `SIGNED_COST_CLASSIFICATION`; the remaining
  11 are `FINALIZED_MOVEMENT` rows.
- Focused validation passed 40 domain tests, 15 database tests, and 20 worker handler/E2E tests.
  The complete repository format/lint/type/test/build gate and both EVM gates pass; production npm
  audit reports zero vulnerabilities.
- GitHub Actions run `43340230804` is fully green: TypeScript, all EVM gates/demos, and the Linux
  NEAR format/unit/Clippy/WASM/sandbox gate. The official Base RPC also passed the pinned fork at
  block `55,600,000`; the live route and official 1Click catalog/schema gates pass without writes.
- Docker Desktop produced one diagnosed BuildKit `missing parent snapshot` export error after the
  deliberate volume reset. The unchanged cached build succeeded on retry; this was an image-store
  cache fault, not an application retry or a suppressed test failure.
- No external deployment, committed 1Click request, NEAR registry write, public-chain transaction,
  mainnet write, or real-fund movement occurred. `MAINNET_EXECUTION_ENABLED` remains false.

### 2026-11-13 - Full hosted-sandbox image and signed HTTP-to-chain workflow verified

- Replaced the database-only Compose definition with a complete stack: PostgreSQL, Redis, two
  private Anvil chains, one-shot migrations, API, durable worker, and web. Service startup is ordered
  by health and migration completion rather than timing assumptions.
- Added a reproducible Linux image pinned to Node `22.16.0` and checksum-verified Foundry `1.5.1`.
  It builds Solidity artifacts and all ten workspaces from a clean context, then removes development
  dependencies. The pruned runtime dependency graph reports zero npm advisories.
- Made the long-running sandbox chains network-addressable without changing the loopback default
  used by tests. One-second private-chain block production preserves the production freshness policy;
  an explicit ready marker prevents API/worker startup until contract deployment, source-position
  seeding, vault funding, and destination liquidity are complete.
- Updated the external smoke client for the current authorization contract: it submits both prepared
  source and target lending authorizations and uses a bounded 120-second settlement deadline suitable
  for interval-mined receipts and provider polling.
- Upgraded `near-api-js` from `6.5.1` to `7.2.0`, adapted the v7 provider API, and removed the
  production transitive crypto advisory. Worker type checking/build, all 40 worker tests, and the
  production audit pass.
- Fresh cache-bypassed workspace validation passed all 40 lint/typecheck/test/build tasks. The full
  pruned stack then completed signed migration
  `0x4fa345b2ec07e5a014f215036b8ede2b910dcdc9a5dfbcfdb61999b789bc88c8` to `SETTLED` with 17
  persisted evidence records.
- This was local disposable sandbox activity only. No external deployment, public-chain transaction,
  1Click committed request, NEAR registry write, mainnet write, or real-fund movement occurred.
- Still required: Linux CI/NEAR proof, trusted pinned-fork rerun, credentialed official 1Click dry
  quote, NEAR sandbox/testnet deployment, public hosting, public EVM testnet exercise where feasible,
  acceptance, and mainnet-disabled production deployment.

### 2026-11-12 - Production deployment evidence and account handoff checkpoint

- Added a strict version-1 EVM deployment manifest covering route-file hash, exact Aave and Morpho
  identities, owner/executor roles, deployment and configuration transactions, canonical block
  hashes, and runtime bytecode hashes. Manifests contain no RPC URLs or private keys and cannot be
  overwritten by the deployment CLI.
- Added the production deployment module for the real `LiquidityVault`, source/destination escrows,
  Aave source module, Morpho target module, and signed adapters around existing protocol deployments.
  It does not deploy test tokens, protocol mocks, positions, or liquidity.
- Added a separately guarded external-write CLI. It requires explicit deployment approval, keeps
  `MAINNET_EXECUTION_ENABLED=false`, and requires an exact additional phrase for mainnet contract
  deployment. No external deployment command was run in this session.
- Added a wallet-free readiness verifier that checks canonical deployment/configuration receipts,
  code hashes, chain IDs, live Aave reserve bindings, live Morpho market parameters, immutable
  contract bindings, operators/verifiers/assets, source plan-domain allowlisting, pause state, vault
  liquidity, and executor gas floors.
- Added a two-Anvil deployment integration test using the production Aave/Morpho modules. The test
  deploys the seven DebtShift contracts, verifies the manifest and roles, and proves that a tampered
  runtime-code hash fails closed. `npm run check:evm-deployment` passes two tests.
- `npm run check` passes formatting, lint, type checking, package tests, dual-chain workflow and
  recovery scenarios, and all production builds. `npm run check:evm` passes 33 Solidity tests,
  including the 1,000-run Morpho property case and three 16,384-call invariants.
- The read-only live-route gate passed at Base block `56,649,525` and Arbitrum block `523,682,852`.
  It verified the configured Aave reserve, Morpho market, current oracle observations, available
  borrow liquidity, and both exact assets in the official 1Click catalog.
- The official 1Click OpenAPI drift gate passed for `/v0/quote`, `/v0/status`, and
  `/v0/deposit/submit`; the observed document SHA-256 was
  `9a2e676682aa6dec6905c82f1b2cc0ec72eda97964369aa51ec35eb82ccac0a3`.
- The remaining local NEAR aggregate gate is not a code failure: this Windows host has no Cargo.
  Docker daemon access is available, but the pinned Rust image download was interrupted before the
  container gate ran. The Linux CI job installs Rust 1.95/cargo-near and now includes the NEAR sandbox
  test after unit, Clippy, and WASM checks.
- The current fork rerun is credential-blocked by absent `BASE_FORK_RPC_URL`; the previously recorded
  pinned Base proof remains valid for the earlier commit but must be rerun for final release evidence.
- Exact resume instructions are in `15-account-handoff.md`. No testnet/mainnet contract deployment,
  committed 1Click request, transaction broadcast, registry write, or fund movement occurred.

### 2026-11-12 - Production execution, isolated recovery reserve, and executable scenarios

- Implemented production EVM execution ports for liquidity reservation, exact Aave source close,
  escrow dispatch, destination feasibility, atomic Morpho opening, settlement, recovery, and
  reconciliation. Startup verifies chain IDs, deployed code, immutable bindings, roles, assets,
  markets, operators, and deployment-block-bounded event history.
- Extended the official 1Click client and worker adapter through committed quote construction,
  origin transaction binding, persisted raw observations, success/refund/ambiguous custody mapping,
  and destination transaction evidence. The disabled mainnet switch constructs no write adapter and
  permits no deposit or broadcast.
- Added an onchain, migration-specific recovery reserve to the permissioned `LiquidityVault`.
  Reservation atomically locks solver funds covering principal plus fee cap; normal settlement
  consumes only the actual obligation and refunds unused debt buffer, while failed-forward recovery
  settles the vault from the already isolated reserve.
- Added the real NEAR registry worker adapter with agreement registration, append-only finalized
  attestations, immutable terminal receipt verification, and idempotent replay. Hosted production
  sandbox startup now fails unless real registry/verifier credentials are configured; development
  mode may stop fail-closed at pending registry instead of fabricating success.
- Promoted the production contract from the test-only `TestLiquidityVault` identity to
  `LiquidityVault` and updated all deployments, adapters, demos, and fork fixtures.
- Current executable proof: both dual-chain happy and failed-safe recovery demos pass; the worker
  suite passes 40 tests; the intents package passes 24 tests; and the EVM gate passes 33 tests,
  including the 1,000-run Morpho fuzz case and three 16,384-call invariant runs.
- Still required: credentialed live 1Click dry quote, NEAR sandbox/testnet deployment, hosted sandbox,
  public testnet exercise, CI NEAR/release evidence, and non-broadcast mainnet verification. No
  mainnet write or real-fund action has occurred.

### 2026-11-12 - Current live route and provider surfaces verified

- Added the versioned Base Aave V3 WETH/USDC to Arbitrum Morpho Blue WETH/USDC route manifest. It
  binds exact chain, protocol, market, token, oracle, sequencer, 1Click asset, and policy identities.
- Added a repeatable read-only route verifier. It checked the current Base Aave reserve identities,
  Arbitrum Morpho market parameters and liquidity, deployed bytecode, live Chainlink prices and
  sequencer state, and exact assets in the public official 1Click catalog.
- The observed Morpho market had 86% LLTV, 10,693.760135 USDC available liquidity, and a 7.13% current
  borrow APR. These are time-stamped observations, not hardcoded authorization values; execution must
  re-read them and pass freshness/economic policy again.
- Reran the complete production adapter workflow at pinned Base block `55,600,000` after the recovery
  reserve change. Source close, exact receivable propagation, destination borrow, settlement, native
  Morpho authorization revocation, and zero-residual assertions passed.
- Added a read-only drift gate against the official 1Click OpenAPI document and verified the quote,
  status, and deposit-submit schemas. A credentialed live dry quote remains blocked only by the absent
  `INTENTS_AUTH_TOKEN`; no quote reservation, deposit, transaction, or fund movement was attempted.
- `npm audit --omit=dev --audit-level=high` passed. It reports 11 low-severity transitive findings in
  the `near-api-js` cryptography chain; the automated remediation requires a breaking major upgrade,
  so that upgrade is deferred until it can be regression-tested rather than forced before submission.
- Local NEAR verification remains unavailable on this Windows host because Cargo is not installed.
  The CI workflow installs pinned Rust/cargo-near and is the release evidence source for that gate.

### 2026-11-12 - Four-mode runtime and provider-neutral worker boundary implemented

- Replaced `local`, `ci`, `mainnet-canary`, and `mainnet-controlled` runtime values with exactly
  `sandbox`, `testnet`, `mainnet-readonly`, and `mainnet`. Removed canary configuration and made
  legacy variables fail startup instead of silently selecting defaults.
- Added `MAINNET_EXECUTION_ENABLED=false` by default. API scheduling and all worker command handlers
  reject mainnet execution while disabled; `mainnet-readonly` constructs no write-capable adapters.
- Required explicit execution deployment addresses in testnet and mainnet so production cannot
  inherit deterministic Anvil addresses. Renamed sandbox-only executor configuration accordingly.
- Replaced the simulator-specific handler factory with one workflow over execution, transport, and
  receipt-registry ports. Evidence provider identities are injected, and strict composition rejects
  mode or transport-provider mismatches.
- Kept the deterministic transport implementation behind a sandbox adapter while the same handler
  flow continues to execute real dual-Anvil contract transactions and independently verified
  receipts. Transport evidence now rejects provider and simulated/live mode mismatches.
- Generalized route preparation and UI metadata from a simulation-only response to runtime execution
  metadata. Live protocol routes can expose explicit testnet/mainnet execution bindings, while
  `mainnet-readonly` remains non-executable.
- `npm run check` passed across all ten workspaces: formatting, lint, typecheck, 138 TypeScript tests
  (with the opt-in production fork test skipped), and production builds including Next.js.
- No mainnet transaction, committed 1Click request, external deployment, or fund movement occurred.
  The worker still fails closed when testnet or enabled-mainnet adapters are absent.

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
