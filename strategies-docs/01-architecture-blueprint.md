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
                 EVM RPCs       transport adapter        NEAR RPC
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
- Dry and committed quote, deposit binding, status, refund, and receipt models.
- Strict provider-status normalization.
- Deterministic simulator implementing the same internal interface.
- Destination receipt and balance verification.

The package exposes one transport port. The deterministic provider and official 1Click client both
implement that port. Provider-specific raw observations are retained, but normalized workflow
semantics are shared. `mainnet-readonly` exposes catalog and `dry: true` quote operations without a
write-capable adapter. `mainnet` exposes the committed quote, deposit binding, status, refund, and
receipt operations required by the complete refinance.

## Runtime composition and modes

The core API and worker contain no simulator-specific branching. The validated composition root
selects complete adapter sets:

| Mode               | Source/destination                                      | Transport                       | Registry                                  | Writes                                    |
| ------------------ | ------------------------------------------------------- | ------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `sandbox`          | Private local chains and deployed test contracts        | Receipt-producing simulator     | NEAR sandbox or configured local verifier | Enabled for test assets                   |
| `testnet`          | Public testnet deployments                              | Receipt-producing simulator     | NEAR testnet                              | Enabled for test assets                   |
| `mainnet-readonly` | Official production reads                               | Official catalog and dry quotes | Read-only                                 | Prohibited by construction                |
| `mainnet`          | Official production protocols and DebtShift deployments | Official committed 1Click flow  | Configured production registry            | Requires `MAINNET_EXECUTION_ENABLED=true` |

The central workflow depends on source, liquidity, transport, destination, settlement, canonicality,
and registry ports. Sandbox/testnet adapters execute the same commands and evidence predicates as
mainnet. Production code cannot import simulator modules, and production failures never fall back to
simulation.

`MAINNET_EXECUTION_ENABLED` is evaluated server-side at startup and again at every irreversible
command boundary. `false` does not change providers or fabricate a read-only mode; it rejects writes
while permitting configuration validation and non-broadcast preflight. The frontend cannot alter it.

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
- Permissioned liquidity vault and isolated recovery reserve for the initial route.
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
- Live evidence is tagged `NEAR_INTENTS_1CLICK` and is accepted only from the pinned production
  endpoint in `mainnet`; it still requires independent origin/destination receipts and balance reads.
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
