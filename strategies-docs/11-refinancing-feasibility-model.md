# Refinancing feasibility and funding model

## Purpose

This document defines the mandatory sources-and-uses check for every solver- or vault-financed
DebtShift migration. It is the canonical specification for determining whether the destination
position and secured supplementary funds can repay the temporary liquidity provider without
violating protocol constraints or DebtShift risk policy.

Passing a destination LTV or health-factor check is necessary but not sufficient. A route is not
executable unless every settlement obligation has a confirmed funding source and the calculated
funding shortfall is zero before temporary liquidity is committed.

## Non-negotiable feasibility invariant

For one debt asset on one settlement chain:

**Maximum Safe Borrowing Capacity + Confirmed External Funding >= Total Required Repayment and
Financed Costs**

The equivalent executable-borrow condition is:

```text
requiredDestinationBorrow <= maximumSafeBorrowingCapacity
fundingShortfall = 0
```

The invariant is evaluated with integer token base units. USD values may be used for display and
cross-route comparison, but never authorize borrowing, escrow release, or solver payout.

## Canonical variables

| Symbol                                     | Name                                   | Definition                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D_source`                                 | Existing debt payoff                   | Principal plus accrued interest and any protocol-required repayment amount at the execution block.                                                                           |
| `P_borrower`                               | Borrower debt prepayment               | Borrower funds applied directly to reduce `D_source` before calculating the temporary advance.                                                                               |
| `C_transport`, `C_protocol`, `C_execution` | Cost components                        | Cross-chain transfer costs, lending/protocol transaction costs, and other execution costs. Each component is assigned exactly one financing classification below.            |
| `C_advanced`                               | Solver-advanced execution costs        | Approved costs actually advanced by the solver or test vault and therefore included in its principal receivable.                                                             |
| `P_solver`                                 | Solver principal                       | `max(0, D_source - P_borrower) + C_advanced`.                                                                                                                                |
| `F_solver`                                 | Solver fee                             | Exact fee owed to the temporary liquidity provider, bounded by both intent and execution plan.                                                                               |
| `C_capitalized`                            | Other capitalized costs                | Approved transport, protocol, gas, or execution costs paid from destination-loan proceeds and not already included in `P_solver` or `F_solver`.                              |
| `C_separate`                               | Separately paid costs                  | Costs paid outside the destination loan and outside solver repayment. They affect route economics but not the borrowing requirement.                                         |
| `R_total`                                  | Total repayment and financed costs     | `P_solver + F_solver + C_capitalized`.                                                                                                                                       |
| `E_confirmed`                              | Confirmed external funding             | Settlement-asset funds already finalized in a migration-specific escrow and authorized for the exact payout. It excludes `P_borrower`, which has already reduced `D_source`. |
| `V_collateral`                             | Available destination collateral value | Conservative value of the minimum collateral expected to finalize at the destination after transport minimums, oracle validation, and configured price haircuts.             |
| `B_protocol`                               | Protocol collateral capacity           | Maximum debt permitted by the destination protocol from the conservative delivered collateral and protocol parameters.                                                       |
| `B_policy`                                 | DebtShift policy capacity              | Maximum debt permitted by DebtShift's stricter stressed LTV or health-factor policy.                                                                                         |
| `B_liquidity`                              | Safe market liquidity                  | Amount currently borrowable after DebtShift's configured liquidity reserve and execution buffer.                                                                             |
| `B_signed`                                 | Signed target-debt cap                 | Maximum destination debt authorized by the borrower for this plan.                                                                                                           |
| `B_safe`                                   | Maximum safe borrowing capacity        | Minimum of `B_protocol`, `B_policy`, `B_liquidity`, and `B_signed`, after all configured conservative buffers.                                                               |
| `B_required`                               | Required destination borrowing         | `max(0, R_total - E_confirmed)`.                                                                                                                                             |
| `S_shortfall`                              | Funding shortfall                      | `max(0, R_total - (B_safe + E_confirmed))`.                                                                                                                                  |
| `HF_post` / `LTV_post`                     | Expected post-state safety             | Protocol-native safety result after borrowing `B_required`.                                                                                                                  |
| `HF_stress` / `LTV_stress`                 | Stressed safety                        | Safety result after configured collateral-price, rate, and execution-drift stresses.                                                                                         |

## Sources-and-uses classification

Every cost line has one and only one financing classification:

1. Included in solver principal because the solver advances it.
2. Solver fee.
3. Capitalized separately into the destination loan.
4. Paid separately and excluded from the destination loan.
5. Borrower debt prepayment that reduces the source payoff before the solver draw.
6. Confirmed external settlement funding held in escrow.

The analysis engine rejects duplicate component identifiers, overlapping classifications, negative
amounts, asset or chain mismatches, and any total that does not reconcile to the component ledger.
`C_advanced` and `C_capitalized` are sums of the individually identified transport, protocol, and
execution cost components assigned to those classifications. Components assigned to `C_separate`
are summed separately.
`C_separate` remains part of all-in economics and break-even analysis, but it is not added to
`R_total`. A cost already included in `P_solver` must not also appear in `C_capitalized`.

`R_total`, `E_confirmed`, `B_safe`, and `B_required` use the destination debt and settlement asset.
A cost payable in another token cannot be added across unlike base units: it must either be paid
separately in that token or use an exact, signed, deadline-bound conversion quote whose settlement-
asset input is classified once. The component ledger retains both token amounts and conversion
provenance.

## Maximum safe borrowing capacity

Capacity uses the minimum collateral expected to arrive at the destination, not an optimistic
source-chain balance. The value includes signed transport minimums, token decimal verification,
oracle freshness, price haircuts, and any collateral reserved for protocol or recovery needs.

### Morpho-style LTV market

```text
B_protocol = stressedCollateralValue * protocolLLTV
B_policy   = stressedCollateralValue * debtShiftMaximumLTV
```

`debtShiftMaximumLTV` must be strictly no greater than the protocol limit and normally includes an
additional buffer. The calculation preserves Morpho's native oracle scale and market parameters.

### Aave-style health-factor market

`B_protocol` and `B_policy` are solved from the protocol liquidation threshold and the configured
minimum post-migration and stressed health factors. The policy capacity is the greatest debt for
which both `HF_post` and `HF_stress` remain at or above their respective minimums.

### Liquidity and signed limits

Collateral capacity does not imply available cash. `B_liquidity` is based on execution-time market
liquidity after the configured reserve, concurrent-use, and quote-drift buffers. The borrower may
authorize less debt than the market permits, so `B_signed` is also a hard upper bound.

```text
B_safe = min(B_protocol, B_policy, B_liquidity, B_signed)
```

The exact calculation inputs, block, block hash, oracle update, configuration version, and expiry
form the feasibility evidence. A route with stale or incomplete inputs is ineligible.

## Minimum acceptable destination-loan conditions

Immediately before target borrowing, all of the following must hold:

- `B_required <= B_safe` using fresh finalized collateral, oracle, parameter, and liquidity reads;
- the target debt does not exceed the execution plan's exact debt cap;
- the expected and simulated loan proceeds, together with `E_confirmed`, fund every solver and
  capitalized-cost use after protocol deductions and rounding;
- post-state and stressed LTV or health-factor metrics satisfy the signed DebtShift limits;
- the projected rate and any rate-impact cap remain within the signed plan;
- the lending transaction simulation returns the expected market, asset, receiver, and minimum
  proceeds; and
- the feasibility evidence, funding evidence, quote, and execution authorization have not expired.

If any condition fails, the destination adapter is not called. After source closure, this failure is
a recovery event rather than permission to increase debt, weaken safety policy, or assume future
liquidity.

## Supported shortfall resolutions

### A. Borrower-funded fees or supplementary settlement funding

The borrower deposits the exact settlement asset into migration-specific escrow before solver or
vault reservation. Finalized balance evidence, depositor, asset, chain, amount, authorized use,
refund receiver, and deadline are bound to the execution plan. An unsigned wallet balance or a
promise to transfer later is not `E_confirmed`.

### B. Debt capitalization

Approved solver fees or execution costs may be included in `B_required` only when the resulting
borrow remains within `B_safe`, all post-state and stress limits pass, and the borrower signs the
capitalized amount. Capitalization is not a mechanism for bypassing a capacity shortfall.

### C. Borrower-funded partial debt repayment

The borrower may repay part of the source debt before the solver draw. Finalized source-protocol
evidence establishes `P_borrower` and the source debt is read again. The solver principal is then
calculated from the reduced payoff. The prepayment must never also be counted as external settlement
funding.

### D. Migration rejection

If `S_shortfall > 0`, supplementary funds are absent or unconfirmed, or any safety condition fails,
DebtShift rejects or expires the plan before solver commitment and before source closure. The system
does not rely on future deposits, speculative price appreciation, expected liquidity, or unsecured
borrower promises.

## Worked examples

Assume the destination's already-buffered safe borrowing capacity is exactly `10,000 USDC`, the
source payoff is `10,000 USDC`, no other costs apply, and the solver fee is `100 USDC`.

### Rejected: unresolved shortfall

```text
D_source       = 10,000 USDC
P_borrower     =      0 USDC
P_solver       = 10,000 USDC
F_solver       =    100 USDC
C_capitalized  =      0 USDC
R_total        = 10,100 USDC
E_confirmed    =      0 USDC
B_safe         = 10,000 USDC
B_required     = 10,100 USDC
S_shortfall    =    100 USDC
```

The route is rejected. Borrowing `10,100 USDC` would exceed safe capacity, while borrowing
`10,000 USDC` would leave the solver underpaid by `100 USDC`.

### Valid: borrower secures the fee

```text
R_total        = 10,100 USDC
E_confirmed    =    100 USDC in migration escrow
B_safe         = 10,000 USDC
B_required     = 10,000 USDC
S_shortfall    =      0 USDC
```

The destination borrow supplies `10,000 USDC`, escrow supplies `100 USDC`, and the settlement
escrow pays the solver exactly `10,100 USDC`. This route is valid only while the borrow still passes
the signed post-state and stress limits at execution.

### Valid alternative: capitalized fee

If fresh execution-time state yields `B_safe >= 10,100 USDC`, the borrower may sign a
`10,100 USDC` destination debt cap and capitalize the fee. `B_required` is `10,100 USDC` and the
route remains valid only if liquidity and stressed safety checks also pass.

## Mandatory workflow and checkpoints

1. Read the accrued source debt, collateral, and ownership state at a recorded block.
2. Read destination collateral parameters, oracle state, liquidity, rate model, and borrowing limits.
3. Build the reconciled sources-and-uses ledger and calculate solver principal, fee, financed costs,
   and separately paid costs.
4. Calculate `B_protocol`, `B_policy`, `B_liquidity`, `B_signed`, and `B_safe`.
5. Calculate `B_required` and `S_shortfall`.
6. Select a supported resolution and obtain finalized evidence for debt prepayment or supplementary
   escrow funding. Recalculate until `S_shortfall = 0`.
7. Validate post-migration and stressed safety, rate impact, quote expiry, and complete settlement
   coverage.
8. Have the borrower sign the intent and exact execution plan, including the financing structure.
9. Revalidate source payoff, funding evidence, destination capacity, and quote validity; only then
   reserve solver or test-vault principal and execute source closure.
10. After collateral delivery, revalidate capacity before target borrowing. Borrow only the signed
    `B_required` or less when the complete payout remains funded.
11. Combine authorized destination proceeds and secured supplementary funds in settlement escrow,
    pay the exact solver obligation, and verify source, destination, payout, residual, and ledger
    evidence before `SETTLED`.

## Asynchronous execution and capacity deterioration

Cross-chain source closure, transport, destination opening, and payout are not one atomic
transaction. Smart contracts can enforce custody and bounded actions on each chain, but they cannot
guarantee that destination prices, liquidity, rates, or risk parameters remain unchanged.

The execution plan therefore contains capacity and price buffers, minimum delivered collateral,
maximum destination debt, minimum safety metrics, a quote expiry, and a final execution deadline.
Revalidation occurs:

- before solver reservation;
- immediately before source closure;
- after finalized destination delivery and before target borrow; and
- before solver payout and settlement finalization.

If capacity falls before source closure, DebtShift releases reservations and rejects or requotes the
plan. If capacity falls after source closure, the orchestrator must not create an unsafe loan. It may
use only preauthorized and already secured supplementary funding, an authorized smaller borrow that
still covers the complete obligation, a bounded wait within the signed deadline, or a signed
recovery/unwind path. Otherwise it holds or returns collateral under the recovery policy, records the
solver receivable and custody precisely, and terminates `FAILED_SAFE` when no safe forward path
exists.

`FAILED_SAFE` means custody and residual claims are known; it does not mean the solver has been
repaid or has no economic loss. Per-route and aggregate exposure limits bound, but do not eliminate,
the temporary liquidity provider's residual risk.

## Component responsibilities

- **Refinancing analysis engine:** constructs the component ledger, calculates capacity, required
  borrowing, shortfall, economics, and resolution alternatives.
- **Risk validation service:** independently re-derives the zero-shortfall and safety predicates from
  fresh direct reads at every checkpoint.
- **Solver quote evaluation:** rejects quotes whose principal, fee, asset, deadline, or payout terms
  cannot be fully covered by the signed financing structure.
- **Funding authorization and escrow:** proves borrower contributions are finalized, isolated by
  migration, and spendable only for the signed settlement or refund path.
- **Cross-chain orchestrator:** does not reserve liquidity or close the source until the financing
  evidence is complete; after source closure it selects only signed forward or recovery actions.
- **Destination lending adapter:** enforces target market identity, debt cap, current liquidity,
  safety metrics, payout receiver, and exact proceeds delivered to settlement escrow.
- **Settlement and recovery state machine:** requires exact solver payout and balanced ledger evidence
  for `SETTLED`; otherwise it retains an explicit receivable and recovery case.

## Required signed and persisted evidence

The execution plan or its canonical financing hash binds:

- source payoff and borrower prepayment;
- solver principal, fee, payout asset, chain, and receiver;
- every financed and separately paid cost component;
- external funding amount, escrow identity, deposit evidence, and refund terms;
- required destination borrow and signed debt cap;
- capacity inputs, safety limits, buffers, block provenance, and expiry;
- zero-shortfall result and the authorized recovery sources.

Persistence retains each feasibility calculation and revalidation as append-only evidence. A newer
failed revalidation supersedes an earlier passing quote for execution purposes; history is never
deleted.
