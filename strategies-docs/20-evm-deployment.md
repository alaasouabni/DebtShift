# EVM deployment and startup attestation

## Purpose and safety boundary

This runbook deploys the seven DebtShift contracts around one already deployed and independently
validated Aave V3 source reserve and Morpho Blue destination market. It never deploys tokens,
protocol mocks, borrower positions, or liquidity. It does not authorize a refinance or enable
workflow writes.

Testnet deployment is permitted only after suitable public protocol deployments, funded deployment
and executor accounts, and the exact route configuration are available. If there is no official
Morpho testnet deployment, follow ADR-024: use a separately manifested DebtShift-operated deployment
compiled from a pinned canonical Morpho Blue source commit and label it protocol-compatible testnet
infrastructure. Never use `MockMorphoBlue` as public testnet evidence. Mainnet contract deployment is
a separate irreversible event: keep `MAINNET_EXECUTION_ENABLED=false` and obtain the explicit
deployment authorization required by the current acceptance plan. A real mainnet refinance still
requires a later exposure review, borrower signatures, and separate final authorization.

The exact canonical-source, funded-market deployment and attestation procedure is defined in
`21-public-testnet-morpho-deployment.md`. Complete its read-only readiness gate before using its
manifested market in this runbook.

## Accounts and inputs

Use a secret manager or process-level secret injection. Never place a private key, authenticated RPC
URL, or seed in Git, a manifest, shell history, CI output, or this document.

The deployment signer is the initial owner on both EVM chains and needs native gas on each chain.
The executor is a distinct operational address that needs native gas before readiness can pass a
non-zero balance floor. The initial deployment requires these values:

| Variable                                                               | Meaning                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `DEBTSHIFT_DEPLOYMENT_ENVIRONMENT`                                     | Exactly `testnet` or `mainnet`.                                          |
| `DEBTSHIFT_DEPLOYMENT_APPROVED`                                        | Exactly `true` only for the reviewed deployment window.                  |
| `MAINNET_EXECUTION_ENABLED`                                            | Omit or set `false`; deployment rejects `true`.                          |
| `MAINNET_CONTRACT_DEPLOYMENT_CONFIRMATION`                             | Required only for mainnet; exact guarded phrase documented below.        |
| `SOURCE_RPC_URL` / `DESTINATION_RPC_URL`                               | Reviewed RPC endpoints for the exact two chains.                         |
| `SOURCE_CHAIN_ID` / `DESTINATION_CHAIN_ID`                             | Positive, different EVM chain IDs.                                       |
| `SOURCE_FINALITY_CONFIRMATIONS` / `DESTINATION_FINALITY_CONFIRMATIONS` | Deployment confirmation depths.                                          |
| `LIVE_MARKET_CONFIG_PATH`                                              | Reviewed route file; defaults to the submission-critical route.          |
| `DEBTSHIFT_ROUTE_ID`                                                   | Stable human-readable route version.                                     |
| `TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH`                              | Testnet only: independently verified canonical Morpho manifest.          |
| `PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH`                               | Testnet only: byte-exact reviewed dependency bundle.                     |
| `DEPLOYER_PRIVATE_KEY`                                                 | Secret-injected 32-byte signer key.                                      |
| `DEPLOYMENT_OWNER`                                                     | Initial owner; must derive from the deployment key during configuration. |
| `EXECUTOR_ADDRESS`                                                     | Preselected operational executor, never a browser-supplied value.        |
| `DEPLOYMENT_MANIFEST_PATH`                                             | New, non-existing output path on durable operator storage.               |

For mainnet contract deployment only, the extra confirmation must be exactly:

```text
MAINNET_CONTRACT_DEPLOYMENT_CONFIRMATION=DEPLOY_DEBTSHIFT_MAINNET_CONTRACTS_WITH_WRITES_DISABLED
```

That phrase authorizes only contract deployment with disabled workflow writes. It does not authorize
liquidity funding, borrower approval, a 1Click deposit, a refinance, or any other financial action.

## Preflight

1. Work from the reviewed `main` commit with no untracked or modified files. The deployer records the
   full commit and rejects a dirty worktree.
2. Run `npm ci`, `npm run check`, `npm run check:evm`, `npm run check:evm-deployment`, and the
   environment-appropriate fork/live-route checks. Preserve results and the source commit.
3. Review the normalized route file field by field: chain deployments, tokens and decimals, Aave
   pool/data provider, Morpho singleton/market/oracle/IRM/LLTV, Chainlink feeds, policy, and cost
   bounds.
4. Read both RPC chain IDs directly and confirm they equal the configured values. Confirm the signer
   and executor native balances without printing credentials.
5. Confirm Aave returns the expected collateral-reserve aToken and debt-reserve variable-debt-token
   identities. Confirm Morpho returns the exact configured market parameters and market ID.
   On testnet, rerun `npm run check:public-testnet-route` and
   `npm run check:testnet-morpho-deployment`; the EVM deployer independently verifies the same
   Morpho manifest and dependency-file hash before broadcasting.
6. Select a brand-new durable `DEPLOYMENT_MANIFEST_PATH`. The deployer creates it exclusively before
   the first deployment transaction; an existing path causes a pre-broadcast failure.
7. Keep the application stopped or in `mainnet-readonly`. Do not enable queue consumption against an
   unverified deployment.

## Deployment

Set the values through the approved secret/runtime mechanism, then run:

```powershell
npm run deploy:evm
```

The command reruns the pinned Solidity gate and builds the domain/protocol packages before the
deployer starts. Before broadcasting it verifies the clean source commit, authorization flags, RPC
chain identities, Aave reserve identities, and Morpho market parameters. It deploys and configures:

- source `LiquidityVault`, `MigrationEscrow`, `AaveV3SourceLending`, and `SourceAdapter`;
- destination `MigrationEscrow`, `MorphoBlueTargetLending`, and `DestinationAdapter`;
- immutable cross-chain adapter and plan-domain bindings;
- owner, executor/operator, escrow, vault, and lending allowlists;
- paused/default-disabled workflow state.

The final version-1 manifest contains the source commit, normalized executable-route hash,
owner/executor, protocol bindings, token identities, every deployment transaction/block/code hash,
every configuration transaction/block, and `workflowWriteSwitchEnabled: false`. Testnet manifests
also contain the byte-exact public dependency hash already bound into the canonical Morpho manifest;
mainnet manifests require that testnet-only field to be `null`. Record the manifest path, file
SHA-256, source commit, command output, explorer links, and signer nonces in the release record.
Do not commit a real external deployment manifest unless the release policy explicitly makes those
public addresses and transaction records part of the published evidence.

## Independent readiness check

Use read-only RPC access and keep `MAINNET_EXECUTION_ENABLED=false`:

```powershell
npm run check:deployment
```

The check requires `DEPLOYMENT_MANIFEST_PATH`, both RPC URLs, and the same
`LIVE_MARKET_CONFIG_PATH`. Testnet also requires `TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH` and the
same `PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH`; readiness rejects any route ID or byte-exact hash
drift across the three manifests. Set `MINIMUM_VAULT_FREE_LIQUIDITY_UNITS` and
`MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI` to the approved release floors; leaving either blank verifies a
zero floor only and is not sufficient for funded execution.

The command fails unless canonical receipts and block hashes still match, all runtime bytecode hashes
match, all immutable Aave/Morpho/token/adapter/plan bindings match, roles and pause state match, the
onchain workflow switch is disabled, the vault has the required free balance, and the executor has
the required gas on both chains. Preserve the JSON report and observation time.

## Runtime mapping and startup

Mount the immutable manifest read-only into the worker and set `EVM_DEPLOYMENT_MANIFEST_PATH` to its
runtime path. Use the exact schema-normalized route as `LIVE_MARKET_CONFIG_JSON`. Map manifest fields
to runtime variables without manual address substitution:

| Runtime variable                      | Manifest field                                     |
| ------------------------------------- | -------------------------------------------------- |
| `SOURCE_CHAIN_ID`                     | `source.chainId`                                   |
| `SOURCE_DEPLOYMENT_BLOCK_NUMBER`      | `source.deploymentBlockNumber`                     |
| `SOURCE_VAULT_ADDRESS`                | `source.contracts.liquidityVault.address`          |
| `SOURCE_ESCROW_ADDRESS`               | `source.contracts.migrationEscrow.address`         |
| `SOURCE_LENDING_ADDRESS`              | `source.contracts.sourceLending.address`           |
| `SOURCE_ADAPTER_ADDRESS`              | `source.contracts.sourceAdapter.address`           |
| `DESTINATION_CHAIN_ID`                | `destination.chainId`                              |
| `DESTINATION_DEPLOYMENT_BLOCK_NUMBER` | `destination.deploymentBlockNumber`                |
| `DESTINATION_ESCROW_ADDRESS`          | `destination.contracts.migrationEscrow.address`    |
| `DESTINATION_LENDING_ADDRESS`         | `destination.contracts.targetLending.address`      |
| `DESTINATION_ADAPTER_ADDRESS`         | `destination.contracts.destinationAdapter.address` |
| `EXECUTOR_ADDRESS`                    | `executor`                                         |

The worker must also receive the exact manifest-bound token, protocol, route, and executor
configuration already required by the environment schema. Production funded `testnet` and
write-enabled `mainnet` reject a missing manifest path. Before creating a queue consumer, the worker
performs EVM, transport, and NEAR startup attestations; any failure terminates startup before a
durable financial command can be consumed. Testnet transport startup additionally checks both RPC
chain IDs, collateral token bytecode, non-zero executor gas on both chains, and non-zero pre-funded
source-refund and destination-delivery collateral. Exact required amounts are rechecked immediately
before each transfer. Testnet EVM startup also requires the Morpho dependency manifest's route ID
and dependency hash to match the DebtShift EVM manifest before it verifies the onchain market.

After startup, rerun the independent readiness check and confirm the worker health/log record reports
no attestation error. Do not treat process health alone as deployment evidence.

## Interrupted or failed deployment

Deployment is a sequence of ordinary onchain transactions and cannot be rolled back across chains.
If the process fails, times out, or loses RPC responses:

1. Stop. Do not rerun the same command or enable workflow writes.
2. Preserve the reserved manifest file, stdout/stderr, signer address, starting and ending nonce,
   RPC provider incident evidence, and every explorer-visible transaction.
3. If the manifest file is empty, treat it as an interrupted attempt. It deliberately blocks reuse
   of that path but does not prove that no transaction was mined.
4. Reconcile every signer transaction and receipt independently on both chains. Inventory all
   partially deployed contracts, owners, roles, pause states, and balances.
5. Mark partial contracts abandoned or produce a reviewed recovery plan. Never splice unverified
   records into a successful manifest and never assume a timeout means a transaction failed.
6. Use a new manifest path and explicit new deployment approval only after the incident record is
   complete. A later successful deployment does not erase the partial deployment evidence.

If readiness later fails, keep application writes disabled, stop worker queue consumption, preserve
the last known-good report, and diagnose reorg, RPC, code, role, balance, route, or configuration
drift. Changing the manifest to match unexpected chain state is not remediation.

## Evidence checklist

- clean source commit and green local/CI gates;
- reviewed route file and normalized route hash;
- deployment environment, chain IDs, finality depths, signer/owner/executor addresses;
- immutable manifest and file SHA-256;
- canonical deployment and configuration explorer links on both chains;
- runtime code hashes, roles, pause/default-disabled switch, and plan-domain bindings;
- Aave reserve and Morpho market/oracle/IRM/LLTV identities;
- vault free-liquidity and executor gas floors;
- successful independent readiness JSON and worker startup attestation;
- any interrupted/partial deployment incident record;
- proof that `MAINNET_EXECUTION_ENABLED` remained `false`.
