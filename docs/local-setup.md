# Local setup

## JavaScript toolchain

Install Node.js 22.16.0 and npm 10.9.2, then run `npm ci`. Versions are pinned by `.nvmrc`,
`.node-version`, `package.json`, and `package-lock.json`.

## Full sandbox

Docker Compose v2 is required. Copy `.env.example` to `.env`, then run:

```sh
npm run infra:up
npm run smoke:local
```

`infra:up` builds and starts the complete stack: PostgreSQL, Redis, two seeded private chains, the
schema migration, API, durable worker, and web application. Do not also run `local:chains` or
`npm run dev` against the same ports. Local credentials and `SANDBOX_EXECUTOR_PRIVATE_KEY` are
public disposable Anvil fixtures; never replace them with funded keys.

## Hot-reload development

Use this topology when changing application code:

For the interactive application:

1. Run `npm run infra:dependencies` to start only PostgreSQL and Redis.
2. Apply the schema with `npm run db:migrate --workspace @debtshift/database`.
3. Run `npm run local:chains` in its own terminal. It keeps the seeded source and destination Anvil
   chains alive and prints the deployed fixture addresses.
4. Start `npm run dev` in another terminal.
5. Add `http://127.0.0.1:8545` (chain ID `31337`) to an EIP-1193 browser wallet and import Anvil's
   disposable account #1, whose address is printed as `borrower` by the launcher. Use this account
   only with local test assets.
6. Connect the wallet, review the position and route, sign the policy intent and exact plan, and
   follow the evidence timeline. The UI labels every transport observation as a DebtShift simulation.

The API re-reads the signed source snapshot at its historical block and at the current head before
accepting execution. The worker consumes the PostgreSQL transactional outbox through Redis/BullMQ
and rehydrates simulator poll state and mined contract events after restart. Production modes cannot
fall back to the sandbox adapters.

## EVM contracts

Install Foundry 1.9.0 and verify `forge --version` and `anvil --version`. The contract workspace is
`contracts/evm`. Never import a production private key into Anvil scripts.

Run `npm run demo:happy` to compile the contracts, start isolated chains `31337` and `31338`,
deploy and seed the local markets, execute the exact refinance, verify terminal balances, and stop
both chains. Run `npm run demo:recovery` to prove the deterministic transport-refund path and its
explicit outstanding vault receivable. These commands use only Anvil's well-known disposable keys.
`npm run test --workspace @debtshift/worker` additionally runs the durable PostgreSQL-compatible
outbox-to-worker workflow against dual Anvil whenever Anvil is installed.

## NEAR contract

Install Rust 1.95.0, add the `wasm32-unknown-unknown` target, and use near-sdk 5.30.1. The workspace
is `contracts/near`. Install cargo-near 0.23.0 and NASM 3.02 for native near-sdk tests. Testnet
credentials are supplied outside the repository when deployment begins.

On Windows, cargo-near ABI generation currently fails to link NEAR host symbols during its native
ABI step. The checked local/CI command therefore builds validated WASM with `--no-abi`. Resolving and
verifying generated ABI output remains mandatory before the registry milestone is complete; Linux
CI will be used to determine whether the limitation is host-specific.

## Environment modes

- `sandbox`: private-chain contracts and test assets; only the external transport boundary is
  explicitly simulated.
- `testnet`: public test contracts and NEAR testnet registry plus explicitly simulated transport.
- `mainnet-readonly`: public protocol reads and 1Click dry quotes; no write-capable workflow runtime.
- `mainnet`: the complete production refinance workflow, guarded by
  `MAINNET_EXECUTION_ENABLED=false` by default.

Local development and CI both select `DEBTSHIFT_MODE=sandbox`; they are engineering topologies, not
additional product modes. Production modes never fall back to sandbox providers. Do not set
`MAINNET_EXECUTION_ENABLED=true` without completing the documented release gates and obtaining
explicit financial authorization.
