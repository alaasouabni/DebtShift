# Environments, deployment, and operations

## Environment matrix

| `DEBTSHIFT_MODE`   | Purpose                                                                              | Asset movement                                                                             |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `sandbox`          | Hosted/developer private-chain execution of the complete workflow                    | Real local-chain test-asset transactions; simulated external transport boundary            |
| `testnet`          | Public EVM test deployments and NEAR testnet registry                                | Real public testnet transactions; simulated external transport boundary                    |
| `mainnet-readonly` | Production position/market reads, 1Click catalog, and `dry: true` quotes             | Prohibited by construction                                                                 |
| `mainnet`          | Complete production refinance through Aave, 1Click, Morpho, settlement, and registry | Real assets only when `MAINNET_EXECUTION_ENABLED=true` and every authorization gate passes |

Local development and CI instantiate the `sandbox` composition with ephemeral infrastructure. They
are deployment topologies, not additional product modes.

## Sandbox topology

- Web application.
- API application.
- Worker application.
- PostgreSQL.
- Redis.
- Source Anvil node.
- Destination Anvil node.
- Transport simulator.
- Optional NEAR sandbox process.
- Prometheus-compatible metrics endpoint and local dashboard configuration.

## Configuration groups

Configuration schemas are divided into:

- Application URLs and ports.
- Database and Redis connections.
- Source and destination RPC endpoints.
- Chain IDs and finality policy.
  - `SOURCE_FINALITY_CONFIRMATIONS` and `DESTINATION_FINALITY_CONFIRMATIONS` are required positive
    confirmation depths; the checked-in local default is `1`, not a mainnet recommendation.
- Protocol deployment and asset allowlists.
- Transport mode, URL, and authentication reference.
- NEAR network, RPC, registry account, and verifier identity.
- Relayer key references.
- Risk, fee, timeout, and exposure policy.
- Capacity buffers, cost-classification policy, approved shortfall-resolution modes, and
  supplementary-funding finality requirements.
- Observability exporters and log levels.

Market-provider selection is explicit and validated:

- `sandbox` and `testnet` use configured contract-backed test market adapters and
  `TRANSPORT_PROVIDER=DEBTSHIFT_SIMULATOR`.
- `mainnet-readonly` requires `MARKET_DATA_PROVIDER=LIVE_READ_ONLY`, an authenticated 1Click client,
  and a complete `LIVE_MARKET_CONFIG_JSON` registry.
- `mainnet` requires production market and execution adapters, the official 1Click origin, complete
  deployment manifests, relayer references, and a configured production registry.
- Production modes never fall back to simulator fixtures when configuration or an external provider
  is unavailable.

`MAINNET_EXECUTION_ENABLED` is required and defaults to `false`:

- `sandbox`, `testnet`, and `mainnet-readonly` reject `true` at startup.
- `mainnet` with `false` permits live validation, route preparation, transaction construction, and
  non-broadcast simulation but rejects every irreversible command before side effects.
- `mainnet` with `true` permits the complete workflow only after all ordinary signed, funding,
  freshness, role, pause, and policy checks pass.
- The value is read server-side at startup, requires a restart to change, is exposed read-only in
  capability metadata, and cannot be changed from the browser.

The live registry has no built-in production addresses. It supplies the Aave pool/data provider,
Morpho singleton/market/oracle, exact token identities and 1Click asset IDs, Chainlink feeds and age
limits, route policy, conservative gas bounds, and analytics risk-cost assumptions. Direct reads
must confirm chain, token metadata, market identity, and oracle identity before observations are
accepted.

Secrets are referenced through environment or a secret manager. `.env.example` contains names and safe examples only.

## 1Click network constraint

There is no public 1Click testnet stack. The environments therefore use the following explicit split:

- `sandbox` and `testnet` use `DEBTSHIFT_SIMULATOR` only for the unavailable external provider
  boundary. Each reported origin, destination, or refund movement must reference an actual chain
  transaction and verified balance change.
- `mainnet-readonly` may call the production 1Click token endpoint and request only `dry: true` quotes.
- `mainnet` implements committed quotes, exact deposit binding, status polling, refunds, and receipt
  reconciliation as part of the complete refinance workflow.
- NEAR testnet is used for the DebtShift agreement and receipt registry only. A registry record may refer to simulated transport evidence, and that evidence must be labeled as simulated.
- The production registry network/account is explicit mainnet deployment configuration.

Configuration validation rejects invented testnet URLs, production transport outside `mainnet`,
mainnet execution in any other mode, and any attempt to pair simulated evidence with provider
identity `NEAR_INTENTS_1CLICK`.

### Initial mainnet route policy

- Exactly one allowlisted origin/destination asset pair and chain pair.
- Fixed maximum principal, collateral, destination debt, fee, slippage, gas, duration, and recovery
  exposure expressed in native/base units.
- Migration-specific source refund escrow, destination escrow, solver payout receiver, residual
  receiver, and exact adapter/market identities.
- No server-held borrower key; the borrower signs bounded intent, plan, allowance/permit, and Morpho
  authorization data through the wallet.
- Explicit owner approval after exact committed terms and recovery exposure are displayed.
- One active real migration at a time for the initial deployment.
- Default-disabled application switch plus independent onchain pause controls.
- Independent origin and destination receipt verification.
- Pre-funded vault and separately isolated recovery reserve before source close.

## Deployment manifests

Every contract deployment produces a versioned manifest containing:

- Environment and network.
- Chain ID.
- Contract name and address/account.
- Deployment transaction hash.
- Bytecode or WASM hash.
- Constructor or initialization arguments.
- Administrator and pauser identities.
- Source commit.
- Deployment timestamp.

Applications refuse to start if required manifest entries or chain IDs disagree with runtime configuration.

## CI stages

1. Install pinned toolchains and dependencies.
2. Validate formatting, generated files, and environment documentation.
3. Build TypeScript, Solidity, and Rust workspaces.
4. Run unit and database tests.
5. Run Foundry fuzz and invariant tests.
6. Run NEAR sandbox tests.
7. Start the containerized local stack.
8. Run deterministic happy-path and recovery E2E tests.
9. Scan dependencies, secrets, images, and generated SBOM.
10. Publish immutable test artifacts and reports.

The security job is fail-closed for three independently scoped checks:

- `npm audit --omit=dev --audit-level=high` requires zero high or critical findings in production
  dependencies. Development-only findings remain visible to the ordinary audit and are monitored,
  but cannot be confused with the shipped dependency set.
- Gitleaks `8.30.1` scans the complete Git history. `gitleaks.toml` extends the default rules and
  allowlists only four exact, public deterministic Anvil fixture values plus one exact
  route-binding documentation sentence that triggers the generic-key heuristic; it does not
  exclude any path or rule category.
- Trivy `0.76.2` scans the built runtime image for fixable high or critical OS and library findings
  and fails on any result. Unfixed upstream findings do not fail the build but must be reviewed
  before release. The same pinned scanner emits a CycloneDX runtime SBOM retained as a CI artifact.

The runtime image is multi-stage and pinned to Node `22.23.5` on Debian `12.15` by digest. Solidity,
TypeScript, Next, and dependency pruning run only in the build stage. The final image contains the
application artifacts and Anvil binary required by the shared sandbox topology, but not npm,
Corepack, Yarn, curl, or the rest of the Foundry toolchain. Migration and web services therefore
invoke their Node entry points directly.

## Operational metrics

The API exposes Prometheus text format at `GET /v1/metrics`. It is generated from authoritative
PostgreSQL state and exports no migration, command, transaction, wallet, receiver, quote, or evidence
identifier as a label. Deployments must restrict this path to the monitoring network at the ingress;
the local sandbox exposes it on loopback with the rest of the API. Base-unit amount series are
aggregate operational signals stored by Prometheus as floating-point samples; they never replace the
exact durable ledger or authorize a financial action.

The current endpoint exports every migration phase (including zero values), current phase-age
histograms, persisted phase transitions, command status/attempts, evidence verification state,
chain-action finality, transport state, reservation principal/fee caps, recovery counts/age,
operational alerts, transactional outbox state, and ledger count/volume. API preparation and
authorization plus worker command/evidence/phase/retry outcomes emit structured JSON records with
the migration/command correlation fields and chain context. Secret material and signed payloads are
not logged.

- Active migrations by phase and route.
- Phase duration histogram.
- Command attempts and terminal failures.
- Transport outcomes by route and token.
- Reservation amount and shortfall.
- Maximum safe borrowing capacity, required destination borrow, confirmed external funding, and
  funding shortfall by migration.
- Feasibility-check age and result at quote, reservation, source-close, target-open, and settlement
  checkpoints.
- Source and destination finality delay.
- Post-migration Aave health factor or Morpho LTV margin.
- Oracle age.
- Ledger imbalance.
- Receipt mismatch.
- Recovery age.
- SSE connected clients and replay count.

Durable workflow retries are bounded by `WORKFLOW_COMMAND_MAX_ATTEMPTS` and exponential backoff from
`WORKFLOW_COMMAND_RETRY_DELAY_MS`, capped by `WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS`.
`WORKFLOW_COMMAND_STALE_AFTER_MS` controls recovery of abandoned worker leases. These operational
limits never extend a signed execution deadline; the transport handler transitions unresolved
custody to explicit recovery when that deadline is crossed.

The worker passes BullMQ's current-attempt position into the durable command processor. A retryable
failure on the configured final attempt is persisted as `FAILED_TERMINAL` rather than being left
stranded as `FAILED_RETRYABLE`. Transport, atomic target/payout, and post-payout settlement commands
also append a manual `RECOVERY_OPENED` record with exact durable custody, reserve, receivable, and
supporting-evidence references where applicable. Manual-review recovery does not enqueue an unsafe
automatic recovery command. Other exhausted commands become immediately visible through the
terminal-command alert.

## Required alerts

- Liquidity reservation below commitment.
- Non-zero funding shortfall or missing supplementary-funding evidence at any pre-source checkpoint.
- Destination safe capacity below required borrowing after source closure.
- Feasibility input, funding evidence, or capacity snapshot expired before an irreversible command.
- Execution deadline approaching with an active irreversible migration.
- Transport terminal status not reconciled with balances.
- Destination funding below minimum.
- Target safety policy failure after destination funding.
- Settlement payout mismatch.
- Non-zero ledger imbalance at a terminal phase.
- Recovery older than its allowed window.
- Canonical block mismatch or retracted evidence.
- NEAR final receipt mismatch.

The worker persists and exercises the P0 operational conditions in `operational_alerts`:
signed-deadline approach/crossing, stale active migration, stale recovery, unknown transport
custody, terminal command failure, missing settlement ledgers, reservation underfunding, retracted
or rejected chain receipts, invalid or persistence-divergent ledger reconciliation, financing
expiry, missing/expired supplementary funding, capacity/policy deterioration, outstanding solver
exposure, and atomic target/payout failure after destination delivery. Alert identifiers and
deduplication keys are deterministic, repeated scans update `last_observed_at` without duplicate
rows, severity can escalate, and a later healthy scan resolves the alert without deleting its
history. Scans select only active-migration evidence and ledger rows, and superseded finalized
evidence cannot satisfy a financial predicate. Thresholds are environment validated through
`ALERT_SCAN_INTERVAL_MS`, `ALERT_DEADLINE_LEAD_MS`, `ALERT_STALE_MIGRATION_MS`, and
`ALERT_STALE_RECOVERY_MS`. The worker emits structured warning records when a scan opens or resolves
alerts. Terminal transport outcomes additionally reconcile provider state and recorded amounts with
the independently verified destination or refund evidence; below-minimum destination funding is a
separate critical condition. Final NEAR evidence is re-hashed from its canonical durable bundle,
checked against its raw receipt hash and deterministic evidence identifier, and required for every
`COMPLETED` migration. All required alert classes above are covered; external delivery routing and
operator acknowledgement remain deployment acceptance gates.

## Runbooks

Operations documentation must cover:

- Worker restart and command recovery.
- RPC provider failover.
- Redis loss with PostgreSQL recovery.
- Database backup restoration.
- Stuck reservation release.
- Transport refund reconciliation.
- Destination-funded recovery.
- Borrowing-capacity deterioration before and after source closure.
- Supplementary-funding deposit confirmation, cancellation refund, settlement consumption, and
  mismatch investigation.
- Solver payout failure after collateral delivery, including exposure escalation and receivable
  reconciliation.
- Relayer key rotation.
- Emergency pause and unpause.
- Evidence mismatch investigation.

## Mainnet safety lock

The production implementation is complete, but deployment remains write-disabled until the final
release gate. Setting `MAINNET_EXECUTION_ENABLED=true` requires:

- All required sandbox, testnet, fork, provider, recovery, restart, and clean-checkout tests passing.
- Resolved known critical and high security findings; absence of an independent audit must be
  disclosed and limits the first attempt to the explicitly approved small exposure.
- Documented permissioned solver financing, recovery reserve, and loss-allocation assumptions.
- Production-grade key custody and multisig roles.
- Per-route and aggregate exposure limits.
- Verified zero-shortfall feasibility enforcement, secured supplementary-funding escrow,
  conservative capacity buffers, and post-source capacity-loss recovery tests.
- Explicit acknowledgement that cross-chain smart contracts do not guarantee solver repayment.
- Live 1Click committed-quote and refund validation.
- Deployed code-hash/role/balance verification and successful non-broadcast simulation of every
  intended transaction against current mainnet state.
- Exact terms and worst-case recovery exposure presented to the owner.
- Explicit project-owner approval recorded in the decision log.

After the single approved attempt, the switch returns to `false` immediately whether the workflow
completes or enters recovery.
