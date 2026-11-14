# Public-testnet workflow execution evidence

## Scope and verdict

On 2026-11-14, DebtShift completed the funded route from an Aave V3 WETH/USDC position on
Ethereum Sepolia to the DebtShift-operated Morpho Blue market on Base Sepolia. The runtime was in
`testnet` mode with simulated transport at the unavailable 1Click testnet boundary.
`MAINNET_EXECUTION_ENABLED` remained `false` throughout.

Migration `0xece17b2ff0fc8c28c5878e5fccef6cfaf108b3ef99d66f719b1165d151db8475`
closed the real Aave source position, moved the collateral across real public-testnet custody
transactions, opened the Morpho target position, settled the source vault exactly, reconciled a
balanced ledger, and finalized the immutable receipt bundle in the NEAR testnet registry.

The terminal verdict is **verified public-testnet happy-path completion**. Earlier attempts in this
document remain useful failed-safe evidence: they proved that expired authorization and ambiguous
canonicality cannot bypass recovery. They are not the final result of the completed run.

## Runtime and deployment bindings

| Binding             | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| Borrower            | `0xF4cbc06C5295C15f5E308507269dE6fC6Fb9d0d2`                         |
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
| `0xece17b2ff0fc8c28c5878e5fccef6cfaf108b3ef99d66f719b1165d151db8475` | `COMPLETED`; NEAR receipt finalized                                  | Source closed, target opened, vault fully settled               | The complete 3,600-second signed workflow passed. Stale post-write RPC reads were reconciled from canonical events and contract state without duplicating financial effects.                   |

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

## Historical rerun plan (completed)

1. Create a fresh borrower Aave Sepolia position; the tested source position is intentionally gone.
2. Top up the executor's independent test USDC recovery reserve so it covers the new signed source
   receivable in addition to gas on both EVM networks.
3. Start API and worker with `DEBTSHIFT_MODE=testnet`, `EXECUTION_PLAN_TTL_SECONDS=3600`, a Base RPC
   that supports canonical logs, and `MAINNET_EXECUTION_ENABLED=false`.
4. Prepare and sign a completely new intent and plan. Never reuse or extend the expired plan.
5. Require public receipts for Morpho supply/borrow, solver settlement, and final NEAR registry state,
   then reconcile source debt, both escrows, target position, vault, executor, ledger, and receipt.

These five steps were subsequently completed by migration
`0xece17b2ff0fc8c28c5878e5fccef6cfaf108b3ef99d66f719b1165d151db8475`. The
recovery record below is preserved as historical safety evidence; the final public-testnet claim is
the completed happy path recorded at the end of this document.

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

## 2026-11-14 completed happy path

The staged position was executed as migration
`0xece17b2ff0fc8c28c5878e5fccef6cfaf108b3ef99d66f719b1165d151db8475`.
The durable phase reached `COMPLETED`; all seven commands succeeded and the NEAR receipt finalized
on the first durable attempt. The transport provider remains explicitly `DEBTSHIFT_SIMULATOR`
because official 1Click has no public testnet, but every custody boundary below is a real public
testnet transaction.

| Step                                | Network          | Transaction                                                                                                           |
| ----------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Borrower source authorization       | Ethereum Sepolia | [`0x4ec5...1b9f`](https://sepolia.etherscan.io/tx/0x4ec5b122d9a1877a74bbfcdf6c01e5ad113ce973c0bdf6ca55b1007b556d1b9f) |
| Reserve source liquidity            | Ethereum Sepolia | [`0x7524...c86`](https://sepolia.etherscan.io/tx/0x7524a461e58243bb478f0626cf54228968d0ee580158212b3db765619e456c86)  |
| Close Aave source                   | Ethereum Sepolia | [`0xe1e0...d51`](https://sepolia.etherscan.io/tx/0xe1e0122bfd1e8dcd482567def9134cd1b5d9c0c0eff5fda0a66a8f21afc0bd51)  |
| Dispatch transport origin           | Ethereum Sepolia | [`0xd63c...41e1`](https://sepolia.etherscan.io/tx/0xd63c68bdb46ec7f59ce38ec3605cada97b3b5d641dfc77f0156a5727c8a241e1) |
| Register destination delivery       | Base Sepolia     | [`0x50e4...008c`](https://sepolia.basescan.org/tx/0x50e4b4038e67459f6cc081028216447b76ff660cb84da4f02178e67a64c1008c) |
| Open Morpho position and pay solver | Base Sepolia     | [`0xe803...1a65`](https://sepolia.basescan.org/tx/0xe803e0ab9fbc75b8e801fabda5fce4f2e752bd636412e18c2044e4e70a711a65) |
| Settle source vault                 | Ethereum Sepolia | [`0xd2b8...b07e`](https://sepolia.etherscan.io/tx/0xd2b82d9f7d81bd0515e5cad887e9c71015ac91d924005341521115648f88b07e) |
| Finalize registry agreement         | NEAR testnet     | [`G9f91...VCCS`](https://testnet.nearblocks.io/txns/G9f91sonXUNaLEB5t15hPoehXT38WTUwmYa4wez2VCCS)                     |

The final registry receipt has terminal status `COMPLETED`, bundle hash
`0x46bcf82c8e04a4fdabefadb8c90c03e75c2136a1bfe200c1b2204e4122169166`, and was
finalized by `debtshift-verifier-alaa-2026.testnet`.

Independent final reconciliation at Ethereum Sepolia head `12,131,326` and Base Sepolia head
`58,579,329` proved:

- Aave source collateral and variable debt are both zero;
- the Morpho target holds `0.00999 WETH` collateral and `5,000,106,000,000` borrow shares;
- destination escrow WETH is zero and its one-shot module authorization is disabled;
- source vault balance and free liquidity are exactly `10 USDC`;
- source vault locked reserve and principal receivable are both zero;
- executor/vault allowance is zero; and
- the NEAR agreement and final receipt independently reproduce the locally computed bundle hash.

Two production defects exposed by the run are closed in the worker:

1. Feasibility hashes are derived locally from the exact ABI-encoded evidence after a finalized
   write, so a lagging RPC cannot return the previous feasibility hash to the next transaction.
2. Idempotent settlement reconciliation reconstructs the full principal, fee, reserve-provider,
   repayment, and capitalized-cost accounting payload from finalized contract state. An already
   successful settlement can therefore persist evidence and a balanced ledger without broadcasting
   a duplicate transaction.

The remaining route work is production hardening and explicit mainnet approval, not another
public-testnet happy-path attempt. Mainnet writes remain disabled.
