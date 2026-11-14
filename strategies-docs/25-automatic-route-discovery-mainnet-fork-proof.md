# Automatic route discovery and mainnet-fork proof

## Objective

DebtShift must discover supported refinance routes without a hard-coded Morpho market ID, reject
unsafe or unverifiable candidates, rank the eligible candidates deterministically, and execute the
selected candidate against pinned mainnet forks without moving real funds. Mainnet broadcasting
remains disabled.

This proof has two independently verifiable outputs:

1. a discovery report containing every inspected, rejected, eligible, and selected candidate; and
2. a fork-execution report proving the selected Aave source and Morpho destination legs with only
   the unavailable local 1Click settlement boundary explicitly simulated.

## Security boundary

Automatic discovery is bounded, not permissionless execution:

- supported source and destination chains and protocol deployments come from a reviewed registry;
- Aave positions and Morpho market parameters are re-read from pinned chain state;
- Morpho's public REST API is discovery-only and never execution authority;
- 1Click's catalog determines provider asset identity and dry quotes determine analysis terms;
- the selected market must have matching onchain parameters, code, price, liquidity, and an
  approved oracle policy;
- an unknown chain, token, oracle, IRM, market shape, provider status, or stale observation is a
  rejection, never a fallback;
- AI providers may explain the deterministic comparison but cannot add, score, select, sign, or
  execute a candidate;
- `MAINNET_EXECUTION_ENABLED` stays `false`; fork RPCs and test-only impersonation are never valid
  production execution capabilities.

## Discovery pipeline

1. Read the connected wallet's supported Aave deployment at one canonical source block.
2. Enumerate Aave reserves and retain positive collateral and variable-debt balances.
3. Reject unsupported multi-collateral, multi-debt, stable-rate, paused, frozen, or stale source
   positions until an explicit aggregation policy exists.
4. Load the official 1Click asset catalog and resolve exact provider asset IDs by chain and token
   address, never by symbol alone.
5. Page through Morpho's listed markets on each supported destination chain.
6. Filter to exact destination loan/collateral assets that have compatible 1Click routes.
7. Re-read each candidate market from its configured Morpho singleton and verify the market ID from
   loan token, collateral token, oracle, IRM, and LLTV.
8. Verify bytecode, positive oracle price, destination liquidity, current/projected borrow rate,
   pinned block identity, and approved oracle/IRM policy.
9. Obtain analysis-only 1Click quotes when credentials permit. The fork proof uses a deterministic
   quote fixture bound to the live catalog identities because a provider cannot observe local fork
   transactions.
10. Build normalized route candidates and run the existing deterministic optimizer.
11. Persist the complete comparison, rejection codes, selection, source data hashes, blocks, and
    route-discovery hash.

## Deterministic selection

Candidates first pass hard gates for exact assets, adapter support, transport minimum, financing
reconciliation, available liquidity, data freshness, normal LTV, stressed LTV, cost cap, and minimum
APR improvement. Eligible candidates are ordered by:

1. highest risk-adjusted net benefit in USD micro-units;
2. highest stressed net benefit;
3. lowest projected post-refinance APR; and
4. lexicographically smallest candidate ID as the stable final tie-breaker.

The selected candidate is not an execution authorization. Execution revalidates the signed market,
amounts, receivers, quotes, deadline, liquidity, oracle, and source position.

## Mainnet-fork proof

The proof uses two disposable Anvil forks pinned by block number and hash:

- source: the discovered Aave V3 deployment;
- destination: the selected Morpho Blue deployment and market.

The proof must:

1. create a test-only borrower and assign native gas only inside the forks;
2. open and observe the source Aave position against unmodified mainnet protocol bytecode;
3. run discovery against the pinned source/destination state;
4. assert the optimizer selected the candidate subsequently executed;
5. deploy DebtShift contracts only inside the forks;
6. close the Aave position using the selected plan;
7. simulate 1Click by releasing the exact source escrow collateral and assigning only the quoted
   minimum destination amount to the destination escrow;
8. open and observe the selected Morpho position using the onchain-discovered market parameters;
9. settle the source vault and prove zero unexplained balances and allowances;
10. emit a JSON report with blocks, hashes, market parameters, candidate rankings, local fork
    transaction hashes, balance reconciliation, and an explicit `SIMULATED_1CLICK_BOUNDARY` label.

Fork transaction hashes are local evidence and must never be linked to public explorers or described
as mainnet receipts.

## Implementation order

- [x] Add schemas for bounded discovery inputs and evidence.
- [x] Add Aave reserve/position enumeration with strict single-pair support.
- [x] Add a validated Morpho REST discovery client with pagination and response-size/time limits.
- [x] Add exact 1Click catalog asset resolution.
- [x] Add onchain market verification and normalized candidate construction.
- [x] Integrate discovered candidates with the deterministic Route/Risk Agent.
- [x] Add unit tests for pagination, duplicates, malformed data, unsupported assets, and stable
      ordering.
- [x] Add a pinned dual-fork selected-route proof and JSON evidence generator.
- [ ] Run formatting, lint, type checks, unit/integration tests, fork proof, and CI.
- [x] Record the final evidence paths, block hashes, and limitations here.

## Completed proof evidence

The dual-fork proof passed on 2026-11-14 and wrote
[`deployment/evidence/mainnet-fork-route-discovery-proof-20261114.json`](../deployment/evidence/mainnet-fork-route-discovery-proof-20261114.json).

- Base fork origin: block `57,337,544`, hash
  `0x066aa433204d6be6d8e135dee325166c1dc58ba7e59bf102a5ceca020d1dff8b`.
- Arbitrum fork origin: block `524,148,205`, hash
  `0x0041505c810e4826bf4b395e1347aef56040637b0a9bde9d02d3d98dfbe1f0d0`.
- Morpho discovery inspected the one listed native-USDC/WETH market in the bounded Arbitrum
  universe and selected market
  `0xca83d02be579485cc10945c9597a6141e772f1cf0e0aa28d09a327b6cbd8642c`.
- The source Aave APR was `690` bps. The projected target APR was `379` bps after rate impact,
  producing a positive 90-day risk-adjusted score of `7,668,553` USD micro-units.
- The proof closed the source Aave position, opened the selected Morpho position with
  `9.99 WETH` collateral and `1,000.007970 USDC` debt, settled the source vault, and observed zero
  residual token balances across the checked destination contracts.
- The live 1Click catalog was verified for the four exact asset IDs. Only cross-chain delivery was
  simulated and is labeled `SIMULATED_1CLICK_BOUNDARY` in the evidence.
- The proof used a deterministic test-only key and locally assigned balances. No real key, funds,
  or mainnet transaction was used, and `mainnetExecutionEnabled` is `false`.

The Anvil forks snapshot their upstream latest blocks at startup and remain immutable for the proof.
The exact origins are therefore evidence-pinned per run rather than requiring a paid archival RPC.
The local transaction hashes in the report are reproducible execution evidence but are not public
explorer receipts.

## Completion criteria

- No production candidate depends on a hard-coded market ID.
- Discovery returns more than one inspected candidate or records why the live bounded universe has
  only one compatible candidate.
- Every candidate has provenance and every rejection has a machine-readable reason.
- Reordering provider results does not change the selected route.
- A provider/API disagreement with onchain state rejects the candidate.
- The fork execution uses the exact selected candidate and completes with reconciled balances.
- The proof works without a private key, real token balance, committed 1Click quote, or mainnet
  transaction.
- Mainnet execution remains disabled.
