# Production and sandbox provider boundaries

## Purpose

DebtShift implements one production-oriented refinance workflow and supplies environment-specific
adapters. The sandbox is a contract-backed test implementation of those ports; it is not a second
workflow and cannot be selected as a fallback when production providers fail.

## Runtime modes

`DEBTSHIFT_MODE` is required and accepts exactly:

| Mode               | Market/protocol adapters                                | Transport                       | Write capability                          |
| ------------------ | ------------------------------------------------------- | ------------------------------- | ----------------------------------------- |
| `sandbox`          | Private local-chain test deployments                    | Receipt-producing simulator     | Test assets only                          |
| `testnet`          | Public testnet deployments                              | Receipt-producing simulator     | Test assets only                          |
| `mainnet-readonly` | Official production reads                               | Official catalog and dry quotes | None                                      |
| `mainnet`          | Official production protocols and DebtShift deployments | Official committed 1Click flow  | Requires `MAINNET_EXECUTION_ENABLED=true` |

Local development and CI use ephemeral `sandbox` composition. Invalid mode/provider combinations
fail at startup. There are no `mainnet-canary` or `mainnet-controlled` modes.

## Core ports and composition

Application handlers depend only on:

- `SourceExecutionPort`;
- `LiquidityReservationPort`;
- `TransportPort`;
- `DestinationExecutionPort`;
- `SettlementPort`;
- `ChainEvidencePort`;
- `ReceiptRegistryPort`.

The core workflow owns command ordering, evidence predicates, retries, phase derivation, recovery,
and ledger requirements. Adapters own provider-specific request construction, broadcasting, raw
response validation, and receipt normalization.

Required code boundaries:

- simulator modules may implement ports but cannot be imported by core handlers or production
  adapters;
- only composition roots import concrete adapters;
- `mainnet-readonly` does not construct write ports or irreversible handlers;
- `mainnet` never falls back to sandbox fixtures, providers, addresses, or outcomes;
- every migration persists its mode, provider identity, adapter version, route configuration hash,
  and deployment-manifest hash.

## Contract-backed sandbox behavior

The hosted/developer sandbox uses two private EVM chains and actual deployed token, lending, vault,
adapter, and escrow contracts. Wallet signatures, nonces, transactions, events, receipts, balances,
reverts, database records, outbox commands, restarts, target borrowing, settlement, and refunds are
real within those chains.

Only the external cross-chain provider is simulated. Its rules are:

- it cannot report deposit without a finalized origin transaction and expected balance/custody;
- delivery executes a real destination-chain release transaction;
- refund executes a real source-chain recovery transaction;
- returned observations contain the actual transaction hashes and amounts;
- independent workflow code rechecks receipts, blocks, tokens, receivers, and balance deltas;
- delays, incomplete delivery, wrong receiver, refund, unknown status, and custody failures remain
  configurable for testing.

An application-level fixture that returns success without chain state is not an acceptable sandbox
implementation.

## Testnet boundary

Testnet uses public RPCs, deployed contracts, real test-token transactions, relayer nonces/gas,
confirmation depths, explorer links, and the NEAR testnet registry. Because official 1Click has no
public testnet, the transport port remains the explicitly labelled simulator and must still produce
real source/destination testnet transaction evidence where the configured test contracts permit it.

Protocol-compatible test deployments validate orchestration and deployment, not official Aave or
Morpho production behavior. Official behavior is separately proven with pinned production forks.

## Live deployment registry

The versioned, schema-validated live registry supplies every production identity explicitly:

- source/destination chain IDs and RPC endpoints;
- Aave pool, protocol data provider, source reserve, collateral aToken, and debt token;
- source adapter, vault, source escrow, relayer, and recovery-reserve custodian;
- exact collateral/debt token addresses, decimals, symbols, and 1Click asset IDs;
- Morpho singleton, market parameters/ID, oracle, IRM, LLTV, target module, destination adapter, and
  destination escrow;
- Chainlink feeds, maximum age, and optional L2 sequencer feeds;
- solver payout, cost, residual, provider refund, and registry receivers;
- principal, collateral, debt, fee, slippage, gas, deadline, capacity-buffer, and recovery-exposure
  limits;
- EVM bytecode hashes, NEAR WASM hash/account, and source commit.

There are no implicit production address defaults. Startup checks RPC chain IDs, bytecode hashes,
token metadata, Morpho market reconstruction, oracle identity/freshness, contract roles/pause state,
vault/recovery balances, and receiver ownership.

## Mainnet-readonly behavior

This mode performs no signing or broadcasting:

1. Read the Aave position/reserve at a canonical source block.
2. Fetch the official 1Click token catalog and authenticated `dry: true` quotes.
3. Read the exact Morpho market, liquidity, rate, oracle, and projected post-borrow state at a
   canonical destination block.
4. Validate Chainlink rounds, positivity, freshness, and optional sequencer recovery grace.
5. Calculate gas and transport costs from base units and direct price feeds.
6. Run deterministic route, stress, and zero-shortfall analysis.
7. Construct a readiness report without a committed quote or executable migration.

Provider USD fields remain display-only. Unavailable or stale production data fails closed and never
activates sandbox values.

## Mainnet behavior

`mainnet` supplies the complete production adapter set:

1. Reserve the permissioned vault and recovery guarantee.
2. Revalidate and close the Aave source position through the signed source adapter.
3. Obtain/validate the committed official 1Click quote and release only the authorized collateral
   to its bound deposit address.
4. Poll strict provider states and independently verify origin, destination, or refund receipts.
5. Revalidate the target market and open the exact Morpho position through temporary native
   authorization.
6. Atomically pay solver principal/fee/costs and return borrower residuals.
7. Reconcile the ledger and register the final receipt through the configured registry.

`MAINNET_EXECUTION_ENABLED=false` is the default and blocks steps that can create side effects. It
still permits configuration checks, transaction construction, `eth_call`/gas simulation, and the
readiness report. The value is server-side and restart-bound. `true` is accepted only in `mainnet`
and does not bypass signatures, funding, freshness, idempotency, roles, pauses, or policy limits.

## Official 1Click boundary

The client is pinned to the official HTTPS origin, rejects URL credentials/redirect escape, applies
timeouts and response limits, and validates/persists raw responses before normalization.

- `mainnet-readonly`: catalog and `dry: true` quote methods only.
- `mainnet`: committed quote, deposit binding/submission, status, refund, and terminal receipt
  operations required by the complete workflow.
- sandbox/testnet: no production 1Click calls and no invented testnet URL.

Provider success is insufficient. Destination token, amount, receiver, transaction, confirmations,
block canonicality, and balance delta must independently match the signed quote/plan.

## Verification gates

- Mode matrix and configuration mutation tests.
- Proof that core/production modules cannot import simulator code.
- Proof that `MAINNET_EXECUTION_ENABLED=false` blocks every irreversible API/worker command.
- Contract-backed sandbox happy, refund, timeout, incomplete, mismatch, reorg, crash/restart, and
  market-deterioration tests.
- Public testnet deployment and transaction smoke tests.
- Pinned production Aave/Morpho fork tests through the real adapters.
- Official 1Click schema fixtures, dry-quote smoke, strict unknown-status, retry, timeout, rate-limit,
  and circuit-breaker tests.
- Mainnet deployment with writes disabled, verified manifests/roles/balances, and successful
  non-broadcast simulation of every intended call.
- Explicit owner approval before the final small real attempt; immediate switch-off and preserved
  completion/recovery evidence afterward.
