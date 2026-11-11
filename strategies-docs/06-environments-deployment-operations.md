# Environments, deployment, and operations

## Environment matrix

| Environment          | Purpose                                                                                   | Asset movement                                            |
| -------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `local`              | Deterministic development and E2E tests                                                   | Local test assets only                                    |
| `ci`                 | Automated isolated verification                                                           | Ephemeral test assets only                                |
| `testnet`            | NEAR registry testnet, supported EVM test deployments, and simulated transport            | Test assets only; no live 1Click                          |
| `mainnet-readonly`   | Position discovery, market reads, production 1Click token catalog, and `dry: true` quotes | Prohibited                                                |
| `mainnet-canary`     | One isolated production 1Click proof between team-controlled wallets                      | Strictly capped real transport only; no lending or solver |
| `mainnet-controlled` | Future audited rollout                                                                    | Deferred and disabled                                     |

## Local topology

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

- `local`, `ci`, and `testnet` require `MARKET_DATA_PROVIDER=SIMULATOR`.
- `mainnet-readonly` requires `MARKET_DATA_PROVIDER=LIVE_READ_ONLY`, an authenticated 1Click client,
  and a complete `LIVE_MARKET_CONFIG_JSON` registry.
- `mainnet-canary` requires `MARKET_DATA_PROVIDER=DISABLED`, preventing the canary process from
  reaching lending adapters or market routes.
- Production modes never fall back to simulator fixtures when configuration or an external provider
  is unavailable.

The live registry has no built-in production addresses. It supplies the Aave pool/data provider,
Morpho singleton/market/oracle, exact token identities and 1Click asset IDs, Chainlink feeds and age
limits, route policy, conservative gas bounds, and analytics risk-cost assumptions. Direct reads
must confirm chain, token metadata, market identity, and oracle identity before observations are
accepted.

Secrets are referenced through environment or a secret manager. `.env.example` contains names and safe examples only.

## 1Click network constraint

There is no public 1Click testnet stack. The environments therefore use the following explicit split:

- `local`, `ci`, and `testnet` use `DEBTSHIFT_SIMULATOR` for all funded transport state transitions.
- `mainnet-readonly` may call the production 1Click token endpoint and request only `dry: true` quotes.
- `mainnet-canary` may call `dry: false` only after a dry quote and immediately before explicit user confirmation. It permits one capped transport flow and cannot access lending or solver components.
- NEAR testnet is used for the DebtShift agreement and receipt registry only. A registry record may refer to simulated transport evidence, and that evidence must be labeled as simulated.
- General production refinancing remains in `mainnet-controlled` and requires the separate safety approval described below.

Configuration validation rejects invented testnet URLs, production funded mode outside `mainnet-canary` or `mainnet-controlled`, and any attempt to pair simulated evidence with provider identity `NEAR_INTENTS_1CLICK`.

### Canary safety policy

- Dedicated wallet with only the required asset and gas balance.
- Exactly one allowlisted origin/destination asset pair and chain pair.
- Fixed maximum input expressed in origin-token base units.
- Static team-controlled recipient and refund receiver.
- No server-held borrower key; the user wallet submits the deposit.
- Manual confirmation after the committed quote is displayed.
- One active canary at a time.
- Kill switch and default-disabled configuration.
- Independent origin and destination receipt verification.
- No route from canary code to EVM lending adapters, migration escrow, or liquidity vault.

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

## Operational metrics

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

The first release must include both configuration and code-level prevention of funded mainnet execution. Enabling `mainnet-controlled` later requires:

- Independent EVM contract audit.
- Resolved critical and high security findings.
- Documented solver financing and default terms.
- Production-grade key custody and multisig roles.
- Per-route and aggregate exposure limits.
- Audited zero-shortfall feasibility enforcement, secured supplementary-funding escrow, conservative
  capacity buffers, and post-source capacity-loss recovery drills.
- Explicit acknowledgement that cross-chain smart contracts do not guarantee solver repayment.
- Live 1Click committed-quote and refund validation.
- Canary limits and emergency response exercise.
- Explicit project-owner approval recorded in the decision log.
