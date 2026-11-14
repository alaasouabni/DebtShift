# Ethereum Sepolia vault-funding attempt 1

## Status

Reconciled and safely abandoned. The exact vault deposit did not occur, and the emergency allowance
cleanup succeeded.

## Attempt identity

- Source commit: `7d6fd5c756b626cb791efbcf39c9662eee9e0262`
- EVM deployment manifest: `testnet-evm-sepolia-base-sepolia-20261114-v3.json`
- Reserved funding manifest: `testnet-vault-funding-ethereum-sepolia-20261114-v1.json`
- Funder: `0x3235c155D8b5eB561339F37112A49c5ef8DcB3Bf`
- Vault: `0xDC52C1980c2F69c1152e05D3812d752A0D238f3E`
- Asset: Aave Ethereum Sepolia USDC (`0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`)
- Intended amount: `10000000` base units
- Mainnet execution: disabled

## Reconciled transactions

| Nonce | Action                     | Transaction                                                          | Block      |
| ----: | -------------------------- | -------------------------------------------------------------------- | ---------- |
|     0 | Approve exact 10 test USDC | `0xa07d4f66c5de998fb59b891b0ac68454798ed2fdc881d6d985bf31ead867086c` | `12130413` |
|     1 | Emergency revoke allowance | `0x6886aeaba0b4f502bd85ccb111424471b5b214f6d7708e20706493ef3fd2bcbf` | `12130416` |

After the successful approval receipt, an immediate canonical-block read was routed to a public RPC
backend that did not yet know block `12130413`. The funding implementation failed closed and ran its
emergency `approve(vault, 0)` path. It never broadcast the vault deposit.

Post-cleanup state was independently read as:

- funder USDC balance: `10000000`;
- vault USDC balance: `0`;
- vault free USDC liquidity: `0`;
- funder-to-vault allowance: `0`;
- funder latest and pending nonce: `2`.

The zero-byte reserved manifest is preserved as an incident marker. The later successful attempt
used a new exclusive manifest path and ten receipt confirmations. Canonical receipt-block reads now
also use a bounded retry without weakening any transaction, identity, balance-delta, or allowance
check.
