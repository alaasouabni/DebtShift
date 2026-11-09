# Architecture overview

DebtShift separates deterministic financial authority from external execution and optional AI
wording.

```text
Browser wallet -> web -> API -> PostgreSQL/outbox -> worker
                            |                     |
                            |                     +-> EVM adapters and verified receipts
                            |                     +-> transport simulator / isolated 1Click client
                            |                     +-> NEAR agreement registry
                            +-> deterministic optimizer and Route/Risk Agent
```

PostgreSQL is the durable workflow source of truth. Redis and BullMQ provide at-least-once command
delivery only. Every phase is re-derived from signed terms and verified evidence. A provider status
or queue acknowledgement never proves a financial side effect.

The browser owns borrower signing. The API proposes exact EIP-712 payloads and validates returned
signatures. The worker can perform only the bounded test actions permitted by the signed plan and
deployed contracts. AI providers receive a minimized, read-only explanation payload after route
selection and have no execution tools.

The authoritative detailed design lives in `strategies-docs/01-architecture-blueprint.md`.
