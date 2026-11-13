# Definition of done

DebtShift’s first implementation is complete only when every mandatory item below is satisfied.

## Repository and reproducibility

- [x] A clean checkout can install pinned dependencies.
- [x] One documented command starts required local infrastructure.
- [x] One documented command deploys and seeds the local contracts.
- [x] One documented command runs the happy-path demo.
- [x] One documented command runs the refund/recovery demo.
- [x] CI runs the same build and verification commands used locally.
- [x] No secret, production private key, or machine-specific path is committed; full-history secret
      scanning permits only exact public deterministic Anvil fixtures.

## Product behavior

- [x] Borrower connects a wallet and sees a source position with block provenance.
- [x] Borrower APIs require a one-time EIP-4361 wallet challenge and an opaque, revocable,
      borrower-scoped session whose raw token is never stored server-side.
- [x] At least two route outcomes display costs, savings, safety, and rejection explanations.
- [x] Every route displays reconciled obligations, financing classifications, maximum safe capacity,
      required destination borrow, confirmed external funding, and exact shortfall.
- [x] No route can become `RESERVED` unless its current feasibility evidence proves zero shortfall.
- [ ] Borrower-funded fees or other supplementary funds are finalized in migration-specific escrow
      before temporary liquidity is committed.
- [x] Borrower reviews and signs bounded intent and execution-plan data.
- [x] Source debt closes and collateral release is independently verified.
- [x] Transport origin and destination receipts are distinct and visible.
- [x] Destination collateral is supplied and replacement debt is verified.
- [x] Test funding principal and fee reconcile.
- [x] Residual assets return to the authorized borrower receiver.
- [ ] Final evidence hash is registered on NEAR testnet and matches the application.
- [x] Timeline, evidence, ledger, and recovery information survive reload and worker restart.

## Failure behavior

- [x] Quote or signed-plan expiry before source closure moves no borrower assets: pre-reservation
      expiry performs no chain write, while post-reservation expiry releases the undrawn allocation
      onchain and proves the source position unchanged before terminating `EXPIRED`.
- [x] A proven pre-broadcast source revert or finalized reverted receipt leaves the source position
      unchanged, releases the undrawn reservation onchain, and requires a fresh quote; uncertain
      broadcast/receipt failures never release optimistically.
- [ ] Transport refund enters recovery and verifies actual custody.
- [ ] Wrong destination token, amount, or receiver cannot open the target position.
- [ ] Unsafe destination market state prevents target borrowing.
- [ ] Insufficient quote-time capacity rejects the migration before reservation or source movement.
- [ ] Missing, pending, mismatched, expired, or unconfirmed supplementary funding cannot satisfy the
      feasibility predicate.
- [x] Collateral-price or liquidity deterioration before source close releases the reservation and
      requires a requote.
  - [x] Destination-liquidity deterioration is verified end to end with an atomic proof/release,
        unchanged source position, zero solver receivable, and terminal `REQUOTE_REQUIRED` evidence.
  - [x] Collateral-price deterioration is verified with a mutable protocol-state fixture and exact
        safe-capacity/shortfall evidence.
- [x] Capacity deterioration after source close never creates an unsafe loan and opens a recovery case
      with collateral custody and solver exposure recorded.
- [x] Failed atomic target/payout execution preserves destination collateral, reconciles a possibly
      successful transaction from chain evidence, and retries idempotently; exhaustion opens manual
      recovery with exact custody, receivable, and reserve state.
- [x] Failure to repay the solver after collateral delivery blocks `SETTLED` and preserves exact
      proceeds, receivable, and recovery evidence.
- [x] Unknown provider status stops advancement and opens a durable critical alert without
      inventing a terminal provider state.
- [x] Simulated source receipt disappearance and destination block replacement append retractions,
      halt the next financial action, re-derive recovery state, and require manual reconciliation.
- [x] Worker/API/Redis interruption does not duplicate asset movement: API execution deduplicates,
      PostgreSQL reconstructs failed outbox/stale-command delivery, and restart-every-command plus
      duplicate-message E2E proves one finalized transaction per irreversible action.

## Contract safety

- [x] TypeScript and Solidity hashes match fixed fixtures.
- [x] EOA and EIP-1271 signatures are supported as designed.
- [x] Nonce replay, expiry, and mutated route tests fail.
- [ ] Chain, market, token, receiver, principal, fee, and slippage caps are enforced.
- [x] Supplementary-funding escrow enforces migration, asset, chain, amount, use, deadline, and refund
      receiver isolation.
- [x] The liquidity vault rejects reservations with stale, mismatched, or non-zero-shortfall
      feasibility evidence.
- [x] Reentrancy and cross-migration escrow isolation invariants pass.
- [x] Administrative roles cannot sweep active migration balances.
- [x] The production Aave source and Morpho destination modules pass their atomic rollback tests and
      the complete signed-adapter workflow at pinned Base block `55,600,000`.

## Data and orchestration

- [x] PostgreSQL contains signed terms, commands, raw observations, normalized evidence, ledger entries, and audit history.
- [ ] Every phase has an executable entry predicate.
- [ ] Every permitted transition has a test.
- [x] Every irreversible command has a deterministic idempotency key.
- [x] Transactional outbox interruption tests pass.
- [x] Terminal settlement has zero unexplained ledger imbalance.
- [x] Financing components have unique identities and exclusive classifications; solver principal,
      solver fee, capitalized costs, separate costs, debt prepayment, and external funding reconcile.
- [x] Feasibility is revalidated before reservation, source closure, target borrowing, and settlement;
      a newer failure supersedes an older passing quote.
- [ ] `COMPLETED` requires verified NEAR receipt registration.

## NEAR registry

- [x] Agreement and execution-plan hashes can be registered.
- [x] Only authorized verifiers can append attestations.
- [x] Conflicting or duplicate finalization is rejected.
- [x] Verification schemes and actor identities are visible.
- [ ] Contract unit, sandbox, and testnet smoke tests pass.

## Quality and operations

- [x] Formatting, lint, type checks, builds, and all implemented test layers pass.
- [x] Dependency, full-history secret, and built-container scans pass within documented policy; CI
      also publishes the runtime CycloneDX SBOM.
- [x] Low-cardinality Prometheus metrics enumerate every migration phase and durable operational
      state; structured JSON logs cover preparation, authorization, commands, evidence-derived phase
      changes, retries, failures, and chain context without signed payloads or secrets.
- [x] Critical alerts are exercised.
- [x] Recovery and key-rotation runbooks are documented; the isolated database restore drill
      verifies every public table, exact row count, and migration history without mutating source.
- [x] The migration recovery drill applies all checked-in migrations in an empty sibling database,
      proves transactional DDL rollback, restores a pre-change snapshot after a forward candidate,
      and revalidates migrator idempotency without accessing the application database.
- [x] Deployment manifests identify every contract artifact and configuration.
- [x] Known limitations and deferred production requirements are documented.

## Agent and data sources

- [x] Route eligibility, ranking, costs, safety, and authorization caps are deterministic without an LLM.
- [x] The default agent mode is deterministic and requires no API key or local model.
- [x] The Route/Risk Agent exposes only the approved read and preparation tools.
- [x] The user can optionally select local Ollama or a supported user-supplied AI API.
- [x] Local and remote AI explanations are schema-validated and replaceable by deterministic templates.
- [ ] User API credentials are absent from PostgreSQL, browser persistence, logs, traces, error reports, and analytics.
- [ ] Remote provider requests contain only allowlisted structured explanation data.
- [x] Custom endpoint validation and SSRF protections pass security tests.
- [x] Disabling or changing the explanation model cannot change the selected route or signed values.
- [x] Public API cache, retry, rate-limit, and circuit-breaker behavior is tested.
- [x] Stale or conflicting indexed data cannot advance an irreversible phase.
- [x] Execution-critical Aave and Morpho state is read directly from contracts at a recorded block.
- [x] The Route/Risk Agent computes protocol capacity, DebtShift policy capacity, safe liquidity,
      required borrowing, shortfall, and supported secured resolution alternatives deterministically.
- [x] The project runs without a paid API subscription.

## Release boundary

- [x] `sandbox`, `testnet`, `mainnet-readonly`, and `mainnet` select complete validated adapter sets;
      production modes never fall back to simulation.
- [x] The core workflow contains no simulator dependency and runs unchanged with sandbox/testnet or
      production adapters.
- [x] The hosted sandbox executes real local-chain contracts, signatures, transfers, receipts,
      lending state changes, settlement, and recovery; only the unavailable transport-provider
      boundary is simulated and clearly labeled.
- [ ] Public testnet evidence contains real contract/registry transactions and labels its transport
      evidence simulated rather than claiming 1Click testnet.
- [x] `mainnet-readonly` uses the official production service for live catalogs and dry quotes and
      cannot instantiate write-capable handlers.
- [x] `MAINNET_EXECUTION_ENABLED` is required, defaults to `false`, is rejected as `true` outside
      `mainnet`, and blocks every irreversible command while false.
- [x] `mainnet` implements the complete source repayment, 1Click collateral transfer, destination
      borrow, solver repayment, residual return, and registry path.
- [x] The first production route enforces exact base-unit principal, collateral, fee, slippage, gas,
      receiver, deadline, and recovery-exposure limits.
- [ ] Mainnet deployment occurs with writes disabled; code hashes, roles, balances, route identities,
      live funding, and non-broadcast simulations are verified first.
- [ ] A real attempt, if authorized, occurs only after every prior gate and explicit owner approval;
      the switch is disabled immediately afterward and complete or recovery evidence is retained.
- [x] No documentation claims that the test release is audited, trustless, or production ready.
- [x] No documentation or UI claims that per-chain smart contracts make the cross-chain refinance
      atomic or guarantee solver repayment.

When all mandatory items are checked, DebtShift may be labeled **hackathon-complete**. A small
owner-approved production attempt is evidence for the initial route, not a claim of general public
mainnet readiness or independent audit.
