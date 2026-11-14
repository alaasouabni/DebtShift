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
- exposes immutable per-feed maximum ages and sequencer settings for startup attestation. Separate
  limits prevent a slow quote-feed heartbeat from weakening the collateral-feed freshness bound.

Production mainnet does not deploy or select this oracle. It uses the oracle already bound to the
allowlisted established Morpho market.

## Frozen dependency candidate

The checked-in, write-disabled dependency candidate is
`config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json`.
It is a deployment input, not an executable route and not proof that any contract has been deployed.
`npm run check:public-testnet-route` revalidates its primary-source provenance and finalized onchain
state without a key or write transaction.

| Role                          | Network / reviewed value                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                        | Official Aave V3 on Ethereum Sepolia, chain `11155111`                                                                                                    |
| Aave address-book pin         | Commit `b8c801a413c4b934afaf7976d2ddc5fbada6dce6`, module SHA-256 `a9f66b5f399a2152c143516ea5d93ca2376f0f98e6dd9737913fa1e32414fe75`                      |
| Source pool / data provider   | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` / `0x3e9708d80f7B3e43118013075F7e95CE3AB31F31`                                                               |
| Source WETH collateral        | `0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c`; aToken `0x5b071b590a59395fE4025A0Ccc1FcC931AAc1830`                                                         |
| Source USDC debt              | Aave test USDC `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`; variable debt `0x36B5dE936eF1710E1d22EabE5231b28581a92ECc`                                   |
| Source ETH/USD planning feed  | Official Chainlink Sepolia `0x694AA1769357215DE4FAC081bf1f309aDC325306`; published heartbeat `3600s`; enforced maximum age `10800s`                       |
| Source USDC/USD planning feed | Official Chainlink Sepolia `0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E`; published heartbeat `86400s`; enforced maximum age `90000s`                      |
| Destination                   | Base Sepolia, chain `84532`; DebtShift-operated canonical-source Morpho                                                                                   |
| Destination WETH              | Base WETH9 predeploy `0x4200000000000000000000000000000000000006`                                                                                         |
| Destination USDC              | Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`                                                                                             |
| Collateral feed               | Chainlink ETH/USD `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`; published heartbeat `1200s`; enforced maximum age `3600s`                                 |
| Loan feed                     | Chainlink USDC/USD `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165`; published heartbeat `86400s`; enforced maximum age `90000s`                              |
| Sequencer policy              | `null`, grace `0`: Chainlink's current sequencer-feed directory does not list Base Sepolia. Revalidation fails if that changes and requires a new review. |
| Market parameters             | LLTV `800000000000000000` (`80%`); minimum seed liquidity `10000000` USDC base units (`10` test USDC)                                                     |

The source Aave USDC and destination Circle USDC are different testnet contracts. The route labels
them as chain-specific, no-value test representations of the same economic debt unit; it never
claims a native token bridge or identical issuer at both ends. The unavailable 1Click boundary
remains explicitly simulated, while its source escrow and destination delivery must be real
public-chain token transactions.

Primary sources are pinned or re-read from Aave's official address-book API, Base contract docs,
Circle's USDC address page, and Chainlink's official Ethereum/Base Sepolia feed and sequencer
directories. The Aave address-book `ORACLE` entries are Aave price-source contracts, not
AggregatorV3 planning feeds; the executable route therefore uses the separately pinned official
Chainlink Sepolia proxies above. Do not replace an address from a blog, chat, explorer search, or
remembered value. Every deployment window must rerun the validator and preserve its blocks, hashes,
code hashes, metadata, rounds, and response hashes.

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
- a byte-exact route dependency file whose Keccak-256 hash is written into the deployment manifest.

Never set the approval variable in a shared committed environment file. Inject it only into the
reviewed deployment process and remove it afterward.

## Required inputs

| Variable                                       | Meaning                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `DEBTSHIFT_DEPLOYMENT_ENVIRONMENT`             | Exactly `testnet`.                                                                           |
| `DEBTSHIFT_TESTNET_MORPHO_DEPLOYMENT_APPROVED` | Exactly `true` for the reviewed deployment window only.                                      |
| `MAINNET_EXECUTION_ENABLED`                    | Omit or set `false`; the command rejects `true`.                                             |
| `PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH`       | Optional reviewed dependency file; defaults to the single checked-in P0 candidate.           |
| `DESTINATION_RPC_URL`                          | Reviewed Base Sepolia endpoint. Chain ID comes from the dependency file and is checked live. |
| `DESTINATION_FINALITY_CONFIRMATIONS`           | Positive receipt confirmation count; defaults to `1`.                                        |
| `DEPLOYER_PRIVATE_KEY`                         | Secret-injected funded testnet deployment key.                                               |
| `MORPHO_OWNER`                                 | Final Morpho owner; defaults to the deployer.                                                |
| `DESTINATION_MORPHO_LIQUIDITY_OWNER`           | Owner of seed supply shares; defaults to `MORPHO_OWNER`.                                     |
| `DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS`      | Exact loan-token base units supplied; must meet the dependency file's reviewed minimum.      |
| `MINIMUM_DEPLOYER_NATIVE_BALANCE_WEI`          | Optional preflight native gas floor; defaults to `1`.                                        |
| `MORPHO_DEPLOYMENT_MANIFEST_PATH`              | New durable output path; defaults under `deployment/manifests`.                              |

Tokens, feeds, independent freshness limits, null sequencer policy, chain ID, LLTV, and minimum
seed amount come only from the reviewed dependency file. The deployer hashes that exact file and
binds its route ID and hash into the manifest; operator environment variables cannot silently
substitute those security parameters.

The manifest never contains the RPC URL or private key.

## Preflight checklist

1. Run `npm run check:public-testnet-funding` with the reviewed public identities and release-sized
   floors. Require both deployer gas checks and the exact Base Sepolia Circle USDC seed-balance
   check to pass before injecting `DEPLOYER_PRIVATE_KEY`.
2. Run `MAINNET_EXECUTION_ENABLED=false npm run check:public-testnet-route` and preserve the complete
   JSON observation. Any failure requires review; do not override it with environment variables.
3. Read bytecode, token symbols/decimals, feed decimals, latest round values, round timestamps, and
   the L2 sequencer status directly from the configured RPC.
4. Confirm both tokens have standard exact-transfer ERC-20 behavior suitable for Morpho; do not use
   fee-on-transfer, rebasing, callback, or permissionlessly burnable assets.
5. Review the oracle pair direction. The collateral feed is the base side and the loan feed is the
   quote side. Confirm the expected Morpho-scaled price independently.
6. Select an LLTV whose liquidation margin remains safe under testnet oracle volatility. The
   deployment script rejects zero or `>= 1e18` but cannot replace risk review.
7. Confirm the seed amount is large enough for the signed demonstration borrow plus interest,
   solver fee, and safety buffer. It is a real test-token transfer, not a UI number.
8. Fund the deployer with destination gas and the exact loan-token amount. Keep the deployer,
   operational executor, and final owner distinct where the account model permits it.
9. Run all local checks from the exact clean commit intended for deployment.

## Local validation before broadcast

```text
npm run check:morpho-testnet
npm run check:evm-deployment
npm run check:public-testnet-route
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
3. deploy `DebtShiftChainlinkOracle` bound to the exact tokens, feeds, independent ages, and
   sequencer policy;
4. enable the IRM and LLTV;
5. create the exact derived market ID;
6. clear any pre-existing deployer allowance;
7. approve only the exact seed amount;
8. supply the real testnet loan token into Morpho for the configured liquidity owner;
9. revoke the token allowance to zero;
10. transfer Morpho ownership if the final owner differs from the deployer;
11. read back market totals, supply shares, Morpho token balance, code hashes, and all receipts;
12. write the immutable version-1 manifest with the exact route dependency hash and
    `workflowWriteSwitchEnabled=false`.

If any transaction fails after an earlier broadcast, do not overwrite the reserved manifest or
blindly rerun. Preserve the empty/partial output path, collect every transaction hash from the
signer/explorer, inspect current ownership/market state, and reconcile manually. A new attempt needs
a new path and explicit review.

## Manifest evidence

The generated manifest binds:

- the DebtShift source commit, route ID, byte-exact route dependency hash, and exact upstream
  commit/source-manifest hash;
- compiler, EVM, IR, optimizer, and metadata settings;
- chain, deployer, final owner, and minimum deployment block;
- canonical creation-code hashes, full deployment-input hashes, contract addresses, receipts,
  canonical blocks, and runtime-code hashes for Morpho, IRM, and oracle;
- token/feed addresses, decimals, and runtime-code hashes;
- independent collateral/loan oracle ages and the sequencer policy;
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

Set `MORPHO_DEPLOYMENT_MANIFEST_PATH`, `DESTINATION_RPC_URL`, optionally
`PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH`, and optionally a positive
`MINIMUM_MORPHO_AVAILABLE_LIQUIDITY_UNITS`. The checker independently verifies:

- local pinned-source provenance and creation bytecode;
- the exact dependency-file route ID and Keccak-256 hash;
- the chain ID and every canonical deployment/configuration receipt;
- exact creation calldata, transaction sender/target/calldata hashes, and runtime code hashes;
- token/feed code and decimals;
- Morpho owner, enabled IRM/LLTV, market parameters, market ID, and initialized state;
- IRM and oracle immutable bindings;
- current oracle price/freshness/sequencer state;
- zero remaining deployer token allowance;
- preserved seed supply shares and the configured current available-liquidity floor.

### Deterministic executable route generation

After deployment, generate the executable public-testnet route rather than assembling it manually:

```text
MORPHO_DEPLOYMENT_MANIFEST_PATH=<new Morpho manifest> npm run generate:public-testnet-route
```

The generator requires clean tracked source files and a Morpho manifest whose `sourceCommit` equals
the current commit. It opens the output path exclusively, defaults to
`config/routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.v1.json`, and fails closed on any
route ID, dependency hash, chain, token, decimals, feed, independent maximum age, sequencer policy,
market, oracle, IRM, LLTV, or minimum-liquidity mismatch.

Only risk/analytics policy comes from the separately reviewed, write-disabled file
`config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.policy.v1.json`. The
generated testnet route deliberately omits 1Click `providerAssetId` values because no official
testnet provider catalog exists and the simulated boundary does not consume them. Mainnet-readonly
and mainnet startup continue to require real provider asset IDs for all four route assets.

Review and commit the generated route, then deploy the seven DebtShift EVM contracts with
`20-evm-deployment.md`. After the write-disabled EVM deployment is independently verified, fund its
source vault only through `23-testnet-vault-funding.md` and require
`npm run check:testnet-vault-funding` to pass before worker startup. The production worker in
`testnet` mode requires all three:

- `EVM_DEPLOYMENT_MANIFEST_PATH`;
- `TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH`; and
- `TESTNET_VAULT_FUNDING_MANIFEST_PATH`.

Before consuming the first queue item it cross-checks the deployment, dependency, and funding
manifests against each other, the route,
destination chain, deployment ordering, Morpho/market/token/oracle/IRM/LLTV/feed/sequencer bindings,
onchain provenance, current oracle validity, seed position, allowance revocation, and nonzero
available liquidity.

The DebtShift EVM deployer also re-reads this dependency file and Morpho manifest before any
broadcast. It verifies their route ID, byte-exact dependency hash, chain IDs, assets, feeds,
freshness policy, LLTV, and live market, then writes the same dependency hash into its own manifest.
The independent readiness check and worker startup reject any disagreement between all three
bindings before workflow consumption.

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
