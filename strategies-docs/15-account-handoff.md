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
- Previous remote checkpoint before this handoff: `ddec917`.
- Resume from the newest pushed commit containing this file.
- Confirm with `git status --short --branch` and `git log -1 --oneline` before work.
- Preserve any new contributor changes; do not reset or overwrite a dirty worktree.

## What this checkpoint adds

1. A strict, versioned EVM deployment manifest schema in
   `packages/domain/src/config/deployment-manifest.ts`.
2. Production deployment and wallet-free verification in
   `packages/protocols/src/production-deployment.ts`.
3. A two-Anvil production deployment integration test in
   `packages/protocols/src/production-deployment.integration.test.ts`.
4. A guarded external deployment entry point in `scripts/deploy-production-evm.mjs`.
5. A read-only post-deployment verifier in `scripts/check-deployment-readiness.mjs`.
6. A portable deployment test gate in `scripts/check-evm-deployment.mjs` and CI coverage.
7. A local-only Aave data-provider fixture used solely to exercise production deployment wiring.

The production deployer installs DebtShift contracts around existing Aave V3 and Morpho Blue
deployments. It never deploys mock tokens, mock lending markets, borrower positions, or liquidity.
The generated manifest records canonical transaction/block evidence and runtime code hashes but no
RPC URLs or secrets.

## Verified evidence at handoff

| Gate                           | Result                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `npm run format:check`         | Pass                                                                                  |
| `npm run check`                | Pass: formatting, lint, typecheck, package tests, workflow/recovery tests, and builds |
| `npm run check:evm`            | Pass: 33 tests, including fuzz and three invariant suites                             |
| `npm run check:evm-deployment` | Pass: two-node deployment/readiness and tamper rejection                              |
| `npm run check:live-route`     | Pass against current Base, Arbitrum, Chainlink, Morpho, and 1Click catalog state      |
| `npm run check:one-click-spec` | Pass against the official 1Click OpenAPI document                                     |
| `npm run check:near`           | Not rerun locally: Cargo is absent on this Windows host                               |
| `npm run check:forks`          | Not rerun: `BASE_FORK_RPC_URL` is required                                            |

The live route observation used Base block `56,649,525` and Arbitrum block `523,682,852`. The
official 1Click schema hash observed during this session was
`9a2e676682aa6dec6905c82f1b2cc0ec72eda97964369aa51ec35eb82ccac0a3`. These are time-sensitive
observations, not permanent authorization; rerun them before deployment or execution.

## Exact next work

Work in this order:

1. Push this checkpoint and confirm CI, especially the EVM deployment job and Linux NEAR sandbox
   test.
2. Supply a trusted archival `BASE_FORK_RPC_URL` and run `npm run check:forks` on this commit.
3. Obtain a 1Click auth token and run the credentialed dry quote only; do not commit the token or
   submit a deposit.
4. Deploy the NEAR registry to testnet and preserve account, WASM hash, transaction, verifier-role,
   storage, and sandbox/testnet evidence.
5. Deploy and publish the hosted contract-backed sandbox, API, worker, database/queue, and web UI.
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
