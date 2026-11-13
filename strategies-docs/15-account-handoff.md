# Codex account handoff

## Purpose

This is the durable resume record for continuing DebtShift from a different Codex account. The
repository and current Git state are authoritative; do not reconstruct implementation state from
chat memory. Read this file, `14-submission-critical-plan.md`, and `08-progress-and-decisions.md`
before changing code.

## Safety state

- `MAINNET_EXECUTION_ENABLED` must remain `false`.
- No external deployment, committed 1Click deposit, contract write, registry write, transaction
  broadcast, or fund movement is authorized by this handoff.
- Mainnet execution still requires every acceptance invariant, an exact exposure review, borrower
  signatures, and the project owner's explicit final authorization.
- The only submission-critical route is configured in
  `config/routes/base-aave-v3-to-arbitrum-morpho-blue.v1.json`.

## Git checkpoint

- Branch: `main`.
- Previous remote checkpoint before this handoff: `2269099`.
- Resume from the newest pushed commit containing this file.
- Confirm with `git status --short --branch` and `git log -1 --oneline` before work.
- Preserve any new contributor changes; do not reset or overwrite a dirty worktree.

## What the pending checkpoint adds

1. Executable entry-predicate cases for all 15 migration phases, including every forward,
   recovery, requote, expiry, cancellation, and failed-safe outcome.
2. Removal of every required evidence predicate one at a time to prove a phase cannot be derived
   from an incomplete prefix.
3. One explicit positive test for each of the 27 permitted phase-transition edges and exhaustive
   rejection of all other pairs in the 15-by-15 transition matrix.
4. Closure of both phase-entry and transition-coverage definition-of-done items.
5. A line-exact gitleaks allowlist for route-binding documentation that triggered the generic-key
   heuristic; the pinned scanner finds no leak across all 45 commits.

The production deployer installs DebtShift contracts around existing Aave V3 and Morpho Blue
deployments. It never deploys mock tokens, mock lending markets, borrower positions, or liquidity.
The generated manifest records canonical transaction/block evidence and runtime code hashes but no
RPC URLs or secrets.

## Verified evidence at handoff

| Gate                                  | Result                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Full `npm run check`                  | Pass: OpenAPI drift, format, lint, types, all tests, and all ten production builds       |
| Worker suite                          | Pass: 73 tests, including 21 durable workflows and 5 local execution-port cases          |
| Domain suite                          | Pass: 97 tests, including all 15 phase entries and all 225 transition pairs              |
| Database suite and migration drill    | Pass: 21 tests; all 13 migrations, rollback, restore, and idempotent recovery verified   |
| API suite                             | Pass: 24 tests, including signed slippage-cap rejection before persistence               |
| `npm run check:evm`                   | Pass: compiler, unit, fuzz, invariant, and lint gates                                    |
| `npm run check:evm-deployment`        | Pass: two-node deployment/readiness and tamper rejection                                 |
| NEAR format/test/clippy/sandbox gates | Pass in isolated Rust 1.95 Linux containers; host Cargo remains absent                   |
| GitHub quality run `43398835750`      | TypeScript, EVM, and NEAR passed; security prose false positive fixed in this checkpoint |
| `npm run check:forks`                 | Pass on checkpoint `7ce52a3` against Base block `55,600,000`; rerun after current push   |
| Credentialed 1Click dry quote         | Not run: `INTENTS_AUTH_TOKEN` is required                                                |

The live route observation used Base block `56,649,525` and Arbitrum block `523,682,852`. The
official 1Click schema hash observed during this session was
`9a2e676682aa6dec6905c82f1b2cc0ec72eda97964369aa51ec35eb82ccac0a3`. These are time-sensitive
observations, not permanent authorization; rerun them before deployment or execution.

## Exact next work

Work in this order:

1. Run the full repository gate, push this pending checkpoint, and confirm CI, especially the EVM
   deployment job and Linux NEAR sandbox test.
2. Supply a trusted archival `BASE_FORK_RPC_URL` and run `npm run check:forks` on this commit.
3. Obtain a 1Click auth token and run the credentialed dry quote only; do not commit the token or
   submit a deposit.
4. Deploy the NEAR registry to testnet and preserve account, WASM hash, transaction, verifier-role,
   storage, and sandbox/testnet evidence.
5. Deploy and publish the already locally verified Docker sandbox, API, worker, database/queue, and
   web UI with `NEXT_PUBLIC_API_URL` set at image build time.
6. Deploy the public EVM testnet path if suitable Aave/Morpho test markets and funding exist; keep
   the unavailable 1Click boundary explicitly simulated.
7. Run the full acceptance and security gate from a clean checkout.
8. Only after those gates, prepare external production deployment with
   `MAINNET_EXECUTION_ENABLED=false`, generate real manifests, and run `npm run check:deployment`.
9. Treat a real mainnet refinance as a separate final authorization event.

## Required external inputs

- Git hosting/CI access for the pushed branch.
- A trusted archival Base RPC URL for the pinned fork.
- An official 1Click authentication token for a dry quote and later committed lifecycle.
- NEAR testnet account/key and funded testnet signer.
- Hosted environment credentials and PostgreSQL/Redis services.
- EVM testnet/mainnet deployer and executor addresses, RPCs, and gas only when deployment is approved.

Never place any token, RPC credential, private key, or wallet seed in this document, Git, logs, or
deployment manifests.

## Resume prompt

Use this prompt in the new account:

> Continue the active DebtShift production-first goal from the latest `main` branch. Read
> `strategies-docs/README.md`, `15-account-handoff.md`, `14-submission-critical-plan.md`, and
> `08-progress-and-decisions.md` first. Treat the repository and test results as authoritative.
> Keep `MAINNET_EXECUTION_ENABLED=false`; do not deploy, broadcast, or move funds without explicit
> authorization. Resume the earliest safe incomplete item in the handoff's Exact next work section.
