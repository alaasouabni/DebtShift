# Guarded public-testnet source-vault funding

## Purpose

DebtShift cannot close an Aave position unless the permissioned source `LiquidityVault` already
contains the exact reviewed debt asset. This runbook defines the only supported public-testnet
funding path. It binds one Ethereum Sepolia funder, one deployed vault, one token, one amount, and
three canonical transactions to the already verified route and deployment manifests.

The operation is not a faucet, token mint, solver marketplace, or workflow execution. It transfers
test USDC already owned by the separate vault-funder address into the DebtShift vault while the
vault's workflow switch remains disabled. It never enables mainnet execution and it has no mainnet
mode.

## Position in the release sequence

Run this procedure only after all of the following are true:

1. `npm run check:public-testnet-funding` reports `PUBLIC_TESTNET_FUNDING_READY` for the exact four
   distinct EVM roles and three distinct NEAR roles.
2. `npm run check:public-testnet-route` passes for the byte-exact dependency file.
3. The canonical-source Morpho market has been deployed and independently verified under
   `21-public-testnet-morpho-deployment.md`.
4. The executable testnet route has been generated from that Morpho manifest, reviewed, and frozen.
5. The seven DebtShift EVM contracts have been deployed with workflow writes disabled and
   `npm run check:deployment` passes with a zero vault-liquidity floor.
6. The exact funding amount, gas ceiling, funder, vault, token, RPC endpoints, source commit, and
   four input files have received operator review.

Funding happens before worker startup and before any borrower plan is accepted. It does not replace
the later deployment, transport, registry, or end-to-end readiness gates.

## Required separation

The following addresses must remain distinct:

- public-testnet Aave borrower;
- two-chain EVM deployer and initial owner;
- source-vault funder;
- workflow executor.

The funding key must derive exactly the reviewed `PUBLIC_TESTNET_VAULT_FUNDER_ADDRESS`. It must not
derive the borrower, deployment owner, or executor. The command checks the deployment owner and
executor against the immutable EVM manifest before loading the key.

## Immutable inputs

The command requires four independently meaningful files:

| Input                                     | Binding                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `LIVE_MARKET_CONFIG_PATH`                 | Schema-normalized executable route and route-configuration hash.                |
| `PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH`  | Byte-exact reviewed Ethereum/Base Sepolia dependency hash.                      |
| `TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH` | Canonical Morpho source, market, oracle, seed, and revoked allowance.           |
| `DEPLOYMENT_MANIFEST_PATH`                | Seven DebtShift contracts, roles, code hashes, receipts, and disabled switches. |

The funder rejects any disagreement in route ID, source/destination chain, token, Aave deployment,
Morpho singleton, market, oracle, dependency hash, normalized route hash, vault address, owner,
executor, or source commit. The DebtShift deployment manifest is also hashed byte-for-byte and that
hash is written into the funding manifest.

Do not edit a manifest to make a failed check pass. Reconcile the actual deployment or abandon the
attempt.

## Funding command inputs

All amounts are unsigned base-10 integers in smallest units. There are no silent financial
defaults.

| Variable                                   | Requirement                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `MAINNET_EXECUTION_ENABLED`                | Omit or set exactly `false`; every other value is rejected.                             |
| `DEBTSHIFT_DEPLOYMENT_ENVIRONMENT`         | Exactly `testnet`.                                                                      |
| `DEBTSHIFT_TESTNET_VAULT_FUNDING_APPROVED` | Exactly `true` for this reviewed funding window only.                                   |
| `SOURCE_RPC_URL` / `DESTINATION_RPC_URL`   | Reviewed endpoints for the manifested chains.                                           |
| `SOURCE_FINALITY_CONFIRMATIONS`            | Explicit integer from 1 through 1000 used for all three receipts.                       |
| `LIVE_MARKET_CONFIG_PATH`                  | Reviewed executable testnet route.                                                      |
| `PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH`   | Exact frozen dependency file; the reviewed default is used only when omitted.           |
| `TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH`  | Verified Morpho dependency manifest.                                                    |
| `DEPLOYMENT_MANIFEST_PATH`                 | Verified DebtShift EVM manifest.                                                        |
| `VAULT_FUNDING_MANIFEST_PATH`              | New durable output path; it must not already exist.                                     |
| `PUBLIC_TESTNET_BORROWER_ADDRESS`          | Reviewed Aave borrower.                                                                 |
| `PUBLIC_TESTNET_DEPLOYER_ADDRESS`          | Must equal the manifested deployment owner.                                             |
| `PUBLIC_TESTNET_VAULT_FUNDER_ADDRESS`      | Must derive from the injected funding key.                                              |
| `PUBLIC_TESTNET_EXECUTOR_ADDRESS`          | Must equal the manifested executor.                                                     |
| `MINIMUM_VAULT_FUNDER_NATIVE_BALANCE_WEI`  | Positive finalized source-gas floor.                                                    |
| `MINIMUM_VAULT_FUNDING_UNITS`              | Positive reviewed source-vault funding floor.                                           |
| `VAULT_FUNDING_AMOUNT_UNITS`               | Exact transfer amount; it must equal the reviewed funding floor.                        |
| `DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS`  | Positive current Morpho-liquidity floor for the pre-broadcast dependency check.         |
| `MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI`      | Positive gas floor required on both manifested chains.                                  |
| `VAULT_FUNDER_PRIVATE_KEY`                 | Secret-injected 32-byte key; never store it in Git, a manifest, logs, or shell history. |

The source commit must be clean and must equal the EVM deployment manifest's `sourceCommit`. Keep
external manifests and the output on controlled durable operator storage if committing them would
change that source commit.

## Pre-broadcast behavior

Run:

```powershell
npm run fund:testnet-vault
```

Before the private key is parsed, the command:

1. checks the environment and one-operation approval flag;
2. rejects a dirty Git worktree and binds the full current commit;
3. parses and cross-checks every manifest, route, dependency, role, token, and hash;
4. runs the independent canonical Morpho deployment verifier;
5. runs the complete seven-contract DebtShift deployment verifier with workflow writes disabled;
6. reads one finalized source block and checks the public funder gas and debt-token balances;
7. requires the exact funding amount to equal the separately reviewed minimum.

Only after these read-only checks pass does it parse the funding key, verify the derived address,
and exclusively reserve `VAULT_FUNDING_MANIFEST_PATH`. An existing path fails before broadcast.

## Exact transaction sequence

The command simulates, broadcasts, waits for the configured confirmations, and verifies exactly:

1. debt token `approve(vault, amount)`;
2. vault `deposit(debtToken, amount)`;
3. debt token `approve(vault, 0)`.

Before the first transaction it requires:

- deployed token and vault bytecode;
- the exact debt token allowlisted in the vault;
- zero funder-to-vault allowance;
- zero undrawn reservations;
- zero locked recovery reserves;
- enough funder token balance.

After deposit it requires an exact amount decrease in the funder balance and exact amount increases
in both the vault token balance and free liquidity. After cleanup it requires zero allowance and
still-zero reservation balances. Fee-on-transfer or otherwise non-exact tokens fail the delta
check.

If an error occurs after an allowance becomes visible, the implementation attempts a confirmed
`approve(vault, 0)` emergency cleanup and proves the allowance is zero. If cleanup cannot be proven,
the command raises a combined financial-reconciliation error. An RPC timeout is never treated as
proof that a transaction failed.

## Funding manifest

The version-1 manifest records:

- environment, timestamp, clean source commit, route ID, normalized route hash, byte-exact
  dependency hash, and byte-exact EVM manifest hash;
- chain, confirmation depth, funder, vault, asset, and exact amount;
- canonical before and after blocks and balances;
- funder balance, vault balance, vault free liquidity, allowance, reservations, and recovery reserve;
- the approval, deposit, and cleanup transaction hashes;
- transaction-input hashes, senders, targets, nonces, block hashes/numbers, and gas used;
- `workflowWriteSwitchEnabled: false`.

The schema requires three unique transaction hashes, canonical action ordering, exact balance
deltas, exact sender/target identities, and zero pre/post allowance and reservations. The file is
written only after the complete successful sequence. If the process is interrupted, the
exclusively reserved path may remain empty and must be treated as an incident marker.

## Independent readiness verification

Remove the funding key and one-operation approval flag from the environment. Keep mainnet execution
disabled, provide the same public files, identities, amounts, confirmations, RPC endpoints, Morpho
liquidity floor, and executor gas floor, then run:

```powershell
npm run check:testnet-vault-funding
```

This command has no wallet client and accepts no private key. It independently:

- re-hashes and cross-checks the route, dependency, EVM, Morpho, and funding files;
- verifies every funding transaction's calldata, sender, target, nonce, receipt, gas, canonical
  block, and stored input hash;
- reconstructs historical balances at the manifested before/after blocks;
- verifies the funding transactions are finalized and the current allowance is zero;
- reruns canonical Morpho readiness with the explicit liquidity floor;
- reruns the full DebtShift deployment verifier with current vault-liquidity and executor-gas floors.

Only `TESTNET_SOURCE_VAULT_FUNDING_READY` with exit code zero is funding-readiness evidence. Preserve
the JSON output, manifest hashes, observation time, and explorer links.

Mount the verified funding manifest read-only into the worker and set
`TESTNET_VAULT_FUNDING_MANIFEST_PATH` to that runtime path. Funded `testnet` configuration rejects a
missing path. Before creating its queue consumer, the worker repeats the EVM-manifest hash,
route/dependency/source/vault/token bindings, canonical transaction and historical-balance checks,
finality check, and current zero-allowance check.

## Interrupted or ambiguous attempts

Funding is a sequence of ordinary transactions and cannot be rolled back as a unit. If any command
times out, exits unexpectedly, leaves an empty output file, or reports unproven cleanup:

1. Stop the worker and keep workflow writes disabled.
2. Do not delete or reuse the reserved manifest path.
3. Preserve stdout/stderr, the funder address, starting nonce, intended amount, input hashes, RPC
   incident information, and every explorer-visible transaction.
4. Independently inspect the current token allowance, funder balance, vault balance, free liquidity,
   reservations, and recovery reserves at finalized blocks.
5. If allowance is non-zero, revoke it through a separately reviewed recovery action and preserve
   its receipt. Never increase the allowance to make a retry convenient.
6. Decide whether the exact deposit already completed. Do not fund the vault twice.
7. Use a new output path and a new explicit approval only after reconciliation is complete.

An empty manifest is not proof that no transaction was mined. A successful cleanup does not erase
an interrupted deposit. Unexpected excess liquidity is not silently accepted as evidence for the
reviewed attempt.

## Acceptance evidence

- clean source commit and green local/CI gates;
- public-testnet inventory and route reports immediately preceding the operation;
- all four input files and their exact hashes;
- reviewed public roles, amount, gas/liquidity floors, and confirmation depth;
- three canonical explorer receipts with expected calldata and senders/targets;
- immutable non-empty funding manifest;
- independent `TESTNET_SOURCE_VAULT_FUNDING_READY` report;
- zero current token allowance and zero active/recovery reservations;
- proof that workflow writes and `MAINNET_EXECUTION_ENABLED` remained disabled;
- any incident/reconciliation record from a partial attempt.

This evidence authorizes only the funded public-testnet vault. It does not authorize borrower
execution, a 1Click deposit, a NEAR registry write, a mainnet deployment, or movement of real funds.
