# Current status and architectural decisions

This file is the concise implementation checkpoint. Historical work-session logs, abandoned
deployment placeholders, and deadline-specific handoff notes are intentionally excluded; canonical
code, tests, manifests, receipts, and evidence are the source of truth.

## Current status

| Area                           | Status                          | Canonical evidence                                                                |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------- |
| Product workflow               | Complete                        | One provider-neutral Aave-to-1Click-to-Morpho workflow is used in every mode.     |
| Deterministic Route/Risk Agent | Complete                        | `packages/optimizer`, `packages/agent`, and API comparison tests.                 |
| Automatic route discovery      | Complete                        | `25-automatic-route-discovery-mainnet-fork-proof.md`.                             |
| EVM contracts                  | Complete for the reviewed route | Foundry unit, fuzz, invariant, deployment, happy-path, and recovery checks.       |
| Durable orchestration          | Complete for the reviewed route | PostgreSQL workflow, outbox, recovery, evidence, and ledger tests.                |
| Borrower web/API flow          | Complete                        | Generated OpenAPI contract, authenticated API tests, and production web build.    |
| Contract-backed sandbox        | Complete                        | Happy-path and recovery demos execute real local-chain transactions.              |
| Public testnet proof           | Complete                        | `24-public-testnet-workflow-execution.md` and successful immutable manifests.     |
| NEAR receipt registry          | Complete on testnet             | `near-testnet-registry-20261114-v1.json`.                                         |
| Mainnet-readonly discovery     | Complete                        | Live Aave, Morpho, Chainlink, and 1Click validation plus deterministic selection. |
| No-funds mainnet-fork proof    | Complete                        | `deployment/evidence/mainnet-fork-route-discovery-proof-20261114.json`.           |
| Mainnet broadcasting           | Disabled                        | `MAINNET_EXECUTION_ENABLED=false` remains the default and required safe state.    |
| CI/security                    | Complete                        | TypeScript, EVM, NEAR, secret, container, and SBOM jobs pass on `main`.           |

## Canonical evidence

- Public-testnet old-position/new-position proof and explorer receipts:
  [`24-public-testnet-workflow-execution.md`](./24-public-testnet-workflow-execution.md).
- Automatic discovery design, selected route, and fork limitations:
  [`25-automatic-route-discovery-mainnet-fork-proof.md`](./25-automatic-route-discovery-mainnet-fork-proof.md).
- Machine-readable dual-fork result:
  [`../deployment/evidence/mainnet-fork-route-discovery-proof-20261114.json`](../deployment/evidence/mainnet-fork-route-discovery-proof-20261114.json).
- Successful public deployment manifests: [`../deployment/manifests`](../deployment/manifests).
- Reproducible commands: root [`README.md`](../README.md).

## Approved decisions

### ADR-001: Modular monorepo

Web, API, worker, shared packages, EVM contracts, NEAR contracts, infrastructure, and tests live in
one repository. Shared schemas and canonical fixtures prevent cross-service encoding drift.

### ADR-002: PostgreSQL is workflow authority

PostgreSQL evidence and state transitions are authoritative. Queue delivery is at-least-once work
delivery and never proof of a financial side effect.

### ADR-003: One workflow, four modes

`sandbox`, `testnet`, `mainnet-readonly`, and `mainnet` compose different provider adapters around
one business workflow. Production code cannot fall back to simulator fixtures.

### ADR-004: Explicit external-provider simulation

Sandbox and public testnet use real contracts, custody, transactions, receipts, and persistence.
Only the unavailable external 1Click testnet settlement boundary is simulated and labeled as such.

### ADR-005: Two bounded borrower authorizations

A policy-level refinance intent permits analysis. A short-lived exact execution plan binds route,
amounts, receivers, fees, financing, slippage, deadline, quote, and recovery limits.

### ADR-006: Atomic Aave source closure

The source adapter and immutable Aave module repay bounded variable debt, prove the debt is closed,
claim only signed aToken collateral, withdraw it to escrow, and roll back the vault draw on any
mismatch.

### ADR-007: Atomic Morpho destination opening

The destination module consumes temporary native Morpho authorization, supplies exact collateral,
borrows the attested amount, revokes authorization, pays settlement recipients, and rejects
pre-existing target positions or unexplained deltas.

### ADR-008: Zero-shortfall financing proof

No temporary liquidity is reserved until protocol capacity, policy capacity, liquidity, signed
limits, and confirmed external funding cover every repayment and financed cost with zero shortfall.

### ADR-009: Deterministic financial agent

Eligibility, scoring, selection, and authorization are deterministic TypeScript. Optional local or
user-supplied AI can explain structured results but cannot add routes, change scores, sign, or
execute.

### ADR-010: Free discovery, onchain execution truth

Free public RPCs and official protocol APIs may discover candidates. Execution-critical identity,
price, liquidity, rate, position, receipt, and balance state is re-read from contracts and fails
closed when stale or inconsistent.

### ADR-011: Bounded automatic discovery

The platform enumerates active Aave reserves, resolves exact 1Click asset IDs, discovers listed
Morpho markets for reviewed asset pairs, revalidates their parameters onchain, and ranks only
eligible candidates. Unknown chains, tokens, oracles, IRMs, and position shapes are rejected.

### ADR-012: Immutable deployment evidence

External deployments produce non-overwritable manifests binding source, route, configuration,
contracts, roles, receipts, code hashes, balances, and the disabled mainnet-write switch. Only
successful canonical manifests are retained in the judge-facing repository.

### ADR-013: Reorg and recovery safety

Every next financial side effect revalidates canonical chain evidence. Deep reorgs or ambiguous
provider state halt automation and preserve append-only evidence for explicit reconciliation.

### ADR-014: Mainnet writes are a separate capability

Mainnet broadcasting requires the restart-bound server setting `MAINNET_EXECUTION_ENABLED=true` in
addition to signatures, allowlists, roles, funding, freshness, limits, pause state, and explicit
operator approval. The committed default remains `false`.

## Known limitations

- The reviewed production universe currently supports one Aave source deployment and one exact
  WETH/USDC source/destination asset shape; it is bounded discovery, not arbitrary-chain execution.
- The local fork proof reads the live 1Click catalog but simulates cross-chain delivery because an
  external provider cannot observe disposable local forks.
- Mainnet execution would require real gas, collateral, debt assets, solver funding, deployed
  reviewed adapters for the selected market, an external audit, and explicit operator approval.
- Public RPCs have no SLA. Freshness, timeout, response-size, canonical-block, and failover controls
  remain mandatory.

## Verification commands

```bash
npm ci
npm run check
npm run check:contracts
npm run check:live-route
npm run proof:mainnet-fork
```

`check:live-route` and `proof:mainnet-fork` require network access. The fork proof requires Foundry
but no private key or real funds.
