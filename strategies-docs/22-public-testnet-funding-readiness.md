# Public-testnet funding and account readiness

## Purpose

This is the final credential-free gate before any public-testnet deployment key is loaded. It reads
finalized Ethereum Sepolia and Base Sepolia state plus final NEAR testnet account state and produces
one complete inventory of the funds and identities required by the submission-critical route.

The command never accepts a private key, never broadcasts a transaction, never enables workflow
writes, and never prints an RPC URL or deployment public key. It exits successfully only when every
requirement passes. A partial success is `PUBLIC_TESTNET_FUNDING_NOT_READY`, not deployment
authorization.

## What the gate proves

The assessment is deterministic and checks all of these prerequisites without short-circuiting:

1. The borrower has the reviewed minimum Ethereum Sepolia Aave WETH collateral and variable USDC
   debt at one finalized block, plus enough source gas to sign the required authorization.
2. The deployer has the reviewed native-gas floor on both EVM networks.
3. The deployer owns enough Base Sepolia Circle test USDC for the exact Morpho seed-liquidity
   amount. That amount must also meet the frozen dependency bundle's minimum.
4. A separate source vault funder owns enough Aave Sepolia test USDC for the reviewed vault funding
   floor.
5. A separate executor owns the reviewed native-gas floor and transport WETH floor on both EVM
   networks. This backs real source recovery and destination delivery transactions while only the
   unavailable 1Click provider boundary is simulated.
6. The registry, owner, and verifier NEAR testnet accounts exist and are distinct. The registry has
   the reviewed deployment balance, no deployed code, and the selected deployment public key has
   full access. The verifier has its reviewed runtime balance.

Borrower, deployer, vault funder, and executor EVM addresses must all differ. The NEAR registry,
owner, and verifier accounts must all differ. The gate also rejects a vault or Morpho funding floor
below the borrower debt floor and a transport requirement above the borrower collateral floor.

This command proves inventory only. It does not prove current route economics, borrower signatures,
vault funding, deployment receipts, contract roles, oracle freshness at execution time, or complete
workflow readiness. Those remain later gates.

## Inputs

All token amounts are positive unsigned integers in the token's smallest units. Native EVM amounts
are wei and NEAR amounts are yoctoNEAR. No amount has a silent default.

| Variable                                     | Requirement                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `MAINNET_EXECUTION_ENABLED`                  | Omit or set `false`; `true` is rejected.                                                     |
| `PUBLIC_TESTNET_ROUTE_DEPENDENCIES_PATH`     | Optional byte-exact frozen route dependency file.                                            |
| `ETHEREUM_SEPOLIA_READ_RPC_URL`              | Optional credential-free HTTPS read endpoint; defaults to the reviewed free public endpoint. |
| `BASE_SEPOLIA_READ_RPC_URL`                  | Optional credential-free HTTPS read endpoint; defaults to the reviewed free public endpoint. |
| `NEAR_TESTNET_READ_RPC_URL`                  | Optional credential-free HTTPS read endpoint; defaults to the official testnet endpoint.     |
| `PUBLIC_TESTNET_BORROWER_ADDRESS`            | Borrower that already owns the Aave test position.                                           |
| `PUBLIC_TESTNET_DEPLOYER_ADDRESS`            | Public address of the future two-chain deployment signer.                                    |
| `PUBLIC_TESTNET_VAULT_FUNDER_ADDRESS`        | Separate holder of source Aave test USDC for the liquidity vault.                            |
| `PUBLIC_TESTNET_EXECUTOR_ADDRESS`            | Separate operational executor address.                                                       |
| `MINIMUM_BORROWER_SOURCE_NATIVE_BALANCE_WEI` | Borrower source-gas floor.                                                                   |
| `MINIMUM_AAVE_COLLATERAL_UNITS`              | Minimum finalized Aave WETH collateral.                                                      |
| `MINIMUM_AAVE_DEBT_UNITS`                    | Minimum finalized Aave variable USDC debt.                                                   |
| `MINIMUM_EVM_DEPLOYER_NATIVE_BALANCE_WEI`    | Minimum native balance required independently on each EVM network.                           |
| `DESTINATION_MORPHO_SEED_LIQUIDITY_UNITS`    | Exact planned Base Sepolia USDC seed amount.                                                 |
| `MINIMUM_VAULT_FUNDING_UNITS`                | Minimum source Aave USDC held by the future vault funder.                                    |
| `MINIMUM_EXECUTOR_NATIVE_BALANCE_WEI`        | Minimum executor native balance required independently on each EVM network.                  |
| `MINIMUM_TRANSPORT_COLLATERAL_UNITS`         | Minimum executor WETH balance required independently on each EVM network.                    |
| `NEAR_REGISTRY_ACCOUNT`                      | Existing future registry account; it must not already contain code.                          |
| `NEAR_REGISTRY_OWNER_ACCOUNT`                | Existing distinct governance account.                                                        |
| `NEAR_VERIFIER_ACCOUNT`                      | Existing distinct funded runtime verifier account.                                           |
| `NEAR_REGISTRY_DEPLOYMENT_PUBLIC_KEY`        | Public half of the proposed full-access registry deployment key; never the private key.      |
| `NEAR_MINIMUM_REGISTRY_BALANCE_YOCTO`        | Reviewed registry deployment/storage balance floor.                                          |
| `NEAR_MINIMUM_VERIFIER_BALANCE_YOCTO`        | Reviewed verifier runtime balance floor.                                                     |

The exact release floors must come from the signed demonstration size and gas budget. For the P0
route, source and destination debt assets both use six decimals and collateral assets both use
eighteen decimals, but operators must still enter base units explicitly.

## Command and result

Supply the public identities and reviewed floors through the operator shell, then run:

```powershell
npm run check:public-testnet-funding
```

The command rebuilds the domain and protocol packages, hashes the exact dependency file, reads both
EVM chain IDs and finalized blocks, uses the production Aave adapter for the borrower position,
reads native and ERC-20 balances at those blocks, and reads final NEAR account/access-key state.

The JSON output contains:

- the route ID and exact dependency hash;
- public operational identities;
- finalized EVM block numbers, hashes, and timestamps;
- Aave position and public balance observations;
- NEAR account existence, balances, registry code hash, and access permission category;
- all nineteen actual-versus-required checks and the complete deficiency list.

`PUBLIC_TESTNET_FUNDING_READY` with process exit code zero means every inventory predicate passed.
`PUBLIC_TESTNET_FUNDING_NOT_READY` exits non-zero after printing every deficiency. RPC/network/schema
errors also exit non-zero, but they are not converted into missing funds because an unavailable or
ambiguous provider must fail closed.

## Verified dry exercise

On 2026-11-13 the command was exercised through all three default free RPCs with deliberately
unfunded placeholder identities. It correctly returned `PUBLIC_TESTNET_FUNDING_NOT_READY` and all
nineteen deficiencies at Ethereum Sepolia finalized block `12127276` and Base Sepolia finalized
block `58333379`. The route dependency hash remained
`0x2186a31423918d16f0e712a233d3dd5dd392eaeb4604ddc2b138e12a297d7f17`.

That exercise proves the read path and fail-closed report; it is not evidence that the real release
accounts are funded. No private key was loaded and no public-chain write or token movement occurred.

## Ordered use

1. Select the release-sized debt, collateral, vault, seed, transport, and gas floors.
2. Create and fund the distinct public accounts outside this repository.
3. Create the Aave Sepolia borrower position and provision the required test assets.
4. Run this command until it returns `PUBLIC_TESTNET_FUNDING_READY`; preserve the JSON and time.
5. Rerun `npm run check:public-testnet-route` to refresh dependency/oracle evidence.
6. Only then open a reviewed deployment window and load the Morpho, DebtShift, and NEAR deployment
   private keys into their individual guarded commands.
7. After deployment, use the manifest-bound readiness commands. The pre-deployment report cannot
   substitute for post-deployment code, role, receipt, vault-balance, and startup attestation.

The next code increment is a guarded, manifest-bound source-vault funding command. It must use the
deployed EVM manifest, exact route/dependency hashes, an exclusive funding manifest, exact allowance
cleanup, receipt verification, and a post-funding balance check. This readiness command does not
perform that funding operation.
