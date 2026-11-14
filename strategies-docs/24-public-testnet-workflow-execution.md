# Public-testnet workflow execution evidence

## Scope and verdict

On 2026-11-14, DebtShift executed the funded route from an Aave V3 WETH/USDC position on
Ethereum Sepolia toward the DebtShift-operated Morpho Blue market on Base Sepolia. The runtime was
in `testnet` mode with simulated transport at the unavailable 1Click testnet boundary.
`MAINNET_EXECUTION_ENABLED` remained `false` throughout.

The third attempt closed the real Aave source position and delivered its collateral to the real
Base Sepolia destination escrow. A restricted public RPC delayed destination-event discovery until
the signed four-minute deadline had expired. The worker correctly refused to open the Morpho target
after expiry. The signed recovery path then returned all delivered collateral to the borrower and
settled the vault's exact receivable from the isolated executor reserve.

The terminal verdict is therefore **verified failed-safe recovery**, not a completed refinance.
Source close, two-chain transport, destination verification, expiry enforcement, and financial
recovery have public-chain evidence. Target opening, solver settlement, and final NEAR receipt
registration still require a fresh source position and one new end-to-end run.

## Runtime and deployment bindings

| Binding             | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| Borrower            | `0x1Fd6023339A643a0e681d636A78d6aba723F3505`                         |
| Executor            | `0x662C3218f0f2bE4f40f06a4f4Bc730dCe1996233`                         |
| Source vault        | `0xDC52C1980c2F69c1152e05D3812d752A0D238f3E`                         |
| Source adapter      | `0x0fd9ABcb48bD76c4aCEb07Baad5c4d58f7a39aD5`                         |
| Destination escrow  | `0x524619Bbbf63a8fC5C12F46f0406D16b5F733772`                         |
| Destination adapter | `0xCE84C13aC794e169A81bDe8560a626eb5F708fAc`                         |
| Morpho              | `0x072FB33E63f76479DF0C145F3ebdcc3C241f0771`                         |
| Morpho market ID    | `0x4505167c540e27ecdb28aacf9977a68e2b3d760022be14a686cbb0f737b3564e` |
| NEAR registry       | `debtshift-registry-alaa-2026.testnet`                               |

The immutable EVM, Morpho, vault-funding, and NEAR deployment manifests are under
`deployment/manifests/`. The NEAR deployment transaction is
[`Fjtfg2...FaQnQ`](https://explorer.testnet.near.org/transactions/Fjtfg2derYBQ7Mt2wmyh5XnHUQGkwCw4WmqBPxZFaQnQ).

## Attempt ledger

| Migration                                                            | Durable result                                                       | Asset effect                                                    | Cause and disposition                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0xd3cdab3004faedc41a60df093ec854602c899276275ca10d2808fbaa6bd25004` | `AUTHORIZED`; `RESERVE_LIQUIDITY` failed terminal before broadcast   | None                                                            | Executor had no independent USDC recovery reserve. The pre-broadcast simulation failed closed.                                                                                                 |
| `0xbd6c1713886008743cd344531bd2dcec29535f3385a89f2b45e0db707f772f1c` | `AUTHORIZED`; `RESERVE_LIQUIDITY` failed terminal before reservation | None                                                            | Adjacent public RPC heads produced a future feasibility timestamp and `InvalidFeasibility()`. Conservative timestamp selection fixed this without weakening validation.                        |
| `0x87ebf9802661988310800deccc59bb651e6431b0177fa6f025fc6ecfcb61c212` | `FAILED_SAFE`; recovery case `RESOLVED_FAILED_SAFE`                  | Source closed, collateral returned on Base, vault fully settled | Destination delivery was real, but a 200-block `eth_getLogs` provider limit delayed verification past the signed deadline. The target open was rejected and the authorized recovery completed. |

The first two rows remain at the durable pre-source phase `AUTHORIZED`; their financial commands
are terminal and neither attempt reserved liquidity nor moved borrower assets.

## Public-chain transaction evidence

| Step                                          | Network          | Transaction                                                                                                           |
| --------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Fund executor recovery reserve                | Ethereum Sepolia | [`0xf053...3e84`](https://sepolia.etherscan.io/tx/0xf053a12c58844e50e1379a9359a76ce5264c9b8e21ee4f69114c768572643e84) |
| Revoke stale executor/vault allowance         | Ethereum Sepolia | [`0xe11e...007`](https://sepolia.etherscan.io/tx/0xe11ee062621aee9b183733f1fb21e8503167f6fac6839a14957c76c7594f5007)  |
| Borrower aWETH authorization                  | Ethereum Sepolia | [`0x1260...07d`](https://sepolia.etherscan.io/tx/0x126039e4da785d7809f80745c09864bedc41db23732008115deddba6fbaa607d)  |
| Executor reserve authorization                | Ethereum Sepolia | [`0xb857...9bf`](https://sepolia.etherscan.io/tx/0xb85789c9b869a8cc37cbed79a72725553ea1685a3143f2ae85b5a96de35579bf)  |
| Reservation feasibility                       | Ethereum Sepolia | [`0xf6a8...c84`](https://sepolia.etherscan.io/tx/0xf6a8bccaa984bf4120066466589a57e4315acbe31aa81db6cf84ce552fd48c84)  |
| Reserve liquidity                             | Ethereum Sepolia | [`0x2c8f...123`](https://sepolia.etherscan.io/tx/0x2c8f3488cbeca451c0366b6327ec67aa470084017516d12fffc7e179ec641e23)  |
| Source-close feasibility                      | Ethereum Sepolia | [`0x9bee...528`](https://sepolia.etherscan.io/tx/0x9bee4f181814985bd61eb7bc8d28a7b44454bcacb191d6140958b4d7ad26f528)  |
| Close Aave source                             | Ethereum Sepolia | [`0xd1fb...be8`](https://sepolia.etherscan.io/tx/0xd1fb3a55876ab6393e6b25e0ce26470d3378cdbd783becfa0b11241addbd6be8)  |
| Dispatch transport origin                     | Ethereum Sepolia | [`0x5aa2...31a`](https://sepolia.etherscan.io/tx/0x5aa2a8856adb50c22f9091943e4deaffda3104defeed20b03c63e87f0b7b331a)  |
| Deliver simulated transport asset             | Base Sepolia     | [`0xb7d9...e46`](https://sepolia.basescan.org/tx/0xb7d9e80f4dca2c0a91857ebb4a5b0392a521c6d754a8b151ee9002167a46ce46)  |
| Verify and register destination inbound       | Base Sepolia     | [`0xd992...897`](https://sepolia.basescan.org/tx/0xd992ad15a6221950e3cf2865f8d350471de4de91b9ef301da5a80b562c6f4897)  |
| Return collateral to signed borrower receiver | Base Sepolia     | [`0x7fe8...087`](https://sepolia.basescan.org/tx/0x7fe8086e0b1f7a6babff1d39db8b520192585cfaa43a29023130f1b2adb52087)  |
| Settle source-vault receivable from reserve   | Ethereum Sepolia | [`0xbd9d...f86`](https://sepolia.etherscan.io/tx/0xbd9dca29ec8a3363cdfc8a112436f0dc296a214d15daefc085d47403b32f9f86)  |

## Final onchain reconciliation

The reconciliation was read independently from both EVM networks after recovery:

| State                                         |     Final value |
| --------------------------------------------- | --------------: |
| Borrower Aave variable USDC debt              |             `0` |
| Borrower source aWETH                         |             `0` |
| Borrower Base WETH                            |  `0.00999 WETH` |
| Destination escrow WETH                       |             `0` |
| Assigned destination WETH                     |             `0` |
| Source vault USDC                             |       `10 USDC` |
| Source vault free liquidity                   |       `10 USDC` |
| Source vault principal receivable             |             `0` |
| Source vault locked recovery reserve          |             `0` |
| Reservation status                            |       `SETTLED` |
| Executor USDC after exact recovery settlement | `4.999043 USDC` |

The borrower owes no source debt, the destination escrow retains no borrower collateral, and the
vault has no outstanding receivable. No Morpho position was opened. The stored reservation amount
of `5.000957 USDC` is historical settlement evidence, not a live receivable.

## Defects found and closed

1. Simulated testnet analysis now uses analytical transport parity and omits zero-valued financing
   rows, preventing invalid prepared payloads and reserve-cap mismatches.
2. Aave revalidation permits only bounded upward variable-debt accrual within the signed 10 bps cap;
   collateral decreases and debt decreases still fail closed.
3. Feasibility timestamps use a conservative lag so adjacent public RPC head skew cannot create a
   future timestamp onchain.
4. EVM evidence scans recognize provider log-range errors and scan backward in inclusive 200-block
   chunks. The public-testnet runtime also uses a compatible Base Sepolia endpoint.
5. `EXECUTION_PLAN_TTL_SECONDS` is now bounded to 60-3600 seconds. The production default remains
   240 seconds; public testnet uses 3,600 seconds, and simulator quote lifetime automatically exceeds
   the signed window. Existing signatures are never extended.

## Exact next run

1. Create a fresh borrower Aave Sepolia position; the tested source position is intentionally gone.
2. Top up the executor's independent test USDC recovery reserve so it covers the new signed source
   receivable in addition to gas on both EVM networks.
3. Start API and worker with `DEBTSHIFT_MODE=testnet`, `EXECUTION_PLAN_TTL_SECONDS=3600`, a Base RPC
   that supports canonical logs, and `MAINNET_EXECUTION_ENABLED=false`.
4. Prepare and sign a completely new intent and plan. Never reuse or extend the expired plan.
5. Require public receipts for Morpho supply/borrow, solver settlement, and final NEAR registry state,
   then reconcile source debt, both escrows, target position, vault, executor, ledger, and receipt.

Until those five steps pass, the honest public-testnet claim is: **the funded workflow safely closed,
transported, detected an expired target-open authorization, and recovered without a shortfall**.

## 2026-11-14 rerun recovery and fresh readiness checkpoint

A later funded migration,
`0xbd8ff4991eb6829ee8270a0d090779c8a607c5a5af9c4963b6d990c05373f014`, reached a real
destination receipt at Base block `58,566,996`. One load-balanced RPC response reported tip
`58,566,995` while returning the correct block and receipt, which the worker conservatively treated
as lost finality. Direct reconciliation subsequently observed the same canonical hash with 727
confirmations. Because the signed plan expired during reconciliation, no target-open deadline was
bypassed.

The failed-safe path completed with these public receipts:

- reserve:
  [`0x6e64...88e3`](https://sepolia.etherscan.io/tx/0x6e6454c25ac73a9a1f3c3703ad4a15c555ed7f2daac02d46e64286ca158c88e3);
- source close:
  [`0xe27b...dccc`](https://sepolia.etherscan.io/tx/0xe27b5d3268baa18176b8b401bf7463d7c39b67193c393b83f2911d2e2431dccc);
- destination registration:
  [`0xfe93...8e2`](https://sepolia.basescan.org/tx/0xfe93ce324efff9f5a8c8677ae101357c9edfdc6015e0f6a78659bf9e46e828e2);
- collateral return:
  [`0x95e0...a408`](https://sepolia.basescan.org/tx/0x95e0b405d2fbd4ad9f8a74e42e007d004127d0fe612878b31d0195d7b4c7a408);
- isolated-reserve settlement:
  [`0x1345...236e`](https://sepolia.etherscan.io/tx/0x134525bed9256e3534cd6631468a97409d87cf15c4b4f26146f3ed9ead40236e).

The runtime now retries matching-block `FINALITY_DEPTH_LOST` observations, while true block/receipt
mismatches still open append-only recovery. All 90 worker tests pass. The public-testnet plan window
is 3,600 seconds, and mainnet execution remains disabled.

The recovered assets were recycled and a new run was staged. The final pre-UI audit passed every
guard: borrower `0.01 aWETH` with about `5 USDC` variable debt; executor `10 USDC` on Sepolia and
`0.02 WETH` on Base; vault `10 USDC` free with no locked reserve or receivable; zero vault
allowance; empty destination escrow; empty Morpho position; disabled Morpho module authorization;
and funded gas accounts on both networks.
