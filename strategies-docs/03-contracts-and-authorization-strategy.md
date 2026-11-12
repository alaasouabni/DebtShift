# Contracts and authorization strategy

## Authorization hierarchy

DebtShift uses two borrower signatures.

### Refinance intent

The intent expresses durable user policy:

- Borrower address and account type.
- Source chain, protocol, market, collateral, and debt asset.
- Allowed destination chains and markets.
- Maximum source debt to repay.
- Minimum source collateral to release.
- Maximum total fee and slippage bounds.
- Permitted shortfall-resolution modes, maximum capitalized costs, and maximum borrower contribution.
- Protocol-specific minimum safety policy.
- Intent expiry and intent nonce.

The intent does not authorize an arbitrary future transport recipient or solver.

### Execution plan

The short-lived execution plan binds exact execution details:

- Intent hash and immutable migration ID.
- Exact source and destination deployments.
- Exact token contract addresses and decimals.
- Source repayment cap and collateral minimum.
- Committed transport quote hash and deposit address.
- Destination receiver and refund receiver.
- Minimum destination amount.
- Funding provider and reservation hash.
- Payout chain, asset, receiver, principal cap, and fee cap.
- Reconciled solver principal, solver fee, capitalized costs with exact recipients, separately paid
  costs, and any verified borrower debt prepayment.
- Required destination borrow, maximum safe capacity, capacity-buffer policy, financing-analysis
  hash, snapshot provenance, and expiry.
- Supplementary funding asset, amount, migration escrow, finalized deposit evidence, authorized use,
  and refund receiver.
- Execution deadline and execution nonce.

Both structures use canonical EIP-712 encoding. Contract-wallet signatures must support EIP-1271.

## Mandatory financing gate

Before a solver or test-vault reservation is accepted, the risk validation service re-derives the
model in `11-refinancing-feasibility-model.md` from fresh direct reads and finalized escrow evidence.
The reservation is allowed only when:

- the component ledger reconciles without duplicate cost classification;
- maximum safe borrowing capacity plus confirmed external funding covers solver principal, solver
  fee, and every other financed cost;
- the required destination borrow passes current liquidity and stressed safety limits; and
- the execution plan binds the exact zero-shortfall financing structure.

An offchain promise, an unconfirmed transaction, or an unescrowed wallet balance cannot satisfy this
gate. The gate is rechecked immediately before source closure; a failed pre-source recheck expires or
requotes the plan without drawing temporary liquidity.

## Source adapter

### Responsibilities

- Validate chain/domain, intent hash, execution-plan signature, nonce, and deadline.
- Validate allowlisted lending deployment, debt asset, collateral asset, and receivers.
- Draw no more than the authorized test-vault principal.
- Re-read accrued source debt and verify any finalized borrower prepayment before calculating the
  exact draw.
- Repay no more than the source debt cap.
- Release no less than the authorized collateral minimum.
- Assign released collateral to the migration escrow or exact transport receiver.
- Return unused debt asset to the vault.
- Emit a single canonical source-close event.
- Revert atomically if any postcondition fails.

### Source ownership proof gate

The selected EOA path is proven against pinned Aave V3 Base state:

1. Borrower grants a bounded allowance over the relevant aToken.
2. Adapter receives test-vault debt asset.
3. Adapter repays Aave debt on behalf of the borrower.
4. Adapter pulls the exact authorized aToken amount after repayment.
5. Adapter withdraws the underlying collateral to migration escrow.
6. The whole transaction reverts if allowance, repayment, transfer, withdrawal, or post-state validation fails.

The production module pins the pool, collateral aToken, debt variable-debt token, collateral asset,
and debt asset as immutable deployment inputs. It reads current variable debt inside the atomic close,
requires it to remain within the signed cap, verifies zero debt after repayment, pulls exactly the
signed collateral minimum rather than the borrower's whole aToken balance, verifies the underlying
receiver delta, clears temporary approvals, and retains no token balance. A missing aToken allowance
or a debt-cap breach reverts the vault draw, repayment, nonce consumption, and collateral movement.

The borrower-controlled smart-account and borrower-submitted transaction paths remain documented
fallbacks for a future unsupported reserve, but are not selected for the pinned Base WETH/USDC route:

- A borrower-controlled smart account that owns the lending position and executes the batch.
- A borrower-submitted source transaction followed by verified coordination.

No solver-funded arbitrary-EOA path may proceed without an atomic or enforceable collateral claim.

## Destination adapter

### Responsibilities

- Accept only the expected migration, token, amount range, and receiver.
- Verify finalized destination funding before lending actions are requested.
- Supply measured collateral on behalf of the borrower.
- Borrow no more than the signed target debt cap.
- Borrow no more than the revalidated required destination amount and maximum safe capacity.
- Enforce Morpho market parameters and the application LTV buffer.
- Send destination proceeds to settlement escrow, where they may be combined only with the exact
  signed supplementary funding.
- Transfer no more than the reconciled solver principal plus signed fee to the exact payout receiver.
- Pay other capitalized costs only to their signed recipients and component caps.
- Return residual collateral and debt asset to the borrower.
- Emit one canonical target-open event and one settlement event.

### Morpho authorization

- The production module binds one Morpho singleton and one exact market identity at construction:
  loan token, collateral token, oracle, IRM, and LLTV must reconstruct an initialized market.
- The module is bound once to one `DestinationAdapter`; no executor or owner can call the lending
  entry point directly after deployment.
- For an EOA borrower, authorization data contains two native Morpho EIP-712 authorizations signed
  over the Morpho domain: enable the exact module at nonce `N`, then disable it at nonce `N + 1`.
  Both authorizations identify the same borrower and module and carry live deadlines.
- One destination transaction enables the module, supplies exact measured collateral, borrows the
  exact feasibility-bound amount, and consumes the signed disable authorization. Failure of the
  supply, borrow, receiver transfer, or revocation reverts collateral movement, debt creation, both
  nonce increments, and destination-plan consumption together.
- The module rejects a pre-existing collateral or debt position in the selected target market. This
  keeps post-state deltas unambiguous; augmenting an existing target position is not authorized by
  the current route type.
- Completion requires authorization to be false, the Morpho nonce to advance by exactly two, exact
  collateral and borrow-share deltas, the exact debt-receiver asset delta, cleared temporary token
  allowance, and no new module residual. Pre-existing unsolicited token dust is tolerated but cannot
  be consumed or increased by the migration.
- Native Morpho LTV/LLTV values and direct position observations remain execution evidence. The
  stricter DebtShift capacity and LTV buffer are enforced by current feasibility before the module is
  called.
- A smart-account borrower requires a future explicit batch/direct-authorization path; the EOA
  signature path is not silently reused for an unsupported account type.

## Migration escrow

- Store balances by migration, chain, and token.
- Distinguish transported collateral, destination loan proceeds, borrower supplementary funding, and
  solver repayment balances.
- Accept deposits only from configured adapters or expected transport delivery.
- Prevent cross-migration balance consumption.
- Restrict withdrawals to signed borrower, transport, payout, or refund receivers.
- Support deadline-bound recovery actions.
- Lock supplementary funding before solver commitment and release it only to the signed settlement
  or refund path.
- Emit balance-assignment and release events.
- Expose read methods needed for reconciliation.
- Prohibit administrator sweeping of active migration balances.

## Test liquidity vault

- Hold only allowlisted test debt assets.
- Reserve principal by migration and expiry.
- Accept a reservation only with a current zero-shortfall feasibility hash and finalized required
  supplementary-funding evidence.
- Permit one bounded draw by the authorized source adapter.
- Track principal and fee separately.
- Release unused reservation after verified cancellation or terminal outcome.
- Accept destination repayment and record shortfall explicitly.
- Never classify an unresolved expected payout as a recognized receivable for successful settlement.
- Disallow arbitrary external borrowers.

This vault demonstrates temporary financing mechanics; it is not presented as a production credit agreement.

## Contract-wide controls

- Checks-effects-interactions ordering.
- Reentrancy guards on asset-moving entry points.
- Safe ERC-20 handling with balance-delta verification.
- Exact chain and deployment allowlists.
- Per-migration consumed nonces.
- Narrow pause roles for creating or advancing migrations.
- Separate configuration, pauser, verifier, and treasury roles.
- No upgrade mechanism in the first test release unless a concrete requirement emerges.
- No fee-on-transfer or rebasing token support.
- Residual asset return on every successful terminal path.
- No contract claims to guarantee cross-chain repayment: each contract enforces local custody and
  signed bounds, while the orchestrator and risk service handle changing remote capacity.

## Mainnet production execution boundary

There is no isolated 1Click canary contract path. `mainnet` executes the complete signed refinance
through the same source adapter, vault, escrows, destination adapter, settlement, and registry used
by the production workflow.

- `MAINNET_EXECUTION_ENABLED=false` blocks every irreversible application command before broadcast.
- Enabling the application switch grants no contract authority by itself.
- The source adapter accepts only an allowlisted relayer and a valid borrower-signed plan, then draws
  only the migration-bound vault reservation.
- The source escrow may release collateral only to the deposit address bound to the committed 1Click
  quote and signed plan, or to the signed recovery receiver under an authorized recovery command.
- The destination escrow accepts only the exact token/amount/receiver proven by the finalized
  provider and chain receipts.
- The destination adapter opens only the configured Morpho market under current zero-shortfall
  feasibility and atomically pays the solver/vault, costs, and borrower residual.
- The first deployment policy fixes the route, base-unit exposure limits, receivers, relayer, and
  recovery reserve. These limits are configuration and authorization, not a separate business flow.
- The complete transaction is attempted only after sandbox, testnet, fork, non-broadcast mainnet
  simulation, deployment verification, and explicit owner approval pass.

The application switch, borrower signatures, contract roles, pause state, and funding/feasibility
checks are independent layers. No single layer can authorize a different market, token, amount,
receiver, quote, fee, or deadline.

## Canonical migration events and authoritative surfaces

| Event                         | Authoritative emitter / record                                      |
| ----------------------------- | ------------------------------------------------------------------- |
| `MigrationAuthorized`         | Source `SourceAdapter` EVM log after signature and plan validation. |
| `LiquidityReserved`           | Source liquidity-vault EVM log.                                     |
| `SupplementaryFundingSecured` | Destination migration-escrow EVM log.                               |
| `SourceClosed`                | Source `SourceAdapter` EVM log.                                     |
| `CollateralAssigned`          | Destination migration-escrow EVM log.                               |
| `RouteDispatched`             | Durable worker/provider evidence after provider acceptance.         |
| `DestinationOpened`           | Destination `DestinationAdapter` EVM log.                           |
| `LiquiditySettled`            | Source liquidity-vault EVM log.                                     |
| `MigrationRecoveryOpened`     | Atomic PostgreSQL recovery case, evidence, phase, and audit record. |
| `MigrationCompleted`          | PostgreSQL terminal receipt bundle and NEAR registry finalization.  |

The source adapter temporarily emits the legacy `ExecutionPlanConsumed` alias beside
`MigrationAuthorized` so existing consumers are not broken before a versioned removal. Contract-log
tests assert the exact emitter, signature topic, indexed migration/asset/actor/plan identity, and ABI
payload for all seven contract-owned events. Events that occur only after cross-chain provider or
workflow reconciliation are not falsely emitted by a source or destination EVM contract.

Every event includes the migration ID and enough indexed identity fields for unambiguous
reconciliation. Events supplement transaction state; they do not replace post-transaction reads,
confirmation-depth checks, receipt canonicality validation, or durable evidence.

## NEAR registry

### Stored records

- Agreement ID.
- Intent hash.
- Execution-plan hash.
- Borrower and provider identities as typed strings with network identifiers.
- Supported source and destination networks.
- Ordered attestations containing verifier, scheme, evidence reference, state, and timestamp.
- Immutable final receipt-bundle hash.
- Final terminal status.

### Trust model

- Only configured verifiers append attestations.
- The registry records which verification scheme produced each claim.
- The registry does not claim to validate EVM consensus or 1Click independently.
- Duplicate finalization with a different hash is rejected.
- Administrative changes are logged and tested.
