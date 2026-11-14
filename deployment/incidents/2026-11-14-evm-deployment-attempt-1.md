# Ethereum Sepolia EVM deployment attempt 1

## Status

Abandoned partial deployment. Do not use the reserved manifest path or the deployed vault in any
DebtShift runtime configuration.

## Attempt identity

- Source commit: `5a3520f1e33a02d03c31cab276e7909f071fcdc4`
- Reserved manifest: `deployment/manifests/testnet-evm-sepolia-base-sepolia-20261114-v1.json`
- Environment: public testnet
- Source chain: Ethereum Sepolia (`11155111`)
- Destination chain: Base Sepolia (`84532`)
- Mainnet execution: disabled

## Reconciled transaction

- Deployer: `0xF4cbc06C5295C15f5E308507269dE6fC6Fb9d0d2`
- Nonce: `8`
- Transaction: `0x27488674e4fdad80e3c73fd92a2785fb8dc7dd832203a138a4fcb6339dca8dd9`
- Receipt status: success
- Block: `12130300`
- Block hash: `0xddd5b97eb5fcb4a943895a8339fdec39b42c38940a52a812f2487b38dcdb280d`
- Contract: `0x1Cd0B321610Ad3adFD660FDD3C7B8b3614c937D0`
- Artifact: `LiquidityVault`
- Runtime code size: `12099` bytes
- Runtime code hash: `0x36ea76eb86f5f36305bfa83e7af156400bfed1f99d131b59122a3aeb22ddd629`
- Compiled artifact runtime hash: exact match

The command received the successful deployment receipt and then received `0x` from an immediate
`eth_getCode` latest-state read. It failed closed before deploying `MigrationEscrow`, the source
lending module, the source adapter, or any destination contract. A later read returned the complete
runtime bytecode. This is consistent with a public RPC load balancer routing the receipt and state
reads to backends at different heads.

## Abandonment checks

- Owner: the reviewed deployer address
- Deployer operator/verifier defaults: enabled by the constructor
- Executor operator: disabled
- Executor verifier: disabled
- Aave Sepolia USDC asset allowlist: disabled
- Aave Sepolia USDC free liquidity: `0`
- Aave Sepolia USDC token balance: `0`
- No application manifest references this address
- No destination DebtShift contract was broadcast by this attempt

The isolated vault is intentionally abandoned. It is unfunded and cannot accept a DebtShift vault
deposit because the debt asset was never allowlisted. The next attempt must use a new exclusive
manifest path and a new source commit.

## Corrective action

Both guarded deployment implementations now read bytecode at the exact receipt block and retry for
up to 15 seconds. An empty latest-state response is no longer accepted as final immediately after a
successful receipt. The retry remains bounded and still fails closed if code cannot be proven.
