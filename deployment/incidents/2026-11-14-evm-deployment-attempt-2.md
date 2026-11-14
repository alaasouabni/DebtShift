# Ethereum Sepolia EVM deployment attempt 2

## Status

Abandoned partial source deployment. Do not use the reserved manifest path or any address from this
attempt in DebtShift runtime configuration.

## Attempt identity

- Source commit: `9c21d7fdfe55de9f7437a6ffdf7e508194d8865e`
- Reserved manifest: `deployment/manifests/testnet-evm-sepolia-base-sepolia-20261114-v2.json`
- Environment: public testnet
- Source chain: Ethereum Sepolia (`11155111`)
- Destination chain: Base Sepolia (`84532`)
- Mainnet execution: disabled

## Reconciled source transactions

| Nonce | Action                    | Transaction                                                          | Block      | Address                                      |
| ----: | ------------------------- | -------------------------------------------------------------------- | ---------- | -------------------------------------------- |
|     9 | Deploy LiquidityVault     | `0xfccc3e92469213048a65b0a84d11ea704405dd21351e57da55132b9dd04a47e4` | `12130331` | `0xDc4B1e35786C4EC05e4B84c02319Ca8DA59cB9Dd` |
|    10 | Deploy MigrationEscrow    | `0x29354fc04d0d2ad84425e87d00d415273c784e8813eedb5c8e58c51aaa9a5d5f` | `12130332` | `0x524619Bbbf63a8fC5C12F46f0406D16b5F733772` |
|    11 | Deploy Aave source module | `0x9d020e8892a47a1ece1c0f9f419c93024b32000563e81f4ef72440563ce427ff` | `12130333` | `0x2eeC4cF64c3f152D80333896dFC77D7FF1029B19` |
|    12 | Deploy SourceAdapter      | `0xd1680b635ea20531a298a8bec599304176cf776ebd3c053d46610c069229ac52` | `12130334` | `0xCE84C13aC794e169A81bDe8560a626eb5F708fAc` |
|    13 | Bind Aave source adapter  | `0xd2369b20356642a16b9da164b68be7a6913c9690752b169ae9e6f56a6233f780` | `12130335` | Aave source module                           |

All five receipts have successful status and canonical block hashes. Runtime code observations:

| Contract            | Runtime bytes | Runtime code hash                                                    |
| ------------------- | ------------: | -------------------------------------------------------------------- |
| LiquidityVault      |       `12099` | `0x36ea76eb86f5f36305bfa83e7af156400bfed1f99d131b59122a3aeb22ddd629` |
| MigrationEscrow     |        `9938` | `0xd519671cd2b99f3844745fff77c57f9e4b9ec9a8cb847863ff6a5e6fcd3bc8c8` |
| AaveV3SourceLending |        `5409` | `0x36026afc629a136747c82189085bf9bc126d44f9bfc14b7ab6ec0a5196a8b510` |
| SourceAdapter       |        `7359` | `0x748762767af257501dd72c1c2697105c7a67b6d91e40646d867c77b38f228007` |

## Failure and rejected transaction

The next transaction would have called `setAsset(Aave Sepolia USDC, true)` on the vault with nonce
`14`. The RPC rejected `eth_sendRawTransaction` with `in-flight transaction limit reached for
delegated accounts`; it was never accepted. Latest and pending source nonces both remained `14`.
The deployer has EIP-7702 delegation code
`0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b` on both EVM testnets. One-confirmation
back-to-back broadcasts through a load-balanced public endpoint can therefore reach a backend that
still considers the previous delegated-account transaction in flight.

Base Sepolia nonce remained `10`, proving that no DebtShift destination transaction was broadcast.

## Abandonment checks

- Every contract owner is the reviewed deployer.
- The Aave module is bound to the source adapter and the adapter immutables point to this attempt's
  vault, lending module, and escrow.
- Vault Aave USDC allowlist: disabled.
- Vault source-adapter allowlist: disabled.
- Vault executor operator/verifier roles: disabled.
- Vault free USDC and token balance: `0`.
- Escrow source-adapter depositor role: disabled.
- Escrow executor operator role: disabled.
- Escrow USDC and WETH balances: `0`.
- Source-adapter executor role: disabled.
- The adapter's default pause flag is false, but it cannot draw, close, or deposit because the
  vault, escrow, and executor permissions above were never configured.
- No successful application manifest references these addresses.

The set is intentionally abandoned and unfunded. The next attempt must use a new exclusive manifest
path and additional receipt confirmations so every backend clears the delegated-account transaction
before the following broadcast.
