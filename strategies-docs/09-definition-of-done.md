# Definition of done

DebtShift’s first implementation is complete only when every mandatory item below is satisfied.

## Repository and reproducibility

- [ ] A clean checkout can install pinned dependencies.
- [ ] One documented command starts required local infrastructure.
- [ ] One documented command deploys and seeds the local contracts.
- [ ] One documented command runs the happy-path demo.
- [ ] One documented command runs the refund/recovery demo.
- [ ] CI runs the same build and verification commands used locally.
- [ ] No secret, private key, or machine-specific path is committed.

## Product behavior

- [ ] Borrower connects a wallet and sees a source position with block provenance.
- [ ] At least two route outcomes display costs, savings, safety, and rejection explanations.
- [ ] Every route displays reconciled obligations, financing classifications, maximum safe capacity,
      required destination borrow, confirmed external funding, and exact shortfall.
- [ ] No route can become `RESERVED` unless its current feasibility evidence proves zero shortfall.
- [ ] Borrower-funded fees or other supplementary funds are finalized in migration-specific escrow
      before temporary liquidity is committed.
- [ ] Borrower reviews and signs bounded intent and execution-plan data.
- [ ] Source debt closes and collateral release is independently verified.
- [ ] Transport origin and destination receipts are distinct and visible.
- [ ] Destination collateral is supplied and replacement debt is verified.
- [ ] Test funding principal and fee reconcile.
- [ ] Residual assets return to the authorized borrower receiver.
- [ ] Final evidence hash is registered on NEAR testnet and matches the application.
- [ ] Timeline, evidence, ledger, and recovery information survive reload and worker restart.

## Failure behavior

- [ ] Quote expiry before source closure moves no assets.
- [ ] Source revert leaves the source position unchanged and releases reservation.
- [ ] Transport refund enters recovery and verifies actual custody.
- [ ] Wrong destination token, amount, or receiver cannot open the target position.
- [ ] Unsafe destination market state prevents target borrowing.
- [ ] Insufficient quote-time capacity rejects the migration before reservation or source movement.
- [ ] Missing, pending, mismatched, expired, or unconfirmed supplementary funding cannot satisfy the
      feasibility predicate.
- [ ] Collateral-price or liquidity deterioration before source close releases the reservation and
      requires a requote.
- [ ] Capacity deterioration after source close never creates an unsafe loan and opens a recovery case
      with collateral custody and solver exposure recorded.
- [ ] Failed provider payout preserves proceeds and retries idempotently.
- [ ] Failure to repay the solver after collateral delivery blocks `SETTLED` and preserves exact
      proceeds, receivable, and recovery evidence.
- [ ] Unknown provider status stops advancement and alerts.
- [ ] Simulated reorg retracts provisional evidence and re-derives state.
- [ ] Worker/API/Redis interruption does not duplicate asset movement.

## Contract safety

- [ ] TypeScript and Solidity hashes match fixed fixtures.
- [ ] EOA and EIP-1271 signatures are supported as designed.
- [ ] Nonce replay, expiry, and mutated route tests fail.
- [ ] Chain, market, token, receiver, principal, fee, and slippage caps are enforced.
- [ ] Supplementary-funding escrow enforces migration, asset, chain, amount, use, deadline, and refund
      receiver isolation.
- [ ] The liquidity vault rejects reservations with stale, mismatched, or non-zero-shortfall
      feasibility evidence.
- [ ] Reentrancy and cross-migration escrow isolation invariants pass.
- [ ] Administrative roles cannot sweep active migration balances.
- [ ] Pinned Aave source and Morpho destination fork tests pass.

## Data and orchestration

- [ ] PostgreSQL contains signed terms, commands, raw observations, normalized evidence, ledger entries, and audit history.
- [ ] Every phase has an executable entry predicate.
- [ ] Every permitted transition has a test.
- [ ] Every irreversible command has a deterministic idempotency key.
- [ ] Transactional outbox interruption tests pass.
- [ ] Terminal settlement has zero unexplained ledger imbalance.
- [ ] Financing components have unique identities and exclusive classifications; solver principal,
      solver fee, capitalized costs, separate costs, debt prepayment, and external funding reconcile.
- [ ] Feasibility is revalidated before reservation, source closure, target borrowing, and settlement;
      a newer failure supersedes an older passing quote.
- [ ] `COMPLETED` requires verified NEAR receipt registration.

## NEAR registry

- [ ] Agreement and execution-plan hashes can be registered.
- [ ] Only authorized verifiers can append attestations.
- [ ] Conflicting or duplicate finalization is rejected.
- [ ] Verification schemes and actor identities are visible.
- [ ] Contract unit, sandbox, and testnet smoke tests pass.

## Quality and operations

- [ ] Formatting, lint, type checks, builds, and all test layers pass.
- [ ] Dependency, secret, and container scans pass within documented policy.
- [ ] Metrics and structured logs cover all migration phases.
- [ ] Critical alerts are exercised.
- [ ] Recovery and key-rotation runbooks are documented.
- [ ] Deployment manifests identify every contract artifact and configuration.
- [ ] Known limitations and deferred production requirements are documented.

## Agent and data sources

- [ ] Route eligibility, ranking, costs, safety, and authorization caps are deterministic without an LLM.
- [ ] The default agent mode is deterministic and requires no API key or local model.
- [ ] The Route/Risk Agent exposes only the approved read and preparation tools.
- [ ] The user can optionally select local Ollama or a supported user-supplied AI API.
- [ ] Local and remote AI explanations are schema-validated and replaceable by deterministic templates.
- [ ] User API credentials are absent from PostgreSQL, browser persistence, logs, traces, error reports, and analytics.
- [ ] Remote provider requests contain only allowlisted structured explanation data.
- [ ] Custom endpoint validation and SSRF protections pass security tests.
- [ ] Disabling or changing the explanation model cannot change the selected route or signed values.
- [ ] Public API cache, retry, rate-limit, and circuit-breaker behavior is tested.
- [ ] Stale or conflicting indexed data cannot advance an irreversible phase.
- [ ] Execution-critical Aave and Morpho state is read directly from contracts at a recorded block.
- [ ] The Route/Risk Agent computes protocol capacity, DebtShift policy capacity, safe liquidity,
      required borrowing, shortfall, and supported secured resolution alternatives deterministically.
- [ ] The project runs without a paid API subscription.

## Release boundary

- [ ] Live token catalogs and dry quotes may be enabled.
- [ ] Live 1Click access uses the production service in an explicitly named `mainnet-readonly` mode; no testnet endpoint is configured or advertised.
- [ ] All complete debt-refinancing demonstration routes use the simulator and are visibly labeled as simulated.
- [ ] NEAR testnet records simulated receipt hashes without presenting them as 1Click testnet transactions.
- [ ] One isolated `mainnet-canary` obtains a committed quote and completes a real, capped 1Click transfer between team-controlled wallets.
- [ ] The canary records the real correlation ID, terminal status, origin receipt, destination receipt, delivered token, receiver, and amount.
- [ ] The canary input respects the configured base-unit cap and requires manual wallet confirmation.
- [ ] The canary cannot access lending adapters, migration escrow, solver reservations, or the liquidity vault.
- [ ] Real-fund lending transactions and complete mainnet refinancing remain disabled.
- [ ] No documentation claims that the test release is audited, trustless, or production ready.
- [ ] No documentation or UI claims that per-chain smart contracts make the cross-chain refinance
      atomic or guarantee solver repayment.

When all mandatory items are checked, the test-funds DebtShift implementation may be labeled **hackathon-complete**. Mainnet readiness is a separate project phase with separate approval and audit requirements.
