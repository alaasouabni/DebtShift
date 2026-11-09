# Product scope

## Objective

Build a reproducible DebtShift demonstrator in which a borrower can inspect an existing collateralized loan, compare refinancing routes, sign a bounded authorization, execute a multi-stage refinance with test assets, and inspect independently verified receipts and recovery outcomes.

The first release is a complete engineering demonstration, not a production custody or public mainnet product.

## Hybrid proof strategy

The first release contains two deliberately separate demonstrations:

1. **Complete refinance demonstration:** local/fork-validated Aave-to-Morpho workflow using test assets and the deterministic transport simulator.
2. **Live NEAR Intents proof:** one tightly capped production 1Click transfer between team-controlled wallets, with no lending position, solver financing, or automated debt refinance.

The product and README must never imply that the live canary is a complete mainnet refinance. Its purpose is to prove genuine 1Click quote, deposit, status, delivery, and receipt handling.

## Primary user journey

1. Connect an EVM wallet.
2. Discover a source lending position containing one supported collateral and one supported debt asset.
3. Display current debt, collateral, APR, safety metric, and snapshot block.
4. Compare at least two target route outcomes using deterministic cost and risk calculations.
5. Select a route and review exact amounts, recipients, fees, deadlines, and risk limits.
6. Sign a bounded refinance intent and final execution plan.
7. Reserve temporary repayment liquidity from the test vault.
8. Close the source debt and move released collateral into the authorized transport path.
9. Route the collateral through a 1Click-compatible simulator.
10. Supply the delivered collateral to the target market and open the replacement debt position.
11. Repay the temporary funding obligation and reconcile residual balances.
12. Record the evidence bundle in the application and its hash in the NEAR registry.
13. Display a complete, ordered timeline with transaction and receipt details.

## Required failure journey

The demo must also execute a route in which the transport fails or refunds after the source position has been closed. The system must:

1. Detect the terminal provider outcome.
2. Verify the actual custody and balance of the returned collateral.
3. Enter `RECOVERY` without declaring the migration successful.
4. Execute the configured test recovery policy.
5. End in either `COMPLETED` after a successful alternative settlement or `FAILED_SAFE` with residual claims and custody recorded.

## Initial supported route

The initial route is intentionally narrow:

- Source network: local Base-like EVM chain.
- Source protocol: Aave V3-compatible market.
- Destination network: local Arbitrum-like EVM chain.
- Destination protocol: Morpho Blue-compatible market.
- Debt asset: USDC-like six-decimal test token on both chains.
- Collateral asset: WETH-like eighteen-decimal test token on both chains.
- Financing: pre-funded test liquidity vault.
- Transport: deterministic 1Click-compatible simulator.

The real-token and live-network catalog must be discovered at runtime. Symbols alone never identify an asset.

## In scope

- Next.js borrower dashboard.
- NestJS REST API and server-sent migration updates.
- EVM wallet authentication and EIP-712 signing.
- Position and market snapshots with block provenance.
- Deterministic quote economics and route ranking.
- PostgreSQL durable state and append-only audit events.
- Transactional outbox and at-least-once job processing.
- Redis-backed background job delivery.
- Source and destination EVM adapters.
- Per-migration escrow and test liquidity vault.
- 1Click-compatible transport simulator.
- Production 1Click token discovery and `dry: true` quotes behind an explicit mainnet-read-only configuration mode.
- One manually enabled production 1Click canary using one allowlisted route, a fixed base-unit input cap, and team-controlled recipient and refund wallets.
- NEAR receipt and attestation registry.
- Foundry unit, fuzz, invariant, and pinned fork tests.
- Local happy-path, refund, timeout, replay, and worker-restart tests.
- Docker-based local environment and reproducible demo scripts.
- Metrics, structured logs, health checks, and evidence inspection.
- Deterministic Route/Risk Agent tools for position analysis, route comparison, risk checks, and intent preparation.
- Optional natural-language explanations through either a user-supplied AI API or local Ollama, with a deterministic template fallback.

## Out of scope for the first release

- Real-fund mainnet lending transactions, solver advances, or complete debt refinancing.
- General-purpose or unattended mainnet 1Click execution beyond the single canary policy.
- Any claim that the simulated transport is a 1Click testnet deployment; no public 1Click testnet exists.
- Public solver marketplace or permissionless liquidity.
- Legal enforcement of solver credit agreements.
- Multi-collateral or multi-debt source positions.
- Fee-on-transfer, rebasing, yield-bearing wrapper, or non-standard ERC-20 assets.
- Arbitrary chain and protocol combinations.
- Automatic liquidation protection during an unbounded transport delay.
- Governance token, DAO, fee distribution, or protocol revenue.
- Unattended execution using stored borrower keys.
- Claims of trustless verification of EVM events by the NEAR registry.
- Any authority for an LLM to sign, broadcast, reserve liquidity, select a receiver, or override deterministic risk policy.
- Persistent storage or logging of a user-supplied AI API key.

## Functional acceptance criteria

- A new developer can start the complete local stack from documented commands.
- Seed scripts create a borrower source position and fund the test liquidity vault.
- The UI returns at least two deterministic route comparisons.
- Changing a signed chain, market, token, amount, receiver, fee, nonce, or deadline invalidates authorization.
- Repeated execute requests do not duplicate any asset movement.
- A worker crash at every irreversible boundary can resume from persisted evidence.
- A successful transport status alone cannot advance the migration to target-open or completed.
- The source and destination position reads prove the before and after states.
- The ledger balances by migration, chain, token, and financing party.
- The NEAR registry contains the same final evidence hash displayed by the application.
- The failure scenario visibly reaches `RECOVERY` and never reports success incorrectly.
- The UI and documentation clearly label simulator-backed delivery receipts as simulated rather than testnet 1Click transactions.
- The live canary displays the real 1Click correlation/status data and independently verified origin and destination receipts.
- The live canary cannot call lending adapters or draw from the liquidity vault.

## Non-functional acceptance criteria

- Deterministic tests use pinned timestamps, block heights, token metadata, and rate fixtures.
- No secret is committed to source control or printed in logs.
- Contract permissions are bounded by migration, token, amount, receiver, nonce, and deadline.
- Database writes that schedule work use a transactional outbox.
- Application logs contain correlation ID, migration ID, phase, command ID, and chain when applicable.
- All externally supplied addresses and integer strings are schema-validated.
- Unknown transport states and unexpected contract events create an operator-visible exception.
- Live canary execution requires an explicit user confirmation after the committed quote is displayed.
- Live canary policy is enforced using token base units, not provider-supplied USD display fields.

## Product terminology

- **Intent:** the borrower’s policy limits and allowed target scope.
- **Execution plan:** the exact, short-lived route bound to provider and recipient details.
- **Quote:** an economic projection and exact execution terms valid until a deadline.
- **Migration:** one immutable attempt to execute a signed plan.
- **Evidence:** a verified observation supporting a state transition.
- **Command:** a requested external side effect with a stable idempotency key.
- **Receipt bundle:** the canonical set of evidence hashes used to finalize a migration.
- **Completed:** financial settlement and final receipt registration have both succeeded.
