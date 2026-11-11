# Orchestration and data strategy

## Persistence model

The minimum relational model includes:

- `wallets`
- `positions`
- `position_snapshots`
- `markets`
- `market_snapshots`
- `intents`
- `execution_plans`
- `provider_quotes`
- `financing_analyses`
- `financing_components`
- `funding_contributions`
- `feasibility_checks`
- `liquidity_reservations`
- `migrations`
- `commands`
- `outbox_messages`
- `chain_actions`
- `transport_legs`
- `evidence`
- `ledger_entries`
- `settlement_obligations`
- `audit_events`
- `recovery_cases`
- `asset_catalog_versions`

## Required constraints

- Unique intent hash and borrower nonce.
- Unique execution-plan hash and execution nonce.
- Unique migration ID.
- Unique command idempotency key.
- Unique chain ID, transaction hash, and log index.
- Unique migration ID and audit-event sequence.
- Unique migration ID, action type, and logical attempt.
- Optimistic migration version on phase updates.
- Check constraints preventing negative unsigned token amounts.
- Ledger reconciliation query grouped by migration, chain, token, and party.
- Unique financing-component identity and exactly one financing classification per component.
- A reservation constraint requiring a non-expired passing feasibility check for the same execution
  plan and funding evidence set.

## Evidence model

Every evidence record contains:

- Evidence ID and migration ID.
- Evidence type and schema version.
- Chain/provider and network identifier.
- Source block number and block hash when applicable.
- Transaction hash, log index, or provider reference.
- Raw observation hash and normalized payload.
- Observation time.
- Verification state: `PROVISIONAL`, `CONFIRMED`, `FINALIZED`, `RETRACTED`, or `REJECTED`.
- Verification method and verifier version.

Raw provider responses are retained in a protected diagnostic form, but business logic operates only on validated normalized data.

## Transactional outbox

1. A database transaction locks the migration.
2. The coordinator derives the phase from existing evidence.
3. If an action is needed, it inserts a command and outbox row together.
4. A publisher claims unsent outbox rows with database locking.
5. Publishing is retried until acknowledged by the queue.
6. Workers may receive the same command more than once.
7. The handler checks evidence and command state before any broadcast.
8. Completion stores resulting evidence and marks the command in one transaction.

Queue message deletion, timeout, or duplication must not change the financial result.

## Idempotency key scheme

Idempotency keys are derived from immutable logical action identity, not retry count. Examples:

- `reserve:<migrationId>`
- `confirm-supplementary-funding:<migrationId>:<contributionId>`
- `source-close:<migrationId>`
- `route-deposit:<migrationId>:<legIndex>`
- `target-open:<migrationId>`
- `solver-settle:<migrationId>`
- `near-finalize:<migrationId>`

A retry may create another transport attempt only after a recorded recovery decision creates a new leg index. It may never silently replace the original leg.

## State advancement algorithm

For each migration:

1. Obtain an exclusive migration lock.
2. Load signed intent, execution plan, current snapshots, financing analysis, funding contributions,
   commands, and evidence.
3. Recheck canonical blocks for evidence near the reorganization window.
4. Derive the strongest phase whose entry predicate is satisfied.
5. Compare derived phase with persisted phase and append any justified transition.
6. Re-evaluate deadlines, source payoff, cost classifications, confirmed external funding,
   destination capacity, safety limits, balances, and provider readiness.
7. If forward execution is safe, create exactly one next command.
8. If irreversible state exists and forward execution is unsafe, open or update recovery.
9. If no action is required, schedule the next observation time.

## Finality and reorg handling

- Each chain configuration defines confirmation and finality rules.
- Mined receipts are provisional.
- State advancement across an irreversible boundary requires finalized evidence.
- Watchers re-read the canonical block hash before advancement.
- A mismatched block retracts affected evidence and re-derives the phase.
- Retraction after a dependent external action creates an incident and recovery case; history is never deleted.
- A deep reorg incident is not eligible for automatic generic recovery. The worker stops command
  derivation until an operator reconciles direct chain state and selects a custody-specific action.
- `SOURCE_FINALITY_CONFIRMATIONS` and `DESTINATION_FINALITY_CONFIRMATIONS` are validated positive
  integers. Local Anvil uses one confirmation; each deployed environment must set chain-appropriate
  values before funded execution.

## Transport handling

- Fetch supported assets from the provider catalog; never derive provider IDs from symbols.
- Use dry quotes for display.
- Bind a committed quote to the exact execution plan before source closure.
- Submit the origin transaction identifier at most once per leg.
- Poll status idempotently.
- Persist unknown statuses, stop advancement, and alert.
- On provider success, independently verify destination token, receiver, amount, transaction, and finality.
- On refund, independently verify token, receiver, amount, transaction, and finality.
- On incomplete deposit, failed, or ambiguous custody, enter recovery.

## Recovery policies

### Feasibility fails before solver reservation or source close

- Reject or expire the plan and record the exact shortfall and failed capacity input.
- Release any solver reservation.
- Refund supplementary funding to its signed refund receiver after confirming no source draw exists.
- Require a new analysis and execution-plan signature; never silently increase borrower debt or fees.

### Quote or authorization expires before source close

- Release reservation.
- Mark `EXPIRED`.
- Do not create any source transaction.

### Source close reverts

- Verify unchanged source position.
- Release reservation.
- Return to a requote-required terminal outcome; do not reuse expired terms.

### Transport refund

- Verify actual refund custody.
- If test policy permits, return collateral to the borrower.
- Record the unresolved economic result of the already-closed source position.
- End `FAILED_SAFE` unless a separately authorized restoration succeeds.

### Destination funded but target open unavailable

- Hold collateral in migration escrow.
- Retry only within the signed window and current safety policy.
- Otherwise execute the signed return/recovery route.

### Destination capacity falls after source close

- Recalculate the complete obligation and current safe capacity from finalized destination state.
- Do not borrow above the protocol limit, DebtShift risk limit, available liquidity, or signed cap.
- Use only preauthorized and already secured supplementary funds or a smaller safe borrow that still
  covers the complete solver obligation.
- A bounded wait is permitted only inside the signed deadline and exposure policy; future liquidity
  or price recovery is never assumed.
- If no fully funded safe path remains, retain or unwind collateral through the signed recovery path,
  preserve the solver receivable, and record custody and residual exposure explicitly.

### Target opens but provider payout fails

- Keep borrowed proceeds in settlement escrow.
- Retry the exact payout idempotently.
- Prevent residual release until the obligation is reconciled.

### Worker, Redis, or RPC outage

- Restart from PostgreSQL.
- Rehydrate chain evidence.
- Do not assume an unacknowledged broadcast failed.

## Ledger rules

- Each balance movement creates equal debit and credit semantics in the migration ledger.
- Principal and fee are separate entries.
- Source payoff, borrower debt prepayment, solver-advanced costs, capitalized costs, separately paid
  costs, and supplementary settlement funding use distinct component codes.
- Each component is counted once. A borrower prepayment reduces solver principal and cannot also be
  credited as settlement funding; a separately paid cost cannot increase destination borrowing.
- Collateral and debt assets are never netted against one another.
- Chains are part of asset identity.
- Settlement requires zero unexplained imbalance.
- Dust disposition is explicit and bounded.
- A non-zero residual obligation prevents `SETTLED`.
- `SETTLED` additionally requires finalized evidence that destination proceeds plus authorized
  supplementary funding paid the exact solver principal and fee and every required capitalized-cost
  recipient. A ledger receivable is not payment.

## Feasibility evidence and phase predicates

- `QUOTED` requires a reconciled provisional financing analysis with `fundingShortfall = 0` under
  quote-time buffers.
- `AUTHORIZED` requires signatures over the financing hash and finalized evidence for every external
  funding contribution used by the plan.
- `RESERVED` requires a fresh passing feasibility check before the solver or test vault commits
  principal.
- `SOURCE_CLOSED` requires one final pre-source feasibility check within its maximum age and the exact
  reserved principal.
- `TARGET_OPEN` requires a post-delivery capacity recheck and a target position no riskier than the
  signed limits.
- `SETTLED` requires finalized exact payout evidence and a zero residual obligation.

Every feasibility record retains the component ledger hash, funding-evidence hashes, direct-read
block provenance, oracle update time, policy version, capacity components, required borrow,
shortfall, safety outputs, result, and expiry. A later failed check blocks execution even when an
earlier quote passed.

## API event delivery

- Audit events have monotonic per-migration sequence numbers.
- SSE envelopes contain event ID, migration ID, sequence, type, phase, chain, transaction hash, finality, and timestamp.
- Clients deduplicate by event ID.
- Reconnect uses the last observed sequence.
- REST event history is authoritative when SSE delivery is interrupted.
