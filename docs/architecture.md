# Architecture overview

DebtShift separates deterministic financial authority from external execution and optional AI
wording.

```text
Browser wallet -> web -> API -> PostgreSQL/outbox -> worker
                            |                     |
                            |                     +-> mode-selected transport port
                            |                     +-> NEAR agreement registry
                            |                     +-> EVM adapters and verified receipts
                            +-> deterministic optimizer / financing analysis / risk validation
                            +-> Route/Risk Agent
```

PostgreSQL is the durable workflow source of truth. Redis and BullMQ provide at-least-once command
delivery only. Every phase is re-derived from signed terms and verified evidence. A provider status
or queue acknowledgement never proves a financial side effect.

The browser owns borrower signing. The API proposes exact EIP-712 payloads and validates returned
signatures. The worker can perform only the bounded actions permitted by the signed plan, runtime
mode, execution switch, and deployed contracts. AI providers receive a minimized, read-only explanation payload after route
selection and have no execution tools.

The solver-financing design uses a mandatory sources-and-uses proof. Maximum safe destination
borrowing is the minimum allowed by protocol collateral constraints, DebtShift stress policy,
available liquidity, and the signed target-debt cap. Temporary liquidity cannot be reserved unless
that capacity plus finalized migration-specific supplementary funding covers solver principal,
solver fees, and every financed cost with zero shortfall. The proof is revalidated before source
closure and target borrowing.

Source closure and destination borrowing occur on different chains and are not atomic. Contracts
enforce local custody and signed limits, but cannot guarantee future borrowing capacity or solver
repayment. Capacity deterioration after source closure enters a bounded recovery path and preserves
the exact collateral custody and solver receivable instead of creating an unsafe loan.

The authoritative detailed design lives in `strategies-docs/01-architecture-blueprint.md`.

Runtime providers are selected once at composition roots. `sandbox` uses deployed private-chain
contracts and an explicitly simulated external transport adapter. `testnet` uses public test
contracts and the NEAR testnet registry while retaining that labeled transport adapter.
`mainnet-readonly` constructs no write-capable workflow providers. `mainnet` requires direct Aave,
Morpho, oracle, official committed 1Click, and registry adapters plus the fail-closed server
execution switch. Core services import only provider ports, and lint rules reject simulator or
sandbox imports from production modules. The detailed rules are in
`strategies-docs/12-production-provider-boundaries.md`.
