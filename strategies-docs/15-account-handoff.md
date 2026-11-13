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
- The write-disabled public-testnet dependency candidate is separately frozen in
  `config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.dependencies.v1.json`;
  it is not an executable route or evidence of deployment.
- The executable testnet route must be generated only after canonical Morpho deployment with the
  reviewed policy in
  `config/testnet-routes/ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue.policy.v1.json`.

## Git checkpoint

- Branch: `main`.
- Verified pushed checkpoint: `a6fae68`, including the frozen public-testnet foundation, live
  validator, exact manifest binding, oracle hardening, corrected Aave reserve-token resolution,
  narrow public-address Gitleaks policy, and synchronized strategy evidence.
- Resume from the newest pushed commit containing this file.
- Confirm with `git status --short --branch` and `git log -1 --oneline` before work.
- Preserve any new contributor changes; do not reset or overwrite a dirty worktree.

## What the current checkpoint adds

1. Source-commit-bound EVM, canonical testnet Morpho, and NEAR manifests; clean-worktree guarded
   deployers; independent read-only readiness CLIs; and exact operator runbooks.
2. Production workers await EVM and NEAR startup attestation before queue consumption. EVM startup
   checks the manifest, route, addresses, canonical receipts, runtime hashes, bindings, roles, pause
   state, and disabled write switch. NEAR startup checks code bytes/hash, owner/pending owner, and
   verifier role.
3. Safe NEAR RPC failover validates every configured network, fails over idempotent final-state
   reads, never blindly rebroadcasts a write, and reconciles ambiguous results on the next durable
   attempt.
4. Credential-safe OpenTelemetry propagation, Prometheus metrics, Grafana/Jaeger deployment,
   low-cardinality dashboards, and exact observability runbooks.
5. A healthy Compose sandbox and end-to-end migration evidence with real dual-chain transactions,
   durable ledger reconciliation, and zero unexplained imbalance.
6. The public-testnet destination path now compiles exact canonical Morpho/AdaptiveCurveIrm source,
   creates and funds a real market through a guarded deployer, and chains its manifest into worker
   startup. No public deployment has occurred.
7. The exact public candidate is official Aave V3 on Ethereum Sepolia to a DebtShift-operated
   canonical-source Morpho market on Base Sepolia. A credential-free validator pins official
   provenance and live state; the route dependency hash is chained through both deployment
   manifests, readiness, and worker startup.
8. The hardened dependency also pins independent official Chainlink Ethereum Sepolia planning
   feeds. A source-commit-bound generator derives the post-deployment executable route from the
   dependency file, canonical Morpho manifest, and reviewed policy without inventing testnet 1Click
   asset IDs.
9. R-16 external secret-manager/relayer rotation and R-21 final mainnet authorization remain open;
   no credentialed or write-capable external action was attempted.

The production deployer installs DebtShift contracts around existing Aave V3 and Morpho Blue
deployments. It never deploys mock tokens, mock lending markets, borrower positions, or liquidity.
The generated manifest records canonical transaction/block evidence and runtime code hashes but no
RPC URLs or secrets.

Public testnet is the one exception for protocol dependency deployment because Morpho has no
official public-testnet singleton. Follow `21-public-testnet-morpho-deployment.md`: it deploys exact
pinned canonical Morpho source, a testnet-only Chainlink oracle, and one real funded testnet market.
It must be labeled DebtShift-operated protocol-compatible infrastructure, never official Morpho.

## Verified evidence at handoff

| Gate                                  | Result                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Full `npm run check`                  | Pass: OpenAPI drift, format, scripts, lint/types, all tests, and all 11 builds         |
| Worker suite                          | Pass: 85 tests, including adapter startup ordering and exact final registry state      |
| Domain suite                          | Pass: 119 tests, including deterministic testnet-route derivation and mode boundaries  |
| Database suite and migration drill    | Pass: 22 tests; all 13 migrations, rollback, restore, and idempotent recovery verified |
| API suite                             | Pass: 25 tests, including a credential-flow architecture boundary                      |
| Agent and web suites                  | Pass: 9 agent/security tests and 4 browser tests                                       |
| `npm run check:evm`                   | Pass: compiler, unit, fuzz, invariant, lint, and taxed-token rollback gates            |
| `npm run check:evm-deployment`        | Pass: seven DebtShift/Morpho deployment, readiness, and tamper tests                   |
| Pinned canonical Morpho Foundry gate  | Pass: 25 files compile; 4 oracle cross-price/age/stale/sequencer tests pass            |
| Canonical Morpho deployment suite     | Pass: real market/seed liquidity plus provenance and route-hash tamper rejection       |
| Vendored Morpho provenance            | Pass: all 28 files match pinned upstream Git blob IDs                                  |
| Production runtime image              | Pass: `sha256:f69bfc…ea0a`, non-root, pinned artifacts, no npm/npx/Forge               |
| Production dependency audit           | Pass: zero vulnerabilities with development dependencies omitted                       |
| `npm run check:live-route`            | Pass: public Base `56,863,212`, Arbitrum `523,828,471`, and 1Click catalog reads       |
| `npm run check:one-click-spec`        | Pass: official quote, status, and deposit schema SHA-256 recorded below                |
| Local Compose rebuild and smoke       | Pass: healthy stack; 17 evidence, 16 ledger entries, zero unexplained imbalance        |
| NEAR format/test/clippy/sandbox gates | Pass in isolated Rust 1.95 Linux containers; host Cargo remains absent                 |
| GitHub quality run `43400476244`      | Pass: TypeScript, EVM, NEAR, and security for phase checkpoint `06504e3`               |
| GitHub quality run `43402193495`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for `d527bf6`                |
| GitHub quality run `43403559848`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for `e31683c`                |
| GitHub quality run `43409003610`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for `f0a807e`                |
| GitHub quality run `43409934145`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for `b7413ec`                |
| GitHub quality run `43424094454`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for observability            |
| GitHub quality run `43427515013`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for safe NEAR RPC failover   |
| GitHub quality run `43430774187`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for guarded NEAR deployment  |
| GitHub quality run `43433864649`      | Pass: TypeScript, EVM, NEAR, security/container, and SBOM for `aa07317`                |
| GitHub quality run `43434997971`      | Pass: complete quality workflow for documentation checkpoint `f0c94c1`                 |
| GitHub quality run `43435798717`      | Pass: complete quality workflow for funded transport checkpoint `ecc6417`              |
| GitHub quality run `43446037695`      | Pass: complete quality workflow for canonical Morpho checkpoint `435c351`              |
| GitHub quality run `43459443566`      | Pass: complete quality workflow for public-testnet route checkpoint `7b59a4f`          |
| GitHub quality run `43460754238`      | Pass: complete quality workflow for synchronized strategy checkpoint `a6fae68`         |
| `npm run check:public-testnet-route`  | Pass: dependency hash `0x2186…7f17`; both source/destination feed rounds finalized     |
| `npm run check:forks`                 | Pass on `b7413ec` against Base block `55,600,000` using the official free RPC          |
| Credentialed 1Click dry quote         | Not run: `INTENTS_AUTH_TOKEN` is required                                              |

The live route observation used Base block `56,863,212` and Arbitrum block `523,828,471`. The
official 1Click schema hash observed during this session was
`9a2e676682aa6dec6905c82f1b2cc0ec72eda97964369aa51ec35eb82ccac0a3`. These are time-sensitive
observations, not permanent authorization; rerun them before deployment or execution.

## Exact next work

Work in this order:

1. Acquire funded Ethereum Sepolia/Base Sepolia/NEAR testnet signers and the reviewed test assets,
   rerun `npm run check:public-testnet-route`, then follow
   `21-public-testnet-morpho-deployment.md` for the reviewed irreversible deployment.
2. Run `npm run generate:public-testnet-route` with the resulting Morpho manifest, review and commit
   the exclusively created executable route, deploy the seven DebtShift EVM contracts, and
   configure both manifests for startup attestation.
3. Obtain a 1Click auth token and run the credentialed dry quote only; do not commit the token or
   submit a deposit.
4. Deploy the NEAR registry to testnet and preserve account, WASM hash, transaction, verifier-role,
   storage, and sandbox/testnet evidence.
5. Deploy and publish the already locally verified Docker sandbox, API, worker, database/queue, and
   web UI with `NEXT_PUBLIC_API_URL` set at image build time.
6. Run the public-testnet workflow with only the unavailable 1Click boundary explicitly simulated,
   then execute the full acceptance and security gate from a clean checkout.
7. Only after those gates, prepare external production deployment with
   `MAINNET_EXECUTION_ENABLED=false`, generate real manifests, and run `npm run check:deployment`.
8. Treat a real mainnet refinance as a separate final authorization event.

## Required external inputs

- Git hosting/CI access for the pushed branch.
- An official 1Click authentication token for a dry quote and later committed lifecycle.
- NEAR testnet account/key and funded testnet signer.
- Hosted environment credentials and PostgreSQL/Redis services.
- EVM testnet/mainnet deployer and executor addresses, RPCs, and gas only when deployment is approved.
- Reviewed public-testnet collateral/loan tokens, Chainlink feeds/sequencer policy, LLTV, and enough
  real testnet loan token to seed the exact demonstration market.

Never place any token, RPC credential, private key, or wallet seed in this document, Git, logs, or
deployment manifests.

## Resume prompt

Use this prompt in the new account:

> Continue the active DebtShift production-first goal from the latest `main` branch. Read
> `strategies-docs/README.md`, `15-account-handoff.md`, `14-submission-critical-plan.md`, and
> `08-progress-and-decisions.md` first. Treat the repository and test results as authoritative.
> Keep `MAINNET_EXECUTION_ENABLED=false`; do not deploy, broadcast, or move funds without explicit
> authorization. Resume the earliest safe incomplete item in the handoff's Exact next work section.
