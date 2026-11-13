# Public-testnet Morpho deployment and funded-market attestation

## Purpose and representation boundary

Morpho's official chain registry does not provide a public-testnet deployment for the submission
route. Public testnet therefore uses a DebtShift-operated Morpho Blue deployment compiled from an
exact, pinned upstream Morpho commit. This is real protocol-compatible public-testnet
infrastructure: it has real public-chain bytecode, transactions, Chainlink inputs, token balances,
market storage, liquidity shares, receipts, and explorer evidence. It must never be represented as
an official Morpho deployment or as production liquidity.

`MockMorphoBlue`, locally deployed test tokens, application-returned success, or an Anvil receipt
cannot satisfy this public-testnet gate. Those remain valid only for isolated unit, integration,
recovery, and hosted-sandbox tests. The public route must use real public-testnet assets and real
Chainlink-compatible feeds selected from current primary-source documentation.

This runbook creates only the destination protocol dependency and one funded market. It does not
deploy the DebtShift adapters, create an Aave borrower position, simulate the unavailable 1Click
boundary, start a refinancing workflow, or authorize mainnet.

## Reproducible source boundary

The isolated project is `contracts/morpho-testnet`. It deliberately does not change the Solidity
version or compiler settings of the DebtShift contracts under `contracts/evm`.

| Property                   | Pinned value                                                |
| -------------------------- | ----------------------------------------------------------- |
| Upstream repository        | `https://github.com/morpho-org/morpho-blue`                 |
| Upstream commit            | `339a885801972740eb27f51da110a4675b839d42`                  |
| Canonical contracts        | `Morpho` and `AdaptiveCurveIrm`                             |
| Compiler                   | Solidity `0.8.19`                                           |
| EVM target                 | `paris`                                                     |
| Optimizer                  | enabled, `999999` runs                                      |
| Compilation pipeline       | `via_ir=true`                                               |
| Bytecode metadata hash     | disabled                                                    |
| Vendored provenance record | `contracts/morpho-testnet/vendor/morpho-blue/UPSTREAM.json` |
| Verification command       | `node scripts/check-vendored-morpho.mjs`                    |

The vendored subset contains the exact upstream Git blobs for Morpho core, AdaptiveCurveIrm, and
their transitive in-repository interfaces/libraries. `UPSTREAM.json` records every Git blob ID.
The verification command recomputes every local Git blob ID and rejects missing, additional, or
changed files. The GPL-2.0-or-later and MIT license files remain beside the source and are copied
into the runtime image with the corresponding source.

The build also contains `DebtShiftChainlinkOracle`, a testnet-only two-feed oracle. It:

- returns the loan-token-base-units per collateral-token-base-unit scale required by Morpho (`1e36`);
- derives its scale from both token and feed decimals and rejects unsupported scale configurations;
- rejects non-positive, incomplete, future-dated, or stale Chainlink rounds;
- optionally rejects an L2 sequencer outage and the configured recovery grace period;
- exposes immutable feed, maximum-age, and sequencer settings for startup attestation.

Production mainnet does not deploy or select this oracle. It uses the oracle already bound to the
allowlisted established Morpho market.

## Recommended testnet topology

Use the official Aave V3 Sepolia deployment as the source and a different public EVM testnet for
the DebtShift-operated Morpho destination so the workflow still crosses chain identities. Base
Sepolia is the current candidate because it has canonical WETH, Circle test USDC, and Chainlink
feeds, but it is not frozen here: addresses, feed availability, faucet behavior, and current
deployment support are time-sensitive and must be revalidated from official primary sources before
any transaction.

Do not copy an address from an old blog, chat, or remembered value. Record the official source URL,
chain ID, observed block, code hash, token decimals, feed decimals, latest round, heartbeat, and
sequencer feed in the deployment evidence packet.

## Irreversible-action boundary

The deployment command broadcasts public-testnet transactions and transfers real test tokens into
Morpho. It may run only during an explicitly reviewed public-testnet deployment window. The command
requires all of these independent gates:

- a clean Git worktree and full local source commit;
- `DEBTSHIFT_DEPLOYMENT_ENVIRONMENT=testnet`;
- `DEBTSHIFT_TESTNET_MORPHO_DEPLOYMENT_APPROVED=true`;
- `MAINNET_EXECUTION_ENABLED=false`;
- a new manifest path opened with exclusive creation before the first broadcast;
- an RPC whose observed chain ID matches the configured destination chain;
- deployed code for both tokens, both price feeds, and the optional sequencer feed;
- enough deployer native gas and enough real testnet loan tokens for the exact seed amount.

Never set the approval variable in a shared committed environment file. Inject it only into the
reviewed deployment process and remove it afterward.

## Required inputs

| Variable                                        | Meaning                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `DEBTSHIFT_DEPLOYMENT_ENVIRONMENT`              | Exactly `testnet`.                                                        |
| `DEBTSHIFT_TESTNET_MORPHO_DEPLOYMENT_APPROVED`  | Exactly `true` for the reviewed deployment window only.                   |
| `MAINNET_EXECUTION_ENABLED`                     | Omit or set `false`; the command rejects `true`.                          |
| `DESTINATION_RPC_URL` / `DESTINATION_CHAIN_ID`  | Reviewed public-testnet endpoint and exact chain ID.                      |
| `DESTINATION_FINALITY_CONFIRMATIONS`            | Positive receipt confirmation count; defaults to `1`.                     |
| `DEPLOYER_PRIVATE_KEY`                          | Secret-injected funded testnet deployment key.                            |
| `MORPHO_OWNER`                                  | Final Morpho owner; defaults to the deployer.                             |
| `DESTINATION_MORPHO_LIQUIDITY_OWNER`            | Owner of seed supply shares; defaults to `MORPHO_OWNER`.                  |
| `DESTINATION_COLLATERAL_TOKEN_ADDRESS`          | Real destination public-testnet collateral token.                         |
| `DESTINATION_DEBT_TOKEN_ADDRESS`                | Real destination public-testnet loan token to seed.                       |
| `DESTINATION_COLLATERAL_CHAINLINK_FEED_ADDRESS` | Collateral/USD or otherwise compatible base feed.                         |
| `DESTINATION_DEBT_CHAINLINK_FEED_ADDRESS`       | Loan/USD or otherwise compatible quote feed.                              |
| `DESTINATION_SEQUENCER_UPTIME_FEED_ADDRESS`     | Required for an L2 destination; omit only for an L1.                      |
| `DESTINATION_ORACLE_MAX_AGE_SECONDS`            | Positive maximum age accepted by the onchain oracle.                      |
| `DESTINATION_SEQUENCER_GRACE_PERIOD_SECONDS`    | Positive L2 recovery grace period; omit for an L1.                        |
| `DESTINATION_MORPHO_LLTV`                       | Reviewed WAD-scaled LLTV strictly between zero and `1e18`.                |
| `DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS`       | Exact positive loan-token base units permanently supplied for validation. |
| `MINIMUM_DEPLOYER_NATIVE_BALANCE_WEI`           | Optional preflight native gas floor; defaults to `1`.                     |
| `MORPHO_DEPLOYMENT_MANIFEST_PATH`               | New durable output path; defaults under `deployment/manifests`.           |

The manifest never contains the RPC URL or private key.

## Preflight checklist

1. Verify the candidate destination chain and every address from current official documentation.
2. Read bytecode, token symbols/decimals, feed decimals, latest round values, round timestamps, and
   the L2 sequencer status directly from the configured RPC.
3. Confirm both tokens have standard exact-transfer ERC-20 behavior suitable for Morpho; do not use
   fee-on-transfer, rebasing, callback, or permissionlessly burnable assets.
4. Review the oracle pair direction. The collateral feed is the base side and the loan feed is the
   quote side. Confirm the expected Morpho-scaled price independently.
5. Select an LLTV whose liquidation margin remains safe under testnet oracle volatility. The
   deployment script rejects zero or `>= 1e18` but cannot replace risk review.
6. Confirm the seed amount is large enough for the signed demonstration borrow plus interest,
   solver fee, and safety buffer. It is a real test-token transfer, not a UI number.
7. Fund the deployer with destination gas and the exact loan-token amount. Keep the deployer,
   operational executor, and final owner distinct where the account model permits it.
8. Run all local checks from the exact clean commit intended for deployment.

## Local validation before broadcast

```text
npm run check:morpho-testnet
npm run check:evm-deployment
npm run check
```

`check:morpho-testnet` validates all pinned upstream blobs, runs Foundry formatting, forces a clean
build, and executes the oracle tests. The deployment integration suite starts Anvil, deploys the
exact canonical Morpho and IRM artifacts, deploys the testnet oracle, creates a real market, seeds
ERC-20 liquidity through Morpho, transfers the owner, verifies every receipt/input/code hash and
runtime binding, and proves tamper rejection. Local mock tokens/feeds used by that integration suite
are test fixtures only and are not accepted as public evidence.

## Deployment sequence

Run only after the irreversible-action review:

```text
npm run deploy:testnet-morpho
```

The guarded deployer performs this exact sequence:

1. deploy canonical `Morpho` with the deployer as temporary owner;
2. deploy canonical `AdaptiveCurveIrm` bound immutably to that Morpho singleton;
3. deploy `DebtShiftChainlinkOracle` bound to the exact tokens, feeds, age, and sequencer policy;
4. enable the IRM and LLTV;
5. create the exact derived market ID;
6. clear any pre-existing deployer allowance;
7. approve only the exact seed amount;
8. supply the real testnet loan token into Morpho for the configured liquidity owner;
9. revoke the token allowance to zero;
10. transfer Morpho ownership if the final owner differs from the deployer;
11. read back market totals, supply shares, Morpho token balance, code hashes, and all receipts;
12. write the immutable version-1 manifest with `workflowWriteSwitchEnabled=false`.

If any transaction fails after an earlier broadcast, do not overwrite the reserved manifest or
blindly rerun. Preserve the empty/partial output path, collect every transaction hash from the
signer/explorer, inspect current ownership/market state, and reconcile manually. A new attempt needs
a new path and explicit review.

## Manifest evidence

The generated manifest binds:

- the DebtShift source commit and exact upstream commit/source-manifest hash;
- compiler, EVM, IR, optimizer, and metadata settings;
- chain, deployer, final owner, and minimum deployment block;
- canonical creation-code hashes, full deployment-input hashes, contract addresses, receipts,
  canonical blocks, and runtime-code hashes for Morpho, IRM, and oracle;
- token/feed addresses, decimals, and runtime-code hashes;
- oracle age and sequencer policy;
- exact market parameters and derived market ID;
- seed-liquidity owner, assets, shares, initial total supply, and available liquidity;
- every configuration/supply/allowance/ownership transaction with sender, target, calldata hash,
  receipt block, and block hash;
- the disabled workflow-write switch.

## Independent readiness and startup

The read-only command requires no private key:

```text
npm run check:testnet-morpho-deployment
```

Set `MORPHO_DEPLOYMENT_MANIFEST_PATH`, `DESTINATION_RPC_URL`, and optionally a positive
`MINIMUM_MORPHO_AVAILABLE_LIQUIDITY_UNITS`. The checker independently verifies:

- local pinned-source provenance and creation bytecode;
- the chain ID and every canonical deployment/configuration receipt;
- exact creation calldata, transaction sender/target/calldata hashes, and runtime code hashes;
- token/feed code and decimals;
- Morpho owner, enabled IRM/LLTV, market parameters, market ID, and initialized state;
- IRM and oracle immutable bindings;
- current oracle price/freshness/sequencer state;
- zero remaining deployer token allowance;
- preserved seed supply shares and the configured current available-liquidity floor.

After deployment, create and commit the exact public-testnet route configuration using only the
manifested addresses and current official Aave source data. Then deploy the seven DebtShift EVM
contracts with `20-evm-deployment.md`. The production worker in `testnet` mode requires both:

- `EVM_DEPLOYMENT_MANIFEST_PATH`; and
- `TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH`.

Before consuming the first queue item it cross-checks both manifests against each other, the route,
destination chain, deployment ordering, Morpho/market/token/oracle/IRM/LLTV/feed/sequencer bindings,
onchain provenance, current oracle validity, seed position, allowance revocation, and nonzero
available liquidity.

## Evidence label for judges and operators

Use this exact distinction in the UI, submission, and runbook:

- **Public testnet protocol evidence:** official Aave V3 source plus a DebtShift-operated,
  canonical-source Morpho Blue-compatible destination deployment.
- **Transport evidence:** an explicitly labeled DebtShift testnet transport adapter because official
  NEAR Intents/1Click has no public testnet deployment.
- **Production evidence:** pinned official Aave/Morpho mainnet fork tests, live read-only route
  verification, official 1Click catalog/dry quote, and later write-disabled production deployment.

Never describe the DebtShift-operated singleton as an official Morpho testnet and never describe the
simulated transport boundary as a 1Click testnet transaction.
