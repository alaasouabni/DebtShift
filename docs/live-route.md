# Submission route: Base Aave V3 to Arbitrum Morpho Blue

DebtShift's submission-critical production route is frozen in
`config/routes/base-aave-v3-to-arbitrum-morpho-blue.v1.json`. It is versioned policy and deployment
configuration, not a fallback embedded in application code.

## Route identity

- Source: Base (`8453`) Aave V3, WETH collateral and USDC variable debt.
- Transport: official NEAR Intents/1Click, Base WETH to Arbitrum WETH.
- Destination: Arbitrum One (`42161`) Morpho Blue USDC/WETH market
  `0xca83d02be579485cc10945c9597a6141e772f1cf0e0aa28d09a327b6cbd8642c`.
- Morpho singleton: `0x6c247b1F6182318877311737BaC0844bAa518F5e`.
- Morpho oracle: `0x282FEB10549fde52bD61A6979424Ddf18A4971A2`.
- LLTV: 86%. DebtShift applies stricter normal and stressed LTV limits from the route file.

## Evidence and freshness

The route validator reads both chains directly, derives Aave reserve token identities, validates the
Morpho market ID from its five immutable parameters, checks contract bytecode and Chainlink
freshness/sequencer state, proves positive destination liquidity, and confirms all four provider
asset IDs in the live 1Click catalog.

Run:

```bash
npm run check:live-route
```

The default RPCs are the official public Base and Arbitrum endpoints. `BASE_READ_RPC_URL` and
`ARBITRUM_READ_RPC_URL` may override them with credential-free HTTPS archival providers. The command
performs reads only and never loads an executor key.

Primary references:

- [Aave V3 contracts](https://aave.com/docs/aave-v3/smart-contracts)
- [Morpho deployment addresses](https://docs.morpho.org/developers/contracts/addresses/)
- [Morpho public market API](https://docs.morpho.org/developers/blue/tutorials/get-data/)
- [Chainlink feed addresses](https://docs.chain.link/data-feeds/price-feeds/addresses)
- [Official 1Click OpenAPI](https://1click.chaindefuser.com/docs/v0/openapi.yaml)

This configuration is not an execution authorization. Deployment code hashes, borrower position,
oracle freshness, liquidity, rates, quotes, balances, roles, pause state, and every signed limit must
be revalidated at execution time. A route validation pass can become stale immediately.
