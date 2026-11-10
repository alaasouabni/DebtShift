# Agent and free data-source strategy

## Decision summary

DebtShift uses two separate intelligence layers:

1. **DebtShift Route/Risk Agent:** deterministic TypeScript code that discovers positions, calls data tools, evaluates safety and economics, ranks eligible routes, monitors migrations, and prepares unsigned intent data.
2. **Explanation Agent:** optional local or remote inference that converts the deterministic result into plain-language explanations. It has no financial authority.

The project has no mandatory paid API, hosted model, proprietary indexer, or commercial RPC dependency.

## Agent modes

| Mode            | Configuration                                                   | Behavior                                                                             |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `DETERMINISTIC` | None                                                            | Default. Uses the financial agent and deterministic explanation templates.           |
| `LOCAL_AI`      | Local Ollama URL and model                                      | Uses the financial agent, then asks the local model to explain its result.           |
| `USER_API`      | Provider preset or compatible endpoint, model, and user API key | Uses the financial agent, then asks the selected remote model to explain its result. |

Changing modes never re-runs or modifies the financial decision. It only changes how an already-computed result is worded.

## Route/Risk Agent

### Responsibilities

- Discover source positions for a supplied wallet.
- Discover supported destination markets.
- Reject stale, illiquid, unsupported, or unsafe routes.
- Calculate projected rates, costs, stress outcomes, and break-even time.
- Reconcile solver principal, fees, financed and separately paid costs, borrower debt prepayment, and
  confirmed supplementary funding without double counting.
- Calculate protocol capacity, DebtShift policy capacity, safe market liquidity, required destination
  borrowing, and exact funding shortfall.
- Return only secured shortfall-resolution alternatives and reject unresolved plans.
- Rank only routes that pass deterministic policy.
- Monitor source and target safety during execution.
- Prepare unsigned intent and execution-plan data for explicit wallet review.
- Explain which data was used, its block/timestamp provenance, and why routes were accepted or rejected.

### Allowed tools

- `getSourcePositions(wallet, chains)`
- `getAaveMarketSnapshot(chain, market, blockTag)`
- `getMorphoMarketSnapshot(chain, marketId, blockTag)`
- `getTokenMetadata(chain, token)`
- `getOracleSnapshot(chain, oracle, blockTag)`
- `getGasEstimate(chain, transaction)`
- `getOneClickTokenCatalog()`
- `getOneClickDryQuote(request)`
- `compareRoutes(position, candidates, policy)`
- `analyzeRefinancingFeasibility(position, market, quote, fundingEvidence, policy)`
- `getMigrationEvidence(migrationId)`
- `prepareUnsignedIntent(route, limits)`

### Forbidden capabilities

- Wallet signing.
- Private-key access.
- Transaction broadcasting.
- Committed 1Click quotes or deposits.
- Solver or vault reservations.
- Contract writes.
- Receiver or refund-address substitution.
- Risk-policy modification.
- Treating pending transfers, wallet balances, promises, or forecast capacity as confirmed funding.
- Marking a migration phase complete.

The execution API invokes write commands only after explicit user authorization and independent deterministic validation. It never accepts an LLM statement as evidence.

## Optional explanation providers

### Default deterministic provider

No model is required. Structured rejection reasons, economics, safety metrics, and warnings are rendered through maintained templates. This mode is always available and is selected on first launch.

### Local AI

- Runtime: Ollama on the developer machine.
- Model: `qwen3.5:4b`.
- Lower-resource fallback: `qwen3.5:2b`.
- No-model fallback: deterministic explanation templates.

The exact model digest is pinned in setup documentation once the repository is initialized. The explanation input contains only validated route results, rejection reasons, source timestamps, and public transaction data.

### User-supplied API

The user may choose a supported remote provider preset or an explicitly enabled compatible endpoint and enter:

- Provider.
- Model identifier.
- API key or bearer token.
- Optional API base URL when custom endpoints are enabled.

The initial generic adapter targets an OpenAI-compatible chat interface. Provider-specific adapters may be added behind the same internal contract when their authentication or payload shape differs.

#### Credential handling

- Deterministic mode requires no credential.
- API keys remain in browser memory and are submitted only with the explanation request.
- The backend uses the key for that request and immediately discards it.
- Keys are never written to local storage, session storage, cookies, PostgreSQL, Redis, logs, traces, metrics, crash reports, or analytics.
- Authorization headers and provider errors are redacted before logging.
- The settings UI explicitly states that the key transits the DebtShift backend when the proxy mode is used.

#### Endpoint security

- Known provider presets use fixed HTTPS base URLs.
- Custom remote endpoints require HTTPS and explicit feature enablement.
- DNS results and redirects are checked to reject loopback, link-local, metadata, private, and reserved network destinations.
- Local Ollama is a separate mode with an explicit local URL policy.
- Requests have strict connection/read timeouts and response-size limits.
- Provider responses are treated as untrusted text and schema-validated.

#### Data minimization

Remote providers receive only the allowlisted explanation payload:

- Public market identifiers.
- Rounded display metrics and deterministic result values.
- Route acceptance or rejection reasons.
- Data timestamps and non-sensitive warnings.

They never receive API credentials for other services, wallet signatures, private keys, session tokens, raw authorization payloads, unpublished addresses, or internal operational secrets.

### Output contract

Every optional AI provider returns schema-validated fields:

- Summary.
- Main economic benefit.
- Main risks.
- Break-even explanation.
- Safety explanation.
- Financing-coverage and shortfall explanation.
- Data-freshness warning.
- Explicit statement that the user must review and sign.

Invalid, incomplete, or unsupported output is discarded and replaced by deterministic templates. Model output is never stored as execution evidence.

## Free data-source matrix

| Data                           | Primary free source                                                         | Execution authority                  | Fallback / verification                                            |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| Base chain state               | `https://mainnet.base.org` and `https://sepolia.base.org`                   | Direct RPC reads and receipts        | Configurable secondary free-tier RPC; fail closed                  |
| Arbitrum chain state           | `https://arb1.arbitrum.io/rpc` and `https://sepolia-rollup.arbitrum.io/rpc` | Direct RPC reads and receipts        | Configurable secondary free-tier RPC; fail closed                  |
| Aave discovery and UI data     | `https://api.v3.aave.com/graphql`                                           | No                                   | Direct Pool, data-provider, oracle, aToken, and debt-token reads   |
| Aave deployments               | Official Aave address book / supported-chain data                           | No                                   | Runtime bytecode and chain-ID validation                           |
| Morpho discovery and analytics | `https://api.morpho.org` REST                                               | No                                   | Morpho SDK and direct contract/oracle reads                        |
| Morpho market identity         | Official API/SDK using all five market parameters                           | Market ID is re-derived locally      | Direct Morpho contract state                                       |
| 1Click assets and preview      | `https://1click.chaindefuser.com/v0/tokens` and `dry: true` quote           | No                                   | Runtime schema validation; unavailable means no live route         |
| 1Click canary status           | Production `/v0/status` plus returned transaction data                      | Provider observation only            | Independent origin/destination RPC receipts and balances           |
| NEAR testnet registry          | `https://test.rpc.fastnear.com`                                             | NEAR receipt and contract view       | `https://archival-rpc.testnet.near.org` with strict rate limiting  |
| Token prices for authorization | Protocol-native Aave and Morpho oracles                                     | Yes, within protocol-specific policy | Cross-check indexed values; mismatch fails closed                  |
| USD values for display         | Aave/Morpho public APIs derived from their market data                      | No                                   | Hide USD view when unavailable                                     |
| Gas price and gas usage        | `eth_estimateGas`, `eth_feeHistory`, and receipts                           | Quote input only                     | Conservative configured buffer                                     |
| Supplementary funding          | Migration escrow balance and finalized deposit receipt                      | Yes, for confirmed external funding  | Execution-plan binding plus independent balance-delta verification |
| Historical application events  | DebtShift PostgreSQL indexer using `eth_getLogs`                            | Verified against RPC block hashes    | Re-index from last finalized cursor                                |

## Data precedence

When sources disagree, DebtShift uses this order:

1. Finalized direct contract state and transaction receipts.
2. Confirmed direct RPC state at a recorded block.
3. Official protocol SDK calculations based on direct reads.
4. Official indexed protocol APIs.
5. Cached official API responses.
6. Local deterministic fixtures, only in local or CI environments.

Lower-priority data may discover or display a route but cannot override higher-priority evidence.

## Freshness and caching

Initial defaults are conservative and configurable:

| Data                               | Cache / maximum age                                                      |
| ---------------------------------- | ------------------------------------------------------------------------ |
| 1Click token catalog               | Cache 10 minutes; refresh on unknown asset                               |
| 1Click quote                       | Never reused beyond its provider deadline                                |
| Aave/Morpho discovery list         | Cache 60 seconds                                                         |
| Market rate and liquidity snapshot | Maximum age 15 seconds for quoting                                       |
| Position snapshot                  | Maximum age 15 seconds for quoting; re-read immediately before execution |
| Oracle snapshot                    | Route-specific maximum, re-read before execution                         |
| Feasibility and funding evidence   | Revalidate before reservation, source close, target borrow, and payout   |
| Token metadata                     | Cache by chain, address, and observed bytecode hash                      |
| Chain receipt                      | Poll with bounded exponential backoff until finality or timeout          |
| NEAR registry view                 | Cache 5 seconds in UI; never cache write confirmation                    |

Every cached record retains provider, fetch time, chain, block number, block hash when available, schema version, and raw-response hash.

## Rate-limit and outage behavior

- Centralize provider access in backend adapters; browsers do not independently hammer public APIs.
- Coalesce identical in-flight reads.
- Apply per-provider token-bucket limits.
- Respect `Retry-After` and use jittered exponential backoff.
- Open a circuit breaker after repeated provider errors.
- Continue displaying the last known snapshot only when clearly marked stale.
- Disable quoting or execution when freshness requirements cannot be met.
- Never rotate silently to an unapproved RPC endpoint.

Morpho’s public API currently documents a standard limit of 750 requests per minute, which is well above the demonstration’s cached usage. Public EVM and NEAR RPCs remain rate-limited and have no SLA, so direct reads are batched where supported and minimized.

## Cost boundary

The software stack and data access can run without a paid subscription. The following are not free and must be treated separately:

- Gas for the real mainnet 1Click canary.
- The small real asset amount used by that canary.
- Any 1Click fee or price impact returned by the committed quote.
- Developer hardware and electricity for local Ollama inference.

NEAR testnet deployment uses test tokens. Local chains, simulators, PostgreSQL, Redis, Foundry, Rust, and Ollama are locally operated open tools.

## Implementation checklist

- [ ] Create typed provider interfaces and normalized response schemas.
- [ ] Implement official Base and Arbitrum RPC adapters.
- [ ] Implement Aave GraphQL discovery and direct-read verification.
- [ ] Implement Morpho REST discovery and direct-read verification.
- [ ] Implement 1Click catalog, dry quote, and isolated canary adapters.
- [ ] Implement NEAR testnet RPC failover.
- [ ] Add provider health, caching, rate limiting, and circuit breakers.
- [ ] Implement the canonical sources-and-uses feasibility analysis and exclusive cost-component
      classification.
- [ ] Implement direct capacity, confirmed-funding, required-borrow, and zero-shortfall tools with
      checkpoint revalidation.
- [x] Implement Route/Risk Agent tools and capability tests.
- [x] Implement deterministic, Ollama, and user-API explanation providers behind one interface.
- [x] Implement provider selection and memory-only credential UI.
- [x] Add API-key redaction, payload allowlisting, endpoint validation, and SSRF tests.
- [ ] Pin the model digest and document minimum resource expectations.
- [ ] Add stale, mismatch, outage, malformed-response, and rate-limit tests.
- [x] Demonstrate the full project without any paid API credentials.
