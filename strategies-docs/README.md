# DebtShift implementation strategy

## Purpose

This directory is the operational playbook for implementing DebtShift. It turns the technical specification into ordered, verifiable work. It is the source of truth for scope, sequencing, unresolved decisions, milestone status, and completion criteria.

Implementation must be understandable from this directory without relying on chat history.

## Approved direction

- Build a complete test-funds implementation first.
- Do not enable real-fund mainnet execution in the first release.
- Demonstrate a cross-chain refinance from an Aave V3-style source position to a Morpho Blue-style destination position.
- Use two deterministic local EVM networks and a 1Click-compatible transport simulator for the reproducible demo.
- Treat the public 1Click service as mainnet-only; there is no 1Click testnet environment to fund.
- Validate protocol integrations separately with pinned Aave and Morpho fork tests.
- Use a pre-funded test liquidity vault before implementing an open solver marketplace.
- Deploy the receipt registry to NEAR testnet after local and sandbox verification.
- Permit production 1Click token discovery and `dry: true` quotes in read-only mode.
- Require one separately isolated, user-confirmed mainnet 1Click canary with a fixed token-unit cap and wallets controlled by the project team.
- Keep real mainnet lending, solver financing, and end-to-end debt refinancing disabled in the first release.
- Default to the deterministic TypeScript Route/Risk Agent with no AI configuration required.
- Allow the user to optionally select either a user-supplied AI API or a local Ollama model for explanations; neither can authorize or execute financial actions.
- Use free public protocol APIs and RPC endpoints with direct onchain verification for execution-critical state.
- Require a reconciled, zero-shortfall refinancing feasibility proof before any solver or test-vault
  commitment. Unsecured promises and speculative future capacity are not funding sources.

## Document index

| Document                                                                                   | Purpose                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [00-product-scope.md](./00-product-scope.md)                                               | Defines the first release, boundaries, assumptions, and user-visible acceptance criteria.       |
| [01-architecture-blueprint.md](./01-architecture-blueprint.md)                             | Defines runtime components, trust boundaries, data flow, and state ownership.                   |
| [02-implementation-roadmap.md](./02-implementation-roadmap.md)                             | Contains the ordered milestones and task-level implementation checklist.                        |
| [03-contracts-and-authorization-strategy.md](./03-contracts-and-authorization-strategy.md) | Defines EVM and NEAR contract responsibilities and the authorization model.                     |
| [04-orchestration-and-data-strategy.md](./04-orchestration-and-data-strategy.md)           | Defines persistence, evidence, idempotency, state transitions, and recovery.                    |
| [05-testing-and-verification-strategy.md](./05-testing-and-verification-strategy.md)       | Defines all test layers and release quality gates.                                              |
| [06-environments-deployment-operations.md](./06-environments-deployment-operations.md)     | Defines local, testnet, read-only, and future controlled environments.                          |
| [07-security-risk-register.md](./07-security-risk-register.md)                             | Tracks threats, invariants, mitigations, and blocking security risks.                           |
| [08-progress-and-decisions.md](./08-progress-and-decisions.md)                             | Tracks milestone status, decisions, open questions, and implementation handoffs.                |
| [09-definition-of-done.md](./09-definition-of-done.md)                                     | Defines what must be true before the implementation is called complete.                         |
| [10-agent-and-free-data-sources.md](./10-agent-and-free-data-sources.md)                   | Defines the agent design, local model, free data providers, precedence, caching, and fallbacks. |
| [11-refinancing-feasibility-model.md](./11-refinancing-feasibility-model.md)               | Defines borrowing capacity, funding shortfalls, secured resolutions, and revalidation rules.    |
| [12-production-provider-boundaries.md](./12-production-provider-boundaries.md)             | Separates simulator fixtures from live Aave, Morpho, Chainlink, and 1Click providers.           |
| [13-frontend-handoff.md](./13-frontend-handoff.md)                                         | Defines frontend ownership, API and signing contracts, user journeys, safety labels, and tests. |

## Work protocol

1. Read this file and `08-progress-and-decisions.md` before starting a work session.
2. Select the earliest incomplete milestone whose dependencies are complete.
3. Mark only one implementation task as `IN_PROGRESS` in the progress tracker.
4. Record material architectural choices in the decision log before depending on them broadly.
5. Implement the smallest coherent vertical increment.
6. Run the verification commands required by the milestone.
7. Record commands, results, risks, and relevant file paths in the progress log.
8. Mark work complete only when its exit criteria are satisfied.
9. Update these documents when implementation reality changes the plan.

## Status vocabulary

- `NOT_STARTED`: no implementation has begun.
- `IN_PROGRESS`: active work is underway.
- `BLOCKED`: a documented dependency prevents meaningful progress.
- `VERIFYING`: implementation exists but required checks are incomplete.
- `COMPLETE`: all stated exit criteria and tests pass.
- `DEFERRED`: intentionally excluded from the current release.

## Global engineering rules

- Token amounts are integers in base units. Floating-point values are prohibited for asset accounting.
- USD values are analytics and display values only; they never authorize an onchain transfer.
- Every external action has a stable idempotency key.
- Queue delivery is never accepted as proof that an external action occurred.
- Every phase transition is justified by persisted evidence.
- Provider success is independently reconciled against destination balances and transaction receipts.
- Unknown protocol, token, chain, or transport states fail closed.
- Every financing component is classified exactly once; separately paid costs and financed costs
  are never double counted.
- Solver or test-vault capital cannot be reserved until maximum safe destination borrowing plus
  confirmed external funding covers every repayment and financed-cost obligation.
- Per-chain contracts provide bounded custody and actions, not a guarantee of cross-chain atomicity
  or solver repayment.
- No borrower EOA private key is stored or requested.
- Real-fund execution remains disabled until the future production gates are explicitly approved.

## Current project status

| Area                        | Status      |
| --------------------------- | ----------- |
| Technical document analysis | COMPLETE    |
| Strategy documentation      | COMPLETE    |
| Repository initialization   | COMPLETE    |
| Application implementation  | IN_PROGRESS |
| Contract implementation     | IN_PROGRESS |
| Local end-to-end demo       | IN_PROGRESS |
| NEAR testnet deployment     | NOT_STARTED |
| Mainnet execution           | DEFERRED    |
