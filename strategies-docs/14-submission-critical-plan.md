# Submission-critical delivery plan

## Purpose and deadline

This document is the durable priority override for the DebtShift submission window. It exists so
the deadline plan survives chat compaction, a new work session, or a contributor handoff.

- **Plan revised:** 2026-11-13
- **Time remaining:** one final development/deployment day, as confirmed by the project owner
- **Portal cutoff:** exact date, time, and timezone still require confirmation
- **Verified public-testnet foundation:** `7b59a4f` on `main`; GitHub quality run `43459443566`
  passed every TypeScript, EVM, NEAR, security/container, and runtime-SBOM job for exact commit
  `7b59a4fffb94ceeec333b430be8baa35f5e3c9cf`.
- **Verified hardened public-testnet route checkpoint:** `f73b9df` on `main`; GitHub quality run
  `43465347172` passed every job for exact commit
  `f73b9df5e1c915a619c94128e28e207569228647`. The candidate uses official Ethereum Sepolia Aave
  plus independent official Chainlink source planning feeds to a Base Sepolia canonical-source
  Morpho deployment. The byte-exact dependency hash is
  `0x2186a31423918d16f0e712a233d3dd5dd392eaeb4604ddc2b138e12a297d7f17`. A deterministic,
  source-commit-bound generator now creates the executable route only after the Morpho manifest
  exists and rejects every dependency/manifest/policy mismatch. Testnet omits unavailable 1Click
  asset IDs; mainnet modes still require official IDs.
- **Verified production/fork foundation:** checkpoint `b7413ec`; GitHub quality run `43409934145`
  passed every job and the pinned Base block `55,600,000` fork passed against the official free RPC.
- **Primary objective:** finish normal, functional production-oriented code for one complete
  Aave-to-Morpho refinance through official NEAR Intents/1Click, prove that code with contract-backed
  sandbox, testnet, fork, and integration tests, then deploy and attempt one small mainnet refinance
  only at the end.

This plan changes priority, not engineering truth. Incomplete requirements remain visible in
`02-implementation-roadmap.md` and `09-definition-of-done.md`; they must not be marked complete
without evidence.

## Architectural decision

DebtShift has one provider-neutral refinance workflow. Simulation is an adapter for testing that
workflow, never a second business-logic implementation and never the primary product architecture.

The workflow depends on explicit ports for:

- source position verification and close;
- solver/vault reservation and funding;
- transport quote, deposit binding, status, refund, and destination delivery;
- destination feasibility, collateral supply, and borrowing;
- solver repayment, fee payment, residual return, and ledger reconciliation;
- chain canonicality, receipt verification, and NEAR receipt registration.

The core worker must not import simulator implementations. A composition root selects adapters
after validated environment parsing. Production modes never fall back to simulated providers.

## Runtime modes

| `DEBTSHIFT_MODE`   | Purpose                                           | Required behavior                                                                                                                                                                               |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox`          | Hosted or developer-operated private local chains | Real deployed contracts, signatures, transactions, receipts, balances, events, database workflow, and worker orchestration; only the unavailable external transport boundary is simulated.      |
| `testnet`          | Public test-network validation                    | Real public testnet contracts, wallets, transactions, confirmations, explorer evidence, and NEAR testnet registry; transport remains explicitly simulated because 1Click has no public testnet. |
| `mainnet-readonly` | Production discovery and preflight without writes | Real Aave, Morpho, oracle, RPC, gas, 1Click catalog, and `dry: true` quote reads; no write-capable execution runtime or transaction broadcast.                                                  |
| `mainnet`          | Complete production execution                     | Real vault, Aave close, committed 1Click transport, Morpho open, solver settlement, residual return, and production registry evidence.                                                          |

Local development and CI reuse the `sandbox` adapters and may run the private chains in-process.
They are engineering environments, not separate judge-facing product modes.

## Mainnet execution switch

`MAINNET_EXECUTION_ENABLED` is a mandatory, fail-closed server environment variable.

- It defaults to `false`.
- It must be `false` in `sandbox`, `testnet`, and `mainnet-readonly`.
- In `mainnet`, `false` permits configuration validation, live reads, committed-plan and quote
  construction, transaction construction, and non-broadcast simulation, but rejects liquidity
  reservation, provider deposit, transaction broadcast, contract write, and registry write commands
  before side effects.
- In `mainnet`, only the exact lowercase string `true` permits irreversible commands.
- A process restart is required after changing the variable.
- The frontend may display the effective capability but cannot change it.
- The switch is not sufficient authorization: signed limits, allowlists, freshness, funding,
  idempotency, contract roles, and pause state must still pass independently.

## Contract-backed simulation rule

The sandbox must not return invented application success. It must execute actual transactions on
private local chains:

1. Deploy tokens, lending markets, adapters, escrows, and the liquidity vault.
2. Seed a real source position and vault balance.
3. Reserve funds and close the source position through the same signed workflow used in production.
4. Require a finalized source escrow/deposit transaction before simulated transport advances.
5. Simulate the external provider by executing a real destination-chain release transaction and
   returning its real transaction hash and amount.
6. Independently verify the destination receipt and balance.
7. Open the target position, settle the vault, and return residuals through real contract calls.
8. Persist and verify the complete evidence and ledger trail.

Refund, timeout, partial-delivery, wrong receiver, reorg, and market-deterioration scenarios must
also create observable contract and custody state. A status string alone never proves asset movement.

## Initial production scope

The first production implementation supports one configured route, not a generic protocol matrix:

- one source chain and official Aave V3 deployment;
- one exact source collateral/debt reserve pair;
- one destination chain and exact Morpho Blue market identity;
- one exact destination collateral/debt pair;
- one deployed source adapter, destination adapter, vault, and escrow set;
- one official 1Click collateral route discovered and validated from the production catalog;
- one borrower-controlled source position;
- one solver/vault payout receiver and one recovery reserve;
- one bounded maximum principal, collateral amount, solver fee, slippage, gas budget, and deadline.

These are versioned deployment configuration and policy, not hardcoded business logic. Adding routes
later must require configuration and validation, not rewriting the workflow.

## Required funding guarantees

No source debt may close unless all of the following are proven from fresh state:

- the vault has isolated the exact maximum source payoff plus the authorized execution buffer;
- the destination safe borrowing capacity plus finalized supplementary funding covers solver
  principal, solver fee, capitalized costs, and any other settlement obligation with zero shortfall;
- the 1Click minimum destination collateral still supports that borrowing under the signed stress
  policy;
- the committed quote, destination escrow, refund receiver, and deadline are bound to the signed
  execution plan;
- a separately isolated recovery reserve covers the configured post-source-close emergency exposure;
- gas balances exist for every required relayer transaction without using borrower keys.

The initial solver is permissioned and pre-funded. A public solver marketplace and legal credit
model are post-submission work.

## Required authorizations

- Before borrower-scoped API access, the connected wallet signs a five-minute, one-time EIP-4361
  challenge. This login proof creates an eight-hour opaque session and does not authorize a
  refinance, transaction, liquidity reservation, or provider deposit.
- Raw session tokens exist only in `HttpOnly`, `SameSite=Strict` cookies; PostgreSQL stores only
  SHA-256 token hashes. Production public origins must use HTTPS, sessions are revocable, and every
  borrower/migration route verifies session ownership.
- Borrower signs a broad bounded `RefinanceIntent` and one short-lived exact `ExecutionPlan`.
- The plan binds chain IDs, protocol/market identities, tokens, amounts, 1Click quote hash, deposit
  and destination receivers, refund receiver, solver payout, fees, nonce, and deadline.
- The borrower grants only the exact Aave collateral-token authorization required by the source
  module, using a bounded approval/permit path validated before execution.
- The borrower supplies the paired temporary Morpho authorization signatures required by the
  immutable target module; authorization is revoked atomically after the target open.
- An allowlisted relayer may submit already-authorized transactions but cannot change signed terms.
- No borrower private key is requested, stored, logged, or available to the worker.

## Failure recovery requirements

| Failure point                                          | Required safe behavior                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Before source close                                    | Release reservation; move no borrower assets; expire or requote.                                                               |
| Source closed, collateral still in source escrow       | Keep exact custody evidence; retry dispatch or execute the signed source recovery path.                                        |
| 1Click deposit processing or unknown                   | Stop forward execution; poll within bounded deadlines; independently verify custody; alert without inventing a terminal state. |
| 1Click refund                                          | Refund only to the migration-bound source recovery escrow; verify the actual receipt and amount before recovery advances.      |
| Destination delivery below minimum or wrong            | Do not open Morpho; retain/recover known custody and record the solver receivable.                                             |
| Destination capacity deteriorates                      | Do not borrow unsafely; keep delivered collateral in destination escrow and enter recovery.                                    |
| Morpho open or settlement reverts                      | Rely on transaction atomicity so no partial target loan or payout persists; revalidate before retry.                           |
| Financial settlement succeeds but registry write fails | Preserve `SETTLED_PENDING_REGISTRY`; retry the idempotent registry command without moving funds again.                         |

After source close, the system must never call an unresolved obligation `COMPLETED`. Recovery must
record asset custody, solver receivable, next permitted action, deadline, and escalation owner.

## Two-day execution order

Work in this order. Do not spend deadline time on multi-protocol expansion or optional agent work
while a safe actionable item remains in this list.

1. **Freeze the strategy and mode contract**
   - Remove `mainnet-canary` and `mainnet-controlled` from the design.
   - Add `sandbox`, `testnet`, `mainnet-readonly`, and `mainnet` with the execution switch contract.
2. **Make the workflow provider-neutral**
   - Extract simulator-neutral execution and transport ports.
   - Replace simulator-specific handler construction with one workflow factory.
   - Add strict composition roots and prohibit production-to-simulator imports.
3. **Complete production adapters**
   - Implement source/vault/escrow transaction construction and receipt verification.
   - Extend the 1Click client from read-only to committed quote, deposit binding, status, refund, and
     independently verified destination delivery.
   - Implement destination feasibility, Morpho open, atomic settlement, and residual verification.
   - Implement idempotent NEAR agreement/receipt registration.
4. **Complete funding, authorization, and recovery invariants**
   - Enforce zero shortfall, recovery reserve, exact approvals, signed quote/receiver binding,
     canonical receipts, retry budgets, and ledger balance.
5. **Run contract-backed sandbox verification**
   - Happy path plus refund, timeout, incomplete delivery, wrong receiver, pre/post-close market
     deterioration, reorg, duplicate command, and worker restart scenarios.
6. **Run production-protocol and provider verification**
   - Pinned Aave/Morpho fork tests, official 1Click schema/fixture tests, live dry quote, and
     non-broadcast transaction simulation.
7. **Deploy public validation environments**
   - Deploy and attest the pinned canonical-source, DebtShift-operated Morpho destination and real
     public-testnet market before deploying the DebtShift testnet contracts.
   - Deploy and exercise the testnet contracts/registry; only the unavailable 1Click boundary may
     use the explicitly labeled testnet transport adapter.
   - Deploy the hosted contract-backed sandbox and web/API surfaces.
8. **Run the complete acceptance gate**
   - Clean checkout, CI, security checks, deployment manifests, balances, roles, pause state,
     recovery runbook, and exact mainnet readiness record.
9. **Deploy production with writes disabled**
   - Deploy mainnet contracts and services with `MAINNET_EXECUTION_ENABLED=false`.
   - Verify code hashes, roles, balances, live route identities, and simulate every planned call.
10. **Attempt the real transaction last**
    - Present the exact principal, collateral, minimum output, target debt maximum, fees, gas budget,
      receivers, deadline, and worst-case recovery exposure to the project owner.
    - Obtain the borrower signatures and explicit owner authorization.
    - Set `MAINNET_EXECUTION_ENABLED=true`, restart, revalidate fresh state, and execute once.
    - Return the switch to `false` immediately after the attempt and preserve all evidence whether
      it completes or enters recovery.

## Deferred until P0 is complete

- Additional lending protocols, routes, assets, and chains.
- Further AI/agent provider features beyond the already implemented deterministic boundary.
- Public solver marketplace or permissionless vault participation.
- Advanced dashboards, extensive observability polish, SBOM/provenance automation, and broad
  operational drills not required to make the first route safe.
- UI design polish that does not unblock the end-to-end borrower journey or evidence display.

## Judge-facing evidence

The submission should provide URLs and evidence rather than assume local installation:

- hosted borrower UI and API;
- hosted contract-backed sandbox with real local-chain transaction hashes and scenario controls;
- public testnet contract and NEAR registry explorer links;
- mainnet-readonly live route and dry-quote evidence;
- pinned production-protocol fork results and CI results;
- deployment manifests, contract code hashes, and security limitations;
- if the final transaction is attempted, complete origin, 1Click, destination, settlement, and
  registry evidence, including any recovery outcome.

## Resume protocol

At every remaining work session:

1. Read this file and `08-progress-and-decisions.md`.
2. Resume the earliest safe incomplete item in the two-day execution order.
3. Treat the production workflow as primary and the simulator as a test adapter.
4. Do not deploy or broadcast mainnet writes before the acceptance gate and explicit authorization.
5. Record commands, results, remaining exposure, and blockers in the progress log.
6. Commit and push coherent checkpoints frequently enough that another contributor can recover from
   Git before the submission cutoff.
