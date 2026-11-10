# Production and simulator provider boundaries

## Purpose

DebtShift keeps deterministic simulation and production integration code in the same repository,
but they are different runtime capabilities. This document defines the boundary so simulator
fixtures cannot be mistaken for production market data or silently selected in a production
environment.

## Runtime selection

`MARKET_DATA_PROVIDER` is mandatory through the validated environment model:

| Value            | Permitted environments   | Behavior                                                                            |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `SIMULATOR`      | `local`, `ci`, `testnet` | Uses disposable dual-Anvil contracts and versioned deterministic fixtures.          |
| `LIVE_READ_ONLY` | `mainnet-readonly`       | Uses direct Aave, Morpho, and Chainlink reads plus authenticated 1Click dry quotes. |
| `DISABLED`       | `mainnet-canary`         | Removes lending-market access from the isolated transport canary.                   |

Validation fails closed for every other pairing. There is no automatic fallback from
`LIVE_READ_ONLY` to `SIMULATOR`.

## Code boundary

- `apps/api/src/simulator/` contains local position, market, and route fixtures.
- `apps/worker/src/simulator/` contains the dual-Anvil execution implementation.
- `apps/api/src/live/` contains live read-only protocol and market-data implementations.
- `apps/api/src/market-data/ports.ts` is the only dependency surface used by application services.
- `apps/api/src/app.module.ts` is the composition root that selects one provider after environment
  validation.
- ESLint forbids production modules from importing `simulator/`; only composition roots and tests
  may reference simulator implementations.

The simulator values are intentionally deterministic test inputs. They include mock APRs, gas and
transport costs, liquidity constraints, stress policy, and a deliberately rejected route. They are
not deployment defaults, production quotes, or fallback values.

## Live registry

`LIVE_MARKET_CONFIG_JSON` is a versioned, schema-validated runtime registry. It supplies every live
deployment and policy value explicitly:

- Aave pool and protocol data-provider addresses.
- Source collateral and debt assets, decimals, symbols, and 1Click asset identifiers.
- Morpho singleton, market ID, oracle, destination assets, and 1Click identifiers.
- Chainlink price feeds, freshness limits, and optional L2 sequencer feeds.
- Route-risk limits and snapshot/oracle freshness limits.
- Conservative gas-unit bounds, settlement-time assumptions, and explicit analytics risk costs.

The repository does not provide production address defaults. A deployment is invalid until the
registry is supplied, chain IDs match the configured RPCs, token metadata matches direct contract
reads, the Morpho market ID reconstructs correctly, and its token/oracle identities match the
registry.

## Live read-only behavior

The live route path performs the following operations without signing or broadcasting:

1. Read the Aave position and reserve rate at one canonical source block.
2. Obtain authenticated 1Click `dry: true` collateral and debt conversion quotes.
3. Reconstruct and read the Morpho market, available liquidity, current rate, and projected rate at
   one canonical destination block.
4. Validate Chainlink rounds, answer positivity, `answeredInRound`, maximum age, and optional L2
   sequencer recovery grace.
5. Calculate gas cost from live gas prices, configured conservative gas bounds, and direct native/USD
   feeds.
6. Calculate collateral transport loss and slippage from base-unit quote amounts and direct price
   feeds. Provider USD display fields are never used for financial logic.
7. Run the deterministic route and zero-shortfall models.

Live routes are marked `adapterVersionApproved: false` in the first release. They can be analyzed
but cannot produce a funded migration plan. This is an intentional production safety lock, not a
simulator fallback.

## 1Click boundary

The read-only client is pinned to `https://1click.chaindefuser.com`, requires HTTPS, rejects
credentials embedded in URLs, disables redirects, applies time and response-size limits, validates
responses, and exposes only token-catalog and dry-quote methods. It has no committed-quote, deposit,
or broadcast method.

The future canary client is a separate capability. It must enforce the allowlisted asset pair,
base-unit cap, fixed recipient and refund receiver, manual confirmation, and the `DISABLED` lending
provider before a committed quote can be requested.

## Verification gates

- Environment tests cover invalid provider/environment pairings.
- Registry tests reject malformed or incomplete live configurations.
- API and worker type/lint tests prove the port boundary.
- 1Click unit tests prove official-origin pinning, authentication, dry-only requests, and response
  validation.
- Aave, Morpho, and Chainlink unit tests cover pinned reads and fail-closed identity/freshness checks.
- Pinned public-fork tests remain required before M3/M8 completion.
- No live committed quote or funded action is run in CI.
