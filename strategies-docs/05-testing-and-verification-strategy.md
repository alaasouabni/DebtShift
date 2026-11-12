# Testing and verification strategy

## Testing principles

- Financial behavior is tested at invariant and integration levels, not only through UI tests.
- External services have recorded fixtures and deterministic simulators.
- Fork tests use pinned blocks and documented deployment addresses.
- Time, finality, failures, and retries are controllable in tests.
- Every irreversible command has success, revert, timeout, duplicate-delivery, and restart coverage.

## TypeScript unit tests

- Canonical ID and hash construction.
- Integer amount parsing and formatting.
- Token decimal mismatch rejection.
- APR, cost, break-even, and scenario calculations.
- Sources-and-uses classification and duplicate-cost rejection.
- Protocol, policy, liquidity, and signed-cap derivation of maximum safe borrowing capacity.
- Required destination borrow and exact funding-shortfall calculation.
- Aave and Morpho safety policies.
- Route eligibility and rejection reasons.
- Phase-entry predicates and illegal transitions.
- Transport-status normalization, including unknown values.
- Ledger balancing.
- Idempotency-key stability.

## Database tests

- Schema migration up and down behavior where rollback is supported.
- Unique constraints for nonces, commands, events, and receipts.
- Optimistic concurrency conflict handling.
- Outbox publication after process interruption.
- Row-lock behavior with competing workers.
- Audit-event sequence continuity.
- Evidence retraction without history loss.

## Foundry unit and fuzz tests

- EIP-712 recovery and EIP-1271 contract signatures.
- Chain, market, token, receiver, amount, deadline, and nonce binding.
- Replay prevention.
- Reentrancy protection.
- Allowlist enforcement.
- Principal and fee caps.
- Supplementary-funding asset, amount, escrow, use, refund, deadline, and finality binding.
- Collateral minimum and debt maximum enforcement.
- Residual refunds.
- Pause-role boundaries.
- Unexpected ERC-20 return values and balance deltas.

## Contract invariants

- No unsigned receiver receives migration assets.
- One migration cannot consume another migration’s escrow.
- A nonce is consumed at most once.
- Solver payout never exceeds funded principal plus signed fee.
- A solver reservation cannot exist without a current passing zero-shortfall feasibility record.
- Confirmed external funding cannot be consumed by another migration or released to an unsigned
  receiver.
- `SETTLED` is unreachable unless finalized proceeds and supplementary-funding debits equal the exact
  solver payout obligation.
- Vault assets equal free liquidity plus reservations plus recognized receivables.
- A completed migration has no unexplained adapter or escrow balance.
- Repeated calls cannot duplicate source repayment, collateral routing, target borrow, or settlement.
- A complete contract-path log test asserts exact emitters, signature topics, indexed identities, and
  ABI payloads for `MigrationAuthorized`, `LiquidityReserved`, `SupplementaryFundingSecured`,
  `SourceClosed`, `CollateralAssigned`, `DestinationOpened`, and `LiquiditySettled`.

## Pinned protocol fork tests

### Aave source

- Read collateral, debt, reserve configuration, and health factor.
- Repay exact and maximum debt on behalf of the borrower.
- Validate interest accrued between snapshot and execution.
- Prove the selected collateral-release authorization mechanism.
- Verify complete close and partial residual constraints.
- Reject wrong pool, reserve, token, receiver, and stale plan.

The pinned Base fixture at block `55,600,000` deploys the real DebtShift vault, independent source and
destination escrows, signed source and destination adapters, Aave source module, and immutable Morpho
target module over forked protocol contracts. It proves bounded in-flight interest, zero remaining
variable debt, exact 10 WETH source custody, exact transport into destination custody, and the exact
vault receivable before exercising Morpho.

### Morpho destination

- Reconstruct market identity from all five market parameters.
- Fetch accrued position and current liquidity.
- Satisfy approval and authorization requirements.
- Supply collateral and borrow atomically.
- Validate the application LTV buffer and current SDK behavior.
- Reject stale position data, insufficient liquidity, and unsafe post-state.
- Derive safe borrow capacity using both protocol constraints and stricter DebtShift stress policy.
- Reject a borrow that is safe by collateral ratio but cannot cover the complete repayment obligation.

Five deterministic module tests prove exact opening, one-time adapter binding, rejection of an
existing target position, complete rollback when the signed revocation is invalid, and resistance to
unsolicited token-dust griefing. The pinned fork then records destination feasibility, consumes native
Morpho enable/revoke signatures at consecutive nonces, supplies all 10 WETH through the signed
`DestinationAdapter`, borrows the bounded vault obligation, settles proceeds through destination
escrow, proves authorization is disabled and all module/adapter/escrow residuals are zero, and settles
the source vault receivable. The fixed block hash is
`0xc22ea6ebea74eb93bf081cee853c017b276a6264012407e56e01c0233467f542`.

## NEAR tests

- Contract initialization and role assignment.
- Agreement registration.
- Authorized and unauthorized attestations.
- Duplicate evidence and duplicate finalization.
- Final receipt immutability.
- Read-view serialization.
- Sandbox deployment and transaction smoke test.

## Transport simulator tests

- Every origin, destination, and refund movement references an actual sandbox/testnet transaction;
  a status-only success fixture is prohibited.
- Pending deposit then success.
- Processing delay.
- Incomplete deposit.
- Refund.
- Failure with known custody.
- Failure with ambiguous custody.
- Unknown provider status.
- Duplicate origin submission.
- Duplicate callbacks and polling observations.
- Destination amount below minimum.
- Wrong token or receiver.

## End-to-end scenarios

1. Happy-path refinance.
2. Quote expires before execution.
3. Source transaction reverts.
4. Worker stops after source broadcast and before receipt storage.
5. Transport refunds after source closure.
6. Destination receives insufficient collateral.
7. Destination market becomes unsafe before target opening.
8. Target opens and settlement is retried after failure.
9. Duplicate execute requests and duplicate queue deliveries.
10. Simulated source receipt disappearance and destination same-height block replacement; both
    append retractions, block the next side effect, and open manual reconciliation without an
    automatic recovery transaction.
11. NEAR finalization temporarily fails and later resumes.

## Refinancing feasibility test matrix

The following cases are mandatory at unit, integration, and E2E levels where applicable:

1. **Sufficient destination capacity:** the complete solver principal, fee, and financed costs fit
   inside safe capacity; shortfall is zero and reservation may proceed.
2. **Insufficient destination capacity:** `10,000 USDC` capacity cannot fund a `10,000 USDC`
   principal plus `100 USDC` fee; the route is rejected before reservation.
3. **Borrower-funded shortfall:** finalized `100 USDC` supplementary escrow plus a `10,000 USDC`
   safe borrow pays the `10,100 USDC` obligation exactly.
4. **Fee capitalization:** the fee enters destination debt only when safe capacity, liquidity, signed
   debt cap, and post-state stress checks all cover it.
5. **Borrower-funded partial debt repayment:** a finalized source prepayment reduces the refreshed
   source payoff and solver principal without being counted again as settlement funding.
6. **Collateral price decline during migration:** the pre-source checkpoint rejects without movement;
   the post-source checkpoint enters recovery and never creates an unsafe loan.
7. **Destination liquidity reduction:** a lower fresh `B_liquidity` produces the exact shortfall and
   follows the pre- or post-source policy appropriate to the current phase.
8. **Destination rate deterioration:** a refreshed target APR that no longer meets the signed
   minimum APR reduction forces a pre-source requote or post-source recovery, with policy capacity
   reduced to zero and no unsafe target loan.
9. **Protocol risk-parameter deterioration:** a lower refreshed protocol LTV/LLTV limit reduces the
   exact capacity even when the signed policy is unchanged; post-source failure retains custody and
   exposure evidence without opening the target position.
10. **Solver fee exceeds approved limits:** quote and execution-plan validation reject it even when
    market capacity is sufficient.
11. **Missing or unconfirmed supplementary funding:** pending transactions, wrong assets, wrong chains,
    wrong escrows, expired deposits, and wallet-balance claims do not count as confirmed funding.
12. **Failure to repay after collateral delivery:** proceeds remain isolated, exact payout retry is
    idempotent, `SETTLED` is blocked, and the solver receivable and custody are visible.
13. **Incomplete cross-chain migration recovery:** refund, ambiguous custody, target-open failure, and
    capacity deterioration preserve balanced evidence and terminate only under a signed recovery
    outcome.
14. **Cost-classification mutation:** moving one cost between solver principal, capitalized cost, and
    separately paid cost changes totals once; duplicating it is rejected.
15. **Revalidation supersession:** a newer failed feasibility check blocks execution despite an older
    passing quote.

Property tests vary debt accrual, token decimals, fees, external funding, collateral price,
liquidity, LTV/LLTV, and health-factor policy around boundary values. Equality at the safe capacity
boundary is accepted only when every configured buffer has already been applied and integer rounding
is conservative.

## Final mainnet execution verification

The mainnet attempt is the final release action and is never run in ordinary CI. Before enabling
writes:

- Run the complete workflow against contract-backed private chains and public testnet deployments.
- Run pinned Aave and Morpho production forks through the real adapters.
- Validate official 1Click schemas/fixtures, a live dry quote, and strict unknown-status behavior.
- Deploy with `MAINNET_EXECUTION_ENABLED=false` and prove every irreversible command is rejected.
- Verify deployed code hashes, roles, pause state, route identities, token metadata, oracle
  freshness, vault liquidity, recovery reserve, relayer gas, and registry configuration.
- Construct and simulate every intended EVM transaction against current state without broadcasting.
- Display principal, collateral, minimum delivery, maximum destination debt, solver fee, gas budget,
  deposit address, recipient, refund escrow, deadline, and worst-case recovery exposure.
- Obtain bounded borrower signatures and explicit owner approval.

For the one approved attempt:

- Enable mainnet execution server-side, restart, and repeat all freshness/funding checks.
- Store each broadcast identifier before polling or scheduling its successor.
- Independently verify source, provider, destination, settlement, and registry receipts.
- On any mismatch or unknown status, stop forward execution and enter the custody-specific recovery
  path rather than bypassing a check.
- Disable mainnet execution immediately after completion or recovery entry.
- Preserve a complete receipt/evidence bundle regardless of outcome.

## Security and quality gates

The release pipeline must run:

- Formatting checks.
- TypeScript lint and type checking.
- TypeScript unit and integration tests.
- Foundry build, unit, fuzz, and invariant tests.
- Rust format, lint, unit, and sandbox tests.
- API schema and generated-client consistency checks.
- Deterministic E2E happy and recovery cases.
- Dependency and container vulnerability scanning.
- Secret scanning.
- Build artifact and deployment-manifest checks.
- Mode/permission negative tests proving mainnet writes are unavailable outside `mainnet` and while
  `MAINNET_EXECUTION_ENABLED=false`.

## Test evidence

Each milestone records:

- Exact command.
- Commit identifier.
- Fixture or pinned block.
- Pass/fail result.
- Relevant logs or report path.
- Known exclusions.

No flaky test is silently retried into acceptance. A retry must be recorded and the source of nondeterminism investigated.
