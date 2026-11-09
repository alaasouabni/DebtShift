# Local setup

## JavaScript toolchain

Install Node.js 22.16.0 and npm 10.9.2, then run `npm ci`. Versions are pinned by `.nvmrc`,
`.node-version`, `package.json`, and `package-lock.json`.

## Infrastructure

Docker Compose v2 is required. Copy `.env.example` to `.env`, then run `npm run infra:up`. Local
credentials in the example file are for disposable development services only.

Apply the checked-in schema with `npm run db:migrate --workspace @debtshift/database` before starting
the API or worker. The worker consumes the PostgreSQL transactional outbox through Redis/BullMQ and
rehydrates simulator poll state and mined contract events after restart. `LOCAL_EXECUTOR_PRIVATE_KEY`
in `.env.example` is Anvil's public disposable deployer key; never replace it with a funded key.

For the interactive application:

1. Run `npm run local:chains` in its own terminal. It keeps the seeded source and destination Anvil
   chains alive and prints the deployed fixture addresses.
2. Run `npm run infra:up`, then apply the database migration command above.
3. Start `npm run dev` in another terminal.
4. Add `http://127.0.0.1:8545` (chain ID `31337`) to an EIP-1193 browser wallet and import Anvil's
   disposable account #1, whose address is printed as `borrower` by the launcher. Use this account
   only with local test assets.
5. Connect the wallet, review the position and route, sign the policy intent and exact plan, and
   follow the evidence timeline. The UI labels every transport observation as a DebtShift simulation.

The API re-reads the signed source snapshot at its historical block and at the current head before
accepting execution. The local worker refuses to start in any funded mainnet mode.

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

- `local` and `ci`: test assets and `DEBTSHIFT_SIMULATOR` only.
- `testnet`: NEAR registry testnet plus simulated transport.
- `mainnet-readonly`: public protocol reads and 1Click dry quotes; no asset movement.
- `mainnet-canary`: default-disabled isolated 1Click transport proof requiring manual approval.

The application must reject any funded production transport configuration outside the isolated
canary capability.
