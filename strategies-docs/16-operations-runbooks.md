# DebtShift operations and recovery runbooks

## Purpose and operating boundary

These are the executable operator procedures for the first configured DebtShift route. They
complement `06-environments-deployment-operations.md`; they do not weaken signed limits, evidence
predicates, contract authorization, or the default-off mainnet switch.

- PostgreSQL is authoritative for workflow, evidence, commands, ledger, recovery, and alerts.
- Redis/BullMQ is disposable delivery infrastructure and is never proof of a financial action.
- A provider status is an observation, not proof of custody or settlement.
- Never retry an irreversible action manually until its chain event, receipt, balance, nonce, and
  durable action record have been reconciled.
- `MAINNET_EXECUTION_ENABLED=false` is the first containment control for production application
  writes. It does not replace pausing adapters or revoking a compromised relayer.
- Owner/admin transactions use the configured multisig or hardware-wallet process. Never paste an
  owner, relayer, NEAR signer, provider, or database secret into a ticket, shell history, or log.

These runbooks do not authorize a real mainnet transaction. Mainnet exposure still requires the
acceptance gate and the owner's explicit approval of exact financial terms.

## Severity and incident roles

| Severity | Trigger                                                              | First response                                                               |
| -------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| SEV-1    | Suspected key compromise, unauthorized write, unexplained asset loss | Disable mainnet execution, pause both adapters, revoke the affected relayer. |
| SEV-2    | Post-source-close custody ambiguity, payout failure, ledger mismatch | Stop forward execution; preserve custody and open recovery.                  |
| SEV-3    | Pre-source stale state, RPC failure, queue outage, deadline risk     | Stop new execution, restore service, revalidate or safely expire/requote.    |

One incident lead owns the timeline. One financial reconciler independently checks assets and
obligations. One authorized signer submits contract administration. The same person must not both
propose and silently approve an emergency mainnet transaction.

## Common containment and evidence capture

Use this sequence before a recovery-specific runbook unless it would delay an active compromise:

1. Record UTC time, mode, deployment manifest hash, image digest, migration ID, active phase, and
   open alerts.
2. In production, set `MAINNET_EXECUTION_ENABLED=false` server-side and restart API and worker.
   Verify write-disabled `mainnet` or use `mainnet-readonly`.
3. If source close or destination open must be stopped independently, submit `setPaused(true)` to
   both `SourceAdapter` and `DestinationAdapter` through the owner multisig.
4. Do not delete Redis jobs, mutate migration phases, edit evidence, or mark commands succeeded.
5. Capture the read-only application views:

   ```text
   GET /v1/migrations/<migration-id>
   GET /v1/migrations/<migration-id>/events
   GET /v1/migrations/<migration-id>/evidence
   ```

6. Capture these PostgreSQL views with a read-only role. Bind `migration_id`; do not interpolate
   untrusted text:

   ```sql
   SELECT migration_id, phase, version, expires_at, updated_at
   FROM migrations WHERE migration_id = :'migration_id';

   SELECT command_id, type, status, logical_attempt, available_at, last_error, updated_at
   FROM commands WHERE migration_id = :'migration_id' ORDER BY created_at;

   SELECT action_type, action_key, chain_id, transaction_hash, finality,
          block_number, block_hash, updated_at
   FROM chain_actions WHERE migration_id = :'migration_id' ORDER BY created_at;

   SELECT type, verification_state, provider, network, chain_id, transaction_hash,
          block_number, block_hash, provider_reference, observed_at
   FROM evidence WHERE migration_id = :'migration_id' ORDER BY created_at;

   SELECT provider, provider_state, input_units, minimum_output_units,
          observed_output_units, origin_transaction_hash,
          destination_transaction_hash, refund_transaction_hash, updated_at
   FROM transport_legs WHERE migration_id = :'migration_id';

   SELECT status, principal_units, fee_cap_units, provider, asset, expires_at, updated_at
   FROM liquidity_reservations WHERE migration_id = :'migration_id';

   SELECT sequence, component_code, component_id, chain_id, token, amount_units,
          debit_party, credit_party, category, transaction_reference
   FROM ledger_entries WHERE migration_id = :'migration_id' ORDER BY sequence;

   SELECT policy, status, reason, residual_assets, opened_at, resolved_at
   FROM recovery_cases WHERE migration_id = :'migration_id';

   SELECT type, severity, status, message, details, first_observed_at,
          last_observed_at, resolved_at
   FROM operational_alerts WHERE migration_id = :'migration_id' ORDER BY created_at;
   ```

7. Independently query both RPCs for every recorded receipt and relevant token balance. Compare block
   hashes and required confirmation depth with durable evidence; do not rely on an explorer alone.
8. Hash and retain the incident snapshot outside the application database without secrets or raw
   authorization material.

## Worker restart and stale-command recovery

1. Confirm PostgreSQL is reachable and take a backup before invasive infrastructure work.
2. Inspect command, outbox, chain-action, evidence, recovery, and alert rows.
3. If a command is `RUNNING`, wait at least `WORKFLOW_COMMAND_STALE_AFTER_MS` from `updated_at` unless
   the prior worker is known to be fully stopped. Never run two workers against an uncertain side
   effect merely to accelerate recovery.
4. Check the last chain action directly. If its transaction exists, let reconciliation append
   evidence; do not submit a replacement manually.
5. Start exactly one worker with the original mode, manifest, signer identity, and retry policy.
   Startup calls `recoverStaleCommands`, then republishes durable outbox work.
6. Verify the recovered count and confirm no duplicate action key, transaction, evidence, or ledger
   component appears.
7. At retry exhaustion require `FAILED_TERMINAL` plus its operational alert. Financial commands
   after source close must also have a recovery case with exact custody, reserve, and receivable.
8. Close only when balances, durable evidence, and terminal phase agree.

## RPC provider failover

1. Disable new execution. In production set `MAINNET_EXECUTION_ENABLED=false` and restart before
   changing endpoints.
2. Record the failing endpoint identity, chain ID, last head, latency, and error class without
   embedded credentials.
3. Validate the replacement against expected chain ID, finalized head, deployment block, and known
   contract code hashes from the manifest.
4. Compare every persisted finalized block hash for active migrations. A mismatch requires evidence
   retraction/reconciliation, not blind continuation.
5. For an EVM endpoint, replace only `SOURCE_RPC_URL` or `DESTINATION_RPC_URL`; retain chain IDs,
   deployment blocks, confirmation policy, and contract addresses. For NEAR, edit the ordered
   `NEAR_RPC_URL`/`NEAR_RPC_FALLBACK_URLS_JSON` allowlist only after every candidate reports the
   configured `NEAR_NETWORK` and final-state registry views agree.
6. Restart read-only services first and run live route/deployment readiness checks. Start the worker
   only after canonical history agrees.
7. Re-enable only after both RPCs, code, roles, balances, finality, and active evidence pass. Failover
   never extends a signed deadline.

For NEAR specifically, reads may move immediately to the next configured endpoint. Writes do not.
If a registry call times out or loses its response, stop that worker attempt and inspect the final
agreement, ordered attestations, final receipt, signer nonce, and transaction history. The durable
retry path performs these contract reads before it can issue a still-missing mutation. Never copy
the original signed transaction to another provider or manually repeat a call based only on an RPC
error. Wrong-network endpoints, immutable conflicts, or divergent final state require containment
and reconciliation rather than retry.

## Redis loss and reconstruction from PostgreSQL

1. Stop the worker. Keep reads available, but stop new execution when the outage could cross a
   signed deadline.
2. Preserve PostgreSQL. Do not edit command/outbox status to resemble Redis.
3. Restore Redis with `noeviction` and suitable persistence. Its content remains non-authoritative.
4. Start exactly one worker. The outbox reconstructs delivery from PostgreSQL and stale-command
   recovery reclaims abandoned durable commands.
5. Confirm stable idempotency keys and require chain-action/onchain reconciliation before broadcast.
6. Compare migration, command, evidence, ledger, and alert rows before and after recovery. Close only
   after proving no duplicated asset movement.

## PostgreSQL backup and restore drill

PostgreSQL holds the only complete workflow history. Backups must be encrypted, access-controlled,
retention-limited, and tested. A dump is sensitive even though borrower private keys are not stored.

For the repository Docker stack run:

```text
npm run ops:drill:database-restore
```

The drill checks PostgreSQL, takes a custom-format `pg_dump`, creates a random
`debtshift_restore_*` sibling database from `template0`, restores with `--exit-on-error --no-owner
--no-privileges`, compares the complete public-table set and exact row counts plus Drizzle migration
history, prints size/SHA-256 evidence, then removes only the generated database and temporary dump.

The script rejects non-lowercase PostgreSQL identifiers and never drops, cleans, or writes to the
source database. Production restore must use an isolated server or database. Then also verify:

- newest backup time and recovery point objective;
- all checked-in migrations and `drizzle.__drizzle_migrations` history;
- counts and hashes for migrations, commands, chain actions, evidence, audit events, ledger entries,
  recovery cases, and alerts;
- constraints and application read paths;
- every active migration against live chain/provider state before starting a worker;
- Redis reconstruction only after PostgreSQL reconciliation.

Never point a worker at the restore until RPCs, manifest, signer, mode, and active state are reviewed.

## PostgreSQL migration recovery drill

DebtShift uses forward-only application migrations. A production schema rollback must not improvise
reverse SQL against append-only financial history: reverse DDL can silently discard durable
commands, evidence, ledger entries, or recovery state. The supported rollback boundary is an exact
pre-change backup restored into an isolated database, followed by application and chain-state
reconciliation.

For the repository Docker stack run:

```text
npm run ops:drill:database-migration-recovery
```

The checked-in drill never connects to the DebtShift application database. It:

1. creates a random `debtshift_migration_*` database from `template0`;
2. applies every checked-in migration through the real Drizzle migration entry point;
3. creates one isolated baseline fixture and a custom-format pre-change backup;
4. runs a deliberately failing transactional DDL candidate and proves PostgreSQL removed its
   partial column change;
5. runs a successful forward DDL/data candidate and verifies the changed state;
6. drops only the generated database, recreates it, and restores the pre-change backup;
7. verifies the complete public-table set, exact row counts, migration fingerprint, absence of both
   candidate columns, and original fixture state;
8. reruns the checked-in migrator and proves the recovered migration history and schema remain
   idempotent; and
9. prints backup size/SHA-256 evidence, removes the generated database, and deletes the temporary
   artifact.

This proves the repository mechanisms and recovery sequence, not a production recovery point
objective. For a deployment migration:

1. stop workers and disable write ingress before the backup boundary;
2. record the release image digest, migration set/hash, database version, backup identity, and exact
   chain/provider checkpoint;
3. take and independently verify the encrypted pre-change backup;
4. run the forward migration, constraints, application read checks, and workflow invariants before
   reopening writes;
5. if validation fails before writes reopen, restore into a fresh database, repeat the drill's
   equality checks, reconcile every non-terminal migration against live chains/providers, and only
   then repoint the application; and
6. if any post-migration application write occurred, preserve both databases and use an explicit
   forward repair/data reconciliation plan. Never restore over new financial history.

Do not treat transactional DDL success as proof that an application migration is reversible. Do not
run a generated `down` migration on production, overwrite the source database in place, or start a
worker against a recovered database before independent reconciliation.

## Interrupted public-testnet vault funding

The guarded procedure and immutable evidence contract are defined in
`23-testnet-vault-funding.md`. If funding times out, exits with an empty reserved manifest, or cannot
prove allowance cleanup:

1. Keep workflow writes disabled and do not restart the funding command.
2. Preserve the output path, intended amount, funder nonce range, command output, and all
   explorer-visible transactions.
3. At finalized source blocks, reconcile the funder-to-vault allowance, funder/vault token
   balances, free liquidity, undrawn reservations, and recovery reserves.
4. Revoke any residual allowance through a separately reviewed recovery transaction. Preserve its
   receipt and do not increase the allowance.
5. Determine whether the exact deposit already completed before considering a new attempt. Never
   fund twice because the first command did not produce a manifest.
6. Require a new manifest path and explicit approval only after the incident record is complete.

An RPC timeout, empty file, or absent console output does not prove that no transaction was mined.

## Stuck reservation before source close

1. Confirm the source did not close from adapter event, lending position, escrow balance, and
   finalized evidence—not merely the phase label.
2. Identify expiry, failed revalidation, missing funding, insufficient capacity, invalid
   authorization, or operator containment.
3. Prefer the workflow feasibility-failure/requote path; it records failed feasibility and releases
   an active undrawn reservation atomically where applicable.
4. For manual owner-approved release require vault status `ACTIVE`, zero source-close evidence,
   unchanged source position, and no vault draw/receivable.
5. Prefer an idempotent application recovery command. Direct `LiquidityVault.release` is an
   emergency operator action requiring an incident record and independent reconciliation.
6. Verify `ReservationReleased`, free liquidity, recovery-reserve release, durable status, zero
   solver receivable, and the evidence-justified terminal phase.

Never release `DRAWN`: solver principal was already used and needs post-source recovery accounting.

## Transport processing, refund, or unknown custody

1. Stop target execution for `PROCESSING`, `UNKNOWN`, inconsistent terminal state, or any
   receipt/balance mismatch.
2. Record committed quote hash, deposit address/memo, origin transaction, provider reference,
   deadline, refund receiver, and raw response.
3. Verify the origin transaction and source escrow delta directly onchain.
4. Query official status without changing deposit or receiver; all later results remain bound to the
   committed quote.
5. For delivery verify destination transaction, token, receiver, amount, and finality. Below-minimum
   or wrong-receiver delivery must not open Morpho.
6. For refund require payment to the migration-bound source recovery escrow. Verify exact receipt and
   amount, then return only verified custody to the signed receiver.
7. At deadline with unknown custody keep recovery and solver exposure explicit, escalate the alert,
   and continue read-only reconciliation. Never invent `REFUNDED`, `SUCCESS`, or `COMPLETED`.

## Destination-funded recovery

1. Confirm canonical source-close and destination-delivery evidence.
2. Read destination escrow categories separately: transported collateral, destination loan
   proceeds, supplementary funding, and solver repayment.
3. Re-read Morpho market, oracle, liquidity, authorization, and signed limits.
4. If capacity/authorization fails, do not borrow. Record exact custody, solver principal/fee claim,
   reserve, next permitted action, deadline, and escalation owner in recovery.
5. Return collateral only through the signed recovery receiver path, never an operator wallet.
6. Settle the vault from the isolated reserve only through the authorized recovery path and retain
   remaining economic exposure explicitly.
7. Verify escrow categories, borrower refund, vault receivable/reserve, ledger, and failed-safe phase.

## Borrowing-capacity deterioration

Before source close, append fresh failed feasibility, reject or atomically release the undrawn
reservation, prove source assets unchanged and solver receivable zero, then require requote/signature
as needed.

After source close, never exceed current signed/policy capacity. Preserve or return collateral via
the signed recovery path, and record exact custody and solver exposure. Resume forward execution only
if an explicitly supported workflow can append a newer passing proof within the original limits and
deadline; otherwise recover and requote.

## Supplementary-funding lifecycle

Deposit confirmation:

1. Verify migration, destination chain, token, depositor, refund receiver, exact amount,
   authorized-use hash, and deadline against the plan.
2. Require canonical escrow transaction and funding status `LOCKED`.
3. Count funds only after finalized evidence; wallet balance or pending transfer is not funding.

Cancellation/refund:

1. Confirm unspent state and satisfied refund condition/deadline.
2. Use only the permissionless contract refund to the committed receiver.
3. Verify `REFUNDED`, exact token/amount, escrow delta, receiver delta, and durable evidence.

Settlement:

1. Match latest feasibility funding hash to the escrow record.
2. Require atomic settlement to mark `SPENT`; never release in a separate operator transfer.
3. Reconcile solver principal, fee, capitalized cost, residual, and funding exactly once.

For any mismatch, stop before reservation/source close, append rejected evidence without editing the
prior row, and refund only through onchain commitment rules or escalate unknown custody.

## Solver payout failure after collateral delivery

1. Block `SETTLED`/`COMPLETED` and contain further execution.
2. Determine whether the atomic transaction reverted or succeeded despite an RPC error. Check
   receipt, logs, target position, escrow categories, payout balance, and vault receivable.
3. If successful, reconcile the existing transaction and do not retry payout.
4. If reverted, prove no target loan/payout and collateral still in escrow before bounded retry.
5. At exhaustion require `FAILED_TERMINAL`, critical payout/exposure alert, and recovery containing
   custody, principal, fee claim, reserve, and evidence references.
6. Manual payment outside signed atomic settlement is prohibited for the initial route. Exceptional
   loss allocation needs separate owner authorization and honest accounting.

## Relayer and verifier key rotation

### EVM relayer

The stable owner should be a multisig. Rotate the hot relayer add-before-remove:

1. Set `MAINNET_EXECUTION_ENABLED=false`; restart and pause both adapters if compromise is suspected.
2. Generate the replacement in approved custody; record only its address/key identifier.
3. From the owner multisig add required roles:
   - `SourceAdapter.setExecutor(new, true)`;
   - `DestinationAdapter.setExecutor(new, true)` and, if needed, `setVerifier(new, true)`;
   - `LiquidityVault.setOperator(new, true)` and `setVerifier(new, true)`;
   - each `MigrationEscrow.setOperator(new, true)` or `setDepositor(new, true)` only where assigned.
4. Read every role mapping and run no-broadcast/readiness simulation from the new address.
5. Update server-side `EXECUTOR_PRIVATE_KEY` and restart with writes disabled.
6. Remove the old address from each role through the owner multisig.
7. Prove old rejected/new accepted and review active nonces/pending transactions.
8. Re-enable only after code, roles, balances, routes, migrations, and alerts pass acceptance.

Contract ownership is separate. The first EVM deployment keeps a stable owner/admin and not every
module exposes ownership transfer. Use a production multisig at deployment; changing owner requires
a reviewed redeployment/migration, not an improvised relayer procedure.

### NEAR verifier

1. Keep at least one verifier at all times.
2. Registry owner calls `add_verifier`; confirm `is_verifier(new)` and smoke an attestation.
3. Update `NEAR_SIGNER_ACCOUNT_ID`/`NEAR_SIGNER_PRIVATE_KEY` in the secret manager and restart with
   mainnet writes disabled where applicable.
4. Call `remove_verifier(old)` and prove it cannot attest.
5. Owner rotation uses `propose_owner` then `accept_owner`; use `cancel_owner_transfer` on failure.

### Provider/API credentials

Issue replacement, install it in the secret manager, restart and verify authenticated read-only
calls, then revoke old. Scan logs, database, browser persistence, artifacts, and notes for exposure.
User explanation keys remain request-scoped and memory-only.

## Emergency pause and controlled unpause

Pause:

1. Set `MAINNET_EXECUTION_ENABLED=false` and restart API/worker.
2. Owner multisig calls `SourceAdapter.setPaused(true)` and
   `DestinationAdapter.setPaused(true)` on their chains.
3. Revoke a compromised relayer from adapter/vault/escrow allowlists.
4. Verify both paused and execution rejected. Pausing does not resolve active reservations, provider
   custody, or solver exposure; continue the applicable recovery runbook.

Unpause:

1. Document root cause and reconcile every migration active at pause time.
2. Verify database, RPC canonicality, provider state, alerts, code hashes, roles, balances,
   allowances, vault liquidity/reserve, and route.
3. Run sandbox/fork/security/readiness gates and non-broadcast simulations.
4. Call `setPaused(false)` with application writes still disabled and verify both contracts.
5. `MAINNET_EXECUTION_ENABLED=true` remains a separate explicitly approved release decision.

## Evidence, receipt, or ledger mismatch

1. Stop the next irreversible action and keep raw observations immutable.
2. Classify provider/chain, receipt block/transaction/log, token, amount, receiver, finality,
   supersession, receipt-bundle, or ledger-classification mismatch.
3. Query an independent RPC. On reorg append retraction; never delete original evidence.
4. Recompute canonical evidence ID and NEAR receipt bundle from active finalized durable evidence,
   then compare raw receipt and registry view.
5. Reconcile ledger component identities. Never add an unsupported balancing entry or change a
   category merely to force zero.
6. Keep the alert open until canonical state and durable evidence agree. With uncertain custody or
   an outstanding obligation, retain recovery and escalate SEV-2.

## Closure checklist

Close only when switch/pause states match approved mode; each active migration has a justified phase
or recovery case; irreversible actions match canonical receipts/balances; reservations, funding,
escrow categories, receivables, and reserve are exact; ledger has no unexplained imbalance; critical
alerts resolved from healthy evidence; rotated roles are verified; artifacts have hashes/retention;
and the UTC timeline, cause, corrective action, and remaining exposure are recorded.
