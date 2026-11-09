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
- Collateral minimum and debt maximum enforcement.
- Residual refunds.
- Pause-role boundaries.
- Unexpected ERC-20 return values and balance deltas.

## Contract invariants

- No unsigned receiver receives migration assets.
- One migration cannot consume another migration’s escrow.
- A nonce is consumed at most once.
- Solver payout never exceeds funded principal plus signed fee.
- Vault assets equal free liquidity plus reservations plus recognized receivables.
- A completed migration has no unexplained adapter or escrow balance.
- Repeated calls cannot duplicate source repayment, collateral routing, target borrow, or settlement.

## Pinned protocol fork tests

### Aave source

- Read collateral, debt, reserve configuration, and health factor.
- Repay exact and maximum debt on behalf of the borrower.
- Validate interest accrued between snapshot and execution.
- Prove the selected collateral-release authorization mechanism.
- Verify complete close and partial residual constraints.
- Reject wrong pool, reserve, token, receiver, and stale plan.

### Morpho destination

- Reconstruct market identity from all five market parameters.
- Fetch accrued position and current liquidity.
- Satisfy approval and authorization requirements.
- Supply collateral and borrow atomically.
- Validate the application LTV buffer and current SDK behavior.
- Reject stale position data, insufficient liquidity, and unsafe post-state.

## NEAR tests

- Contract initialization and role assignment.
- Agreement registration.
- Authorized and unauthorized attestations.
- Duplicate evidence and duplicate finalization.
- Final receipt immutability.
- Read-view serialization.
- Sandbox deployment and transaction smoke test.

## Transport simulator tests

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
10. Simulated source or destination reorg.
11. NEAR finalization temporarily fails and later resumes.

## Live canary verification

The mainnet canary is a manual release check and is never run in ordinary CI.

- Rehearse the complete flow with the simulator first.
- Confirm the dedicated wallet balance is limited before requesting a committed quote.
- Confirm the route and input satisfy the configured base-unit cap.
- Display and manually approve deposit address, recipient, refund receiver, deadline, amount in, and minimum amount out.
- Store the origin transaction receipt before polling to completion.
- Independently verify the destination transaction, token, receiver, and amount.
- Record the 1Click correlation ID and terminal status.
- Verify that no lending adapter, vault, or debt-migration record was touched.
- Abort safely on an unknown status, expired quote, address mismatch, or cap violation.

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
- Canary-policy negative tests proving committed quotes are unavailable outside the isolated capability.

## Test evidence

Each milestone records:

- Exact command.
- Commit identifier.
- Fixture or pinned block.
- Pass/fail result.
- Relevant logs or report path.
- Known exclusions.

No flaky test is silently retried into acceptance. A retry must be recorded and the source of nondeterminism investigated.
