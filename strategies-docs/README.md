# DebtShift implementation strategy

## Purpose

This directory is the operational playbook for implementing DebtShift. It turns the technical specification into ordered, verifiable work. It is the source of truth for scope, sequencing, unresolved decisions, milestone status, and completion criteria. With two days remaining as of 2026-11-12, `14-submission-critical-plan.md` controls work priority without erasing the full production backlog.

Implementation must be understandable from this directory without relying on chat history.

## Approved direction

- Implement one normal, complete production workflow for an Aave V3 source, official 1Click
  transport, Morpho Blue destination, solver settlement, and receipt registration.
- Use provider ports and composition roots so sandbox and testnet adapters exercise the same workflow
  as mainnet; never make simulation the primary business-logic implementation.
- Keep a contract-backed sandbox using two private local EVM networks, real deployed contracts and
  transactions, and a transport simulator only at the unavailable external-provider boundary.
- Preserve public testnet, mainnet-readonly, and mainnet modes with strict validated configuration.
- Treat the public 1Click service as mainnet-only; there is no 1Click testnet environment to fund.
- Validate protocol integrations separately with pinned Aave and Morpho fork tests.
- Use a pre-funded permissioned liquidity vault and recovery reserve before implementing an open
  solver marketplace.
- Deploy the receipt registry to NEAR testnet for public validation and use the configured production
  registry for mainnet execution.
- Permit production 1Click token discovery and `dry: true` quotes in read-only mode.
- Remove the isolated canary architecture. The `mainnet` mode is the complete refinance workflow;
  initial route and exposure limits are deployment policy rather than a separate code path.
- Default `MAINNET_EXECUTION_ENABLED` to `false`; attempt the small real refinance only after all
  development, sandbox, testnet, fork, security, deployment, and explicit approval gates pass.
- Default to the deterministic TypeScript Route/Risk Agent with no AI configuration required.
- Allow the user to optionally select either a user-supplied AI API or a local Ollama model for explanations; neither can authorize or execute financial actions.
- Use free public protocol APIs and RPC endpoints with direct onchain verification for execution-critical state.
- Require a reconciled, zero-shortfall refinancing feasibility proof before any solver or test-vault
  commitment. Unsecured promises and speculative future capacity are not funding sources.

## Document index

| Document                                                                                   | Purpose                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [00-product-scope.md](./00-product-scope.md)                                               | Defines the first release, boundaries, assumptions, and user-visible acceptance criteria.        |
| [01-architecture-blueprint.md](./01-architecture-blueprint.md)                             | Defines runtime components, trust boundaries, data flow, and state ownership.                    |
| [02-implementation-roadmap.md](./02-implementation-roadmap.md)                             | Contains the ordered milestones and task-level implementation checklist.                         |
| [03-contracts-and-authorization-strategy.md](./03-contracts-and-authorization-strategy.md) | Defines EVM and NEAR contract responsibilities and the authorization model.                      |
| [04-orchestration-and-data-strategy.md](./04-orchestration-and-data-strategy.md)           | Defines persistence, evidence, idempotency, state transitions, and recovery.                     |
| [05-testing-and-verification-strategy.md](./05-testing-and-verification-strategy.md)       | Defines all test layers and release quality gates.                                               |
| [06-environments-deployment-operations.md](./06-environments-deployment-operations.md)     | Defines sandbox, testnet, mainnet-readonly, and mainnet environments and the write switch.       |
| [07-security-risk-register.md](./07-security-risk-register.md)                             | Tracks threats, invariants, mitigations, and blocking security risks.                            |
| [08-progress-and-decisions.md](./08-progress-and-decisions.md)                             | Tracks milestone status, decisions, open questions, and implementation handoffs.                 |
| [09-definition-of-done.md](./09-definition-of-done.md)                                     | Defines what must be true before the implementation is called complete.                          |
| [10-agent-and-free-data-sources.md](./10-agent-and-free-data-sources.md)                   | Defines the agent design, local model, free data providers, precedence, caching, and fallbacks.  |
| [11-refinancing-feasibility-model.md](./11-refinancing-feasibility-model.md)               | Defines borrowing capacity, funding shortfalls, secured resolutions, and revalidation rules.     |
| [12-production-provider-boundaries.md](./12-production-provider-boundaries.md)             | Separates simulator fixtures from live Aave, Morpho, Chainlink, and 1Click providers.            |
| [13-frontend-handoff.md](./13-frontend-handoff.md)                                         | Defines frontend ownership, API and signing contracts, user journeys, safety labels, and tests.  |
| [14-submission-critical-plan.md](./14-submission-critical-plan.md)                         | Defines the two-day P0 delivery order, ownership, deferrals, safety rules, and submission gates. |
| [15-account-handoff.md](./15-account-handoff.md)                                           | Gives the next Codex account the exact verified checkpoint, blockers, and resume commands.       |

## Work protocol

1. Read this file, `08-progress-and-decisions.md`, and any active deadline override before starting a work session.
2. During the current submission window, select the earliest incomplete P0 item in `14-submission-critical-plan.md`; otherwise select the earliest incomplete milestone whose dependencies are complete.
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
- Mainnet writes remain fail-closed until the production gates are satisfied, the exact execution
  is approved, and `MAINNET_EXECUTION_ENABLED=true` is applied server-side.

## Current project status

| Area                        | Status      |
| --------------------------- | ----------- |
| Technical document analysis | COMPLETE    |
| Strategy documentation      | COMPLETE    |
| Repository initialization   | COMPLETE    |
| Application implementation  | IN_PROGRESS |
| Contract implementation     | IN_PROGRESS |
| Contract-backed sandbox     | IN_PROGRESS |
| NEAR testnet deployment     | NOT_STARTED |
| Mainnet implementation      | IN_PROGRESS |
| Mainnet writes              | DISABLED    |
