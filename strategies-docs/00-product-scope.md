# Product scope

## Objective

Build a functional DebtShift system in which a borrower can inspect an existing collateralized loan, compare refinancing routes, sign bounded authorizations, execute a multi-stage refinance through production protocol adapters, and inspect independently verified receipts and recovery outcomes.

The first release implements one narrowly configured production route and proves it through a
contract-backed sandbox, public testnet deployment, mainnet-readonly preflight, and pinned protocol
forks before any small real transaction is attempted. It is not represented as audited or suitable
for unattended public use.

## Production-first proof strategy

The first release contains one workflow with environment-specific adapters:

1. **Contract-backed sandbox:** private local chains execute real contracts, signatures,
   transactions, receipts, balances, settlement, and recovery. Only the external transport provider
   boundary is simulated.
2. **Public testnet:** public test networks validate deployment, relaying, confirmation, registry,
   restart, and explorer evidence. Transport remains explicitly simulated because 1Click has no
   public testnet.
3. **Mainnet read-only:** official production state and `dry: true` quotes validate the configured
   route without writes.
4. **Mainnet:** the same workflow uses real Aave, official 1Click, Morpho, settlement, and registry
   adapters. Writes are enabled only at the end through the server-side execution gate.

There is no isolated transport canary and no separate simulation workflow. A successful mainnet
attempt must be a complete refinance; otherwise it is described only as the stage actually reached.

## Primary user journey

1. Connect an EVM wallet.
2. Discover a source lending position containing one supported collateral and one supported debt asset.
3. Display current debt, collateral, APR, safety metric, and snapshot block.
4. Compare at least two target route outcomes using deterministic cost and risk calculations.
5. Calculate the complete sources-and-uses ledger, maximum safe destination borrowing capacity, and
   any funding shortfall.
6. Resolve a shortfall through secured borrower funding, safe debt capitalization, or verified
   borrower debt prepayment; otherwise reject the route.
7. Select a route and review exact amounts, financing classifications, recipients, fees, deadlines,
   and risk limits.
8. Sign a bounded refinance intent and final execution plan.
9. Revalidate zero-shortfall feasibility, then reserve temporary repayment liquidity from the
   configured permissioned vault.
10. Close the source debt and move released collateral into the authorized transport path.
11. Route the collateral through the selected transport adapter: the contract-backed simulator in
    sandbox/testnet or official 1Click in mainnet.
12. Revalidate destination capacity, supply the delivered collateral, and open the replacement debt
    position only when the complete repayment remains funded.
13. Combine authorized loan proceeds and secured supplementary funds to repay the temporary funding
    obligation and reconcile residual balances.
14. Record the evidence bundle in the application and its hash in the NEAR registry.
15. Display a complete, ordered timeline with transaction and receipt details.

## Required failure journey

The demo must also execute a route in which the transport fails or refunds after the source position has been closed. The system must:

1. Detect the terminal provider outcome.
2. Verify the actual custody and balance of the returned collateral.
3. Enter `RECOVERY` without declaring the migration successful.
4. Execute the configured test recovery policy.
5. End in either `COMPLETED` after a successful alternative settlement or `FAILED_SAFE` with residual claims and custody recorded.

## Initial supported route

The initial route is intentionally narrow:

- Source: one configured chain, official Aave V3 deployment, borrower, and collateral/debt reserve.
- Destination: one configured chain and exact Morpho Blue market identity.
- Debt asset: one exact settlement/debt token pair validated by chain ID and contract address.
- Collateral asset: one exact collateral route validated against the live 1Click catalog.
- Financing: one permissioned, pre-funded liquidity vault and a separately isolated recovery reserve.
- Transport: deterministic receipt-producing simulator in sandbox/testnet; official 1Click in mainnet.
- Limits: fixed maximum principal, collateral, fee, slippage, gas, duration, receivers, and recovery
  exposure for the initial deployment.

The real-token and live-network catalog must be discovered at runtime. Symbols alone never identify an asset.

## In scope

- Next.js borrower dashboard.
- NestJS REST API and server-sent migration updates.
- EVM wallet authentication and EIP-712 signing.
- Position and market snapshots with block provenance.
- Deterministic quote economics and route ranking.
- PostgreSQL durable state and append-only audit events.
- Transactional outbox and at-least-once job processing.
- Redis-backed background job delivery.
- Source and destination EVM adapters.
- Per-migration escrow, permissioned liquidity vault, and recovery reserve.
- Contract-backed 1Click-compatible transport simulator for sandbox and testnet.
- Production 1Click token discovery and `dry: true` quotes behind an explicit mainnet-read-only configuration mode.
- Production 1Click committed quote, deposit binding, status, refund, and receipt verification in the
  complete mainnet workflow.
- NEAR receipt and attestation registry.
- Foundry unit, fuzz, invariant, and pinned fork tests.
- Local happy-path, refund, timeout, replay, and worker-restart tests.
- Docker-based local environment and reproducible demo scripts.
- Metrics, structured logs, health checks, and evidence inspection.
- Deterministic Route/Risk Agent tools for position analysis, route comparison, risk checks, and intent preparation.
- Optional natural-language explanations through either a user-supplied AI API or local Ollama, with a deterministic template fallback.

## Out of scope for the first release

- General-purpose, multi-route, or unattended public mainnet execution.
- Mainnet execution before the complete readiness gate and explicit owner approval.
- Any claim that the simulated transport is a 1Click testnet deployment; no public 1Click testnet exists.
- Public solver marketplace or permissionless liquidity.
- Legal enforcement of solver credit agreements.
- Unsecured borrower promises or speculative future destination capacity as a funding source.
- Multi-collateral or multi-debt source positions.
- Fee-on-transfer, rebasing, yield-bearing wrapper, or non-standard ERC-20 assets.
- Arbitrary chain and protocol combinations.
- Automatic liquidation protection during an unbounded transport delay.
- Governance token, DAO, fee distribution, or protocol revenue.
- Unattended execution using stored borrower keys.
- Claims of trustless verification of EVM events by the NEAR registry.
- Any authority for an LLM to sign, broadcast, reserve liquidity, select a receiver, or override deterministic risk policy.
- Persistent storage or logging of a user-supplied AI API key.

## Functional acceptance criteria

- A new developer can start the complete local stack from documented commands.
- Seed scripts create a borrower source position and fund the test liquidity vault.
- The UI returns at least two deterministic route comparisons.
- Every eligible route displays the source payoff, solver principal and fee, financed versus
  separately paid costs, confirmed external funding, maximum safe borrowing capacity, required
  destination borrow, and funding shortfall.
- A solver or test-vault reservation is impossible unless the funding shortfall is zero and any
  supplementary funding is finalized in migration-specific escrow.
- Changing a signed chain, market, token, amount, receiver, fee, nonce, or deadline invalidates authorization.
- Repeated execute requests do not duplicate any asset movement.
- A worker crash at every irreversible boundary can resume from persisted evidence.
- A successful transport status alone cannot advance the migration to target-open or completed.
- The source and destination position reads prove the before and after states.
- The ledger balances by migration, chain, token, and financing party.
- The NEAR registry contains the same final evidence hash displayed by the application.
- The failure scenario visibly reaches `RECOVERY` and never reports success incorrectly.
- A post-source-close decline in destination capacity never causes an unsafe target borrow or a
  false settlement; custody and the solver receivable remain explicit in recovery evidence.
- The UI and documentation clearly label sandbox/testnet transport receipts as simulated rather than testnet 1Click transactions.
- The hosted sandbox proves actual local-chain contract transactions rather than fabricated API state.
- Mainnet displays real 1Click correlation/status data and independently verified origin and destination receipts as one stage of the complete refinance.

## Non-functional acceptance criteria

- Deterministic tests use pinned timestamps, block heights, token metadata, and rate fixtures.
- No secret is committed to source control or printed in logs.
- Contract permissions are bounded by migration, token, amount, receiver, nonce, and deadline.
- Database writes that schedule work use a transactional outbox.
- Application logs contain correlation ID, migration ID, phase, command ID, and chain when applicable.
- All externally supplied addresses and integer strings are schema-validated.
- Feasibility is revalidated from fresh direct reads before reservation, source closure, target
  borrowing, and settlement.
- Unknown transport states and unexpected contract events create an operator-visible exception.
- Mainnet execution requires `MAINNET_EXECUTION_ENABLED=true`, bounded borrower signatures, and
  explicit owner approval after exact terms and recovery exposure are displayed.
- Mainnet policy is enforced using token base units, not provider-supplied USD display fields.

## Product terminology

- **Intent:** the borrower’s policy limits and allowed target scope.
- **Execution plan:** the exact, short-lived route bound to provider and recipient details.
- **Quote:** an economic projection and exact execution terms valid until a deadline.
- **Financing analysis:** the reconciled sources-and-uses calculation proving safe capacity,
  confirmed funding, and zero shortfall at a recorded block.
- **Confirmed external funding:** finalized settlement-asset funds isolated for the migration and
  authorized for the exact payout or refund path.
- **Migration:** one immutable attempt to execute a signed plan.
- **Evidence:** a verified observation supporting a state transition.
- **Command:** a requested external side effect with a stable idempotency key.
- **Receipt bundle:** the canonical set of evidence hashes used to finalize a migration.
- **Completed:** financial settlement and final receipt registration have both succeeded.
