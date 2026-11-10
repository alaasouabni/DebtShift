# Architecture blueprint

## Architectural shape

The initial implementation uses a modular monorepo with three application processes and two contract workspaces.

```text
Browser wallet
    |
    v
Next.js web  --->  NestJS API  ---> PostgreSQL
                         |   |          |
                         |   |          +--> transactional outbox
                         |   +--> refinancing analysis / risk validation
                         v
                    Redis/BullMQ ---> worker
                                         |
                     +-------------------+-------------------+
                     |                   |                   |
                 EVM RPCs         1Click/simulator       NEAR RPC
                     |                   |                   |
             EVM adapters/escrow   destination asset   receipt registry
```

## Deployable processes

### `apps/web`

- Connects the borrower wallet.
- Displays positions, market comparisons, quote details, and warnings.
- Requests signatures but never signs automatically.
- Displays live progress through SSE and recovers missed events through REST.
- Shows provider statuses separately from verified DebtShift phases.
- Provides evidence and recovery views.

### `apps/api`

- Authenticates wallet sessions.
- Validates all request schemas.
- Serves positions, markets, quotes, migrations, events, and evidence.
- Produces a reconciled financing analysis and rejects any non-zero funding shortfall.
- Builds EIP-712 payloads and verifies returned signatures.
- Creates database transactions and outbox commands.
- Never treats an API request as sufficient onchain authorization.

### `apps/worker`

- Indexes lending state and market state.
- Rehydrates canonical evidence before every state decision.
- Revalidates source payoff, secured funding, destination capacity, liquidity, and post-state safety
  before every irreversible financing action.
- Executes idempotent commands.
- Polls transport status and verifies chain receipts.
- Applies finality rules and handles reorgs.
- Runs recovery policies and ledger reconciliation.
- Publishes metrics and structured operational events.

## Shared packages

### `packages/domain`

- Branded identifiers and address types.
- Zod or equivalent runtime schemas.
- Phase and event definitions.
- EIP-712 structures and canonical hash functions.
- Integer amount helpers with explicit decimals.
- Protocol-specific safety types.

### `packages/database`

- Schema migrations and generated database types.
- Transaction helpers.
- Optimistic migration version checks.
- Outbox claiming and completion.
- Evidence, ledger, and audit repositories.

### `packages/optimizer`

- Source and target APR normalization.
- Execution-time utilization impact.
- Gas, transport, slippage, and solver cost projection.
- Sources-and-uses classification, maximum safe borrowing capacity, required destination borrow,
  and funding-shortfall calculation.
- Break-even and scenario analysis.
- Protocol-specific post-state and stress calculations.
- Deterministic route eligibility and ranking.

### `packages/agent`

- Exposes read-only tools over positions, markets, quotes, risk, and migration evidence.
- Runs the deterministic Route/Risk Agent policy.
- Defaults to deterministic financial-agent output without an LLM.
- Optionally sends already-computed structured results to either a local Ollama model or a user-selected remote AI provider.
- Uses one provider-neutral explanation interface and provider capability configuration.
- Validates explanation output against a schema and falls back to templates.
- Has no wallet, relayer, contract-write, solver-reservation, or transport-deposit tool.

### `packages/protocols`

- Aave position and market reader.
- Morpho position and market reader.
- Transaction simulation and receipt decoding.
- Direct destination liquidity, collateral constraint, oracle, and protocol-native safety reads used
  by feasibility revalidation.
- Deployment and asset allowlists.
- Provider-specific safety normalization without erasing native metrics.

### `packages/intents`

- Generated live 1Click client.
- Runtime token catalog mapping.
- Dry and committed quote models.
- Strict provider-status normalization.
- Deterministic simulator implementing the same internal interface.
- Destination receipt and balance verification.

The live client has two production modes in the first release:

- `mainnet-readonly` permits catalog reads and `dry: true` quotes only.
- `mainnet-canary` permits one user-confirmed committed quote and deposit under the canary policy.

The simulator remains the only funded transport implementation connected to the debt-refinancing state machine. The mainnet canary is isolated from lending adapters, solver reservations, and the liquidity vault.

### `packages/sdk`

- Generated REST client.
- SSE event types.
- Shared UI-safe view models.

## Contract workspaces

### `contracts/evm`

- Source migration adapter.
- Destination migration adapter.
- Migration escrow.
- Supplementary funding and settlement escrow controls.
- Test liquidity vault.
- Test protocol markets and tokens.
- Foundry tests and deployment scripts.

### `contracts/near`

- Agreement registration.
- Authorized verifier management.
- Append-only attestation records.
- Final receipt-hash registration.
- Read views and sandbox tests.

## Source-of-truth rules

| Claim                      | Authoritative source                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Borrower authorization     | Valid signature plus unconsumed onchain nonce and deadline.                                                 |
| Source debt and collateral | Lending contract state at a stored canonical block.                                                         |
| Source close               | Finalized receipt, expected adapter event, and follow-up position read.                                     |
| Refinancing feasibility    | Reconciled obligations, fresh capacity reads, finalized supplementary-funding evidence, and zero shortfall. |
| Transport outcome          | Provider status plus origin receipt, destination receipt, and balance verification.                         |
| Target position            | Lending contract state after the target transaction is finalized.                                           |
| Solver settlement          | Finalized exact solver payout, required financed-cost receipts, and balanced internal ledger.               |
| Workflow phase             | Deterministic derivation from signed terms and verified persisted evidence.                                 |
| Final registry record      | NEAR transaction receipt containing the expected receipt-bundle hash.                                       |

## State machine

```text
DRAFT -> QUOTED -> AUTHORIZED -> RESERVED -> SOURCE_CLOSED
                                              |
                                              v
ROUTING -> DEST_FUNDED -> TARGET_OPEN -> SETTLED -> COMPLETED
   |             |             |           |
   +-------------+-------------+-----------+--> RECOVERY -> FAILED_SAFE

Pre-irreversible expiry may enter EXPIRED.
No post-source-close failure may return to DRAFT, QUOTED, or EXPIRED.
```

### Phase meanings

- `DRAFT`: fresh source snapshot exists; no execution authorization exists.
- `QUOTED`: an eligible route, complete economics projection, and provisional zero-shortfall
  financing analysis exist.
- `AUTHORIZED`: the borrower’s intent and exact execution plan are valid.
  Authorization validity also requires the exact financing structure and finalized supplementary
  funding evidence to be bound to the execution plan.
- `RESERVED`: fresh feasibility still passes and solver or test-vault funding plus transport
  readiness are reserved inside their validity windows.
- `SOURCE_CLOSED`: source debt and released collateral custody are verified.
- `ROUTING`: one origin deposit is finalized and being tracked.
- `DEST_FUNDED`: expected destination token and minimum amount are finalized at the authorized receiver.
- `TARGET_OPEN`: target collateral and debt state satisfy signed limits and current safe capacity;
  authorized proceeds are held for settlement.
- `SETTLED`: solver principal, solver fee, financed costs, external funding, residuals, and ledger
  balances reconcile with the exact payout finalized.
- `COMPLETED`: the final receipt hash is registered and verified on NEAR.
- `RECOVERY`: an irreversible action occurred and the forward path is unsafe or unavailable.
- `FAILED_SAFE`: recovery has ended with all known assets and residual obligations recorded.
- `EXPIRED`: authorization or quote expired before any irreversible action.

## Command and evidence pattern

Every external action follows this sequence:

1. Lock the migration row and rehydrate canonical evidence.
2. Derive the current phase from evidence.
3. Check signed limits, complete settlement coverage, zero funding shortfall, and current safety
   conditions.
4. Insert a command with a deterministic idempotency key.
5. Commit the command and outbox notification in one database transaction.
6. Deliver the command at least once through the queue.
7. Before sending, check whether matching finalized evidence already exists.
8. Broadcast once or recover the already-broadcast transaction by nonce/hash.
9. Store provisional receipt observations.
10. Apply configured finality and canonical-block checks.
11. Store verified evidence.
12. Re-run phase derivation and append the transition event.

## Trust boundaries

- The browser controls borrower signing.
- The API may propose actions but cannot authorize capital movement.
- The worker holds only operational relayer keys for explicitly permitted test actions.
- EVM contracts enforce exact assets, markets, receivers, amounts, nonces, and deadlines.
- Funding escrow proves possession and authorized use of borrower contributions; an EOA balance or
  offchain promise is not confirmed funding.
- 1Click or the simulator transports assets but does not prove a lending position opened.
- The simulator is not described as 1Click testnet; simulator evidence is explicitly tagged with provider `DEBTSHIFT_SIMULATOR`.
- Live canary evidence is tagged `NEAR_INTENTS_1CLICK` and is accepted only from the production endpoint under the canary capability.
- Canary completion proves transport integration only; it cannot satisfy a debt migration’s source-close, target-open, settlement, or completion predicates.
- NEAR stores attestations and receipt hashes; it does not independently query EVM networks.
- PostgreSQL stores workflow history but cannot override contradictory chain evidence.
- Cross-chain execution is asynchronous. Per-chain contracts constrain actions and custody but do
  not guarantee future destination capacity or solver repayment; remaining exposure is bounded by
  explicit limits and recovery accounting.

## Repository target

```text
debtshift/
  apps/
    web/
    api/
    worker/
  packages/
    domain/
    database/
    optimizer/
    agent/
    protocols/
    intents/
    sdk/
  contracts/
    evm/
    near/
  infra/
    docker/
    monitoring/
    deployment/
  tests/
    integration/
    fork/
    e2e/
  scripts/
  docs/
  strategies-docs/
```
