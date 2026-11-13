# NEAR registry deployment and readiness

## Purpose and current boundary

This runbook deploys the DebtShift agreement registry to an existing NEAR account, initializes its
owner and verifier set, emits a versioned manifest, and verifies the live contract without making a
workflow write. The same tooling supports `testnet` and a later `mainnet` deployment, but the current
submission step is testnet only.

The repository is ready for this operation; the external deployment remains pending until a funded
testnet registry account, its deployment key, a separate funded verifier account/key, and the
intended owner account are available. Never put any of those keys in Git, a manifest, shell history,
screenshots, CI output, or chat.

## Account separation

- **Registry account:** existing funded account that will hold the WASM. Its full-access deployment
  key is used only by the deployment command and should be rotated or removed afterward.
- **Owner account:** governance/administrative identity recorded in contract state. It adds and
  removes verifiers and performs the two-step ownership transfer. It need not be the registry
  account.
- **Verifier account:** dedicated low-balance worker signer allowed to register agreements, append
  attestations, and finalize receipts. Its key is the only NEAR key required by the running worker.
- Do not reuse the borrower, EVM deployer/executor, 1Click, owner, and verifier identities.

The first deployment uses exactly one verifier unless an explicit multi-verifier operating policy
has already been approved. The contract prevents duplicate verifiers, more than 64 verifiers, and
removal of the final verifier.

## Pre-deployment gate

1. Work from the exact pushed commit intended for deployment and require a clean worktree.
2. Confirm the corresponding GitHub quality run is green, including the Linux NEAR unit, Clippy,
   WASM, and sandbox tests.
3. Run `npm ci` and `npm run check:near` on Linux. On Windows, rely on the green Linux CI sandbox
   job in addition to the host format/unit/Clippy/WASM checks.
4. Reconfirm the selected RPC provider currently reports `testnet`. Configure zero to four approved
   independent fallback URLs; do not discover or add endpoints automatically.
5. Confirm the registry account exists, has enough test NEAR for deployment, and has no contract
   code. The deployer intentionally refuses to overwrite an account whose `code_hash` is non-empty.
6. Confirm the registry deployment key is full-access, the owner and verifier accounts exist, and
   the registry, owner, and verifier identities are all distinct.
7. Record the intended registry, owner, and verifier account IDs out of band. Confirm
   `MAINNET_EXECUTION_ENABLED=false`.

## Deployment command

Build and deploy with environment variables supplied by the operator's secret-aware shell or
deployment service:

```text
DEBTSHIFT_DEPLOYMENT_APPROVED=true
DEBTSHIFT_DEPLOYMENT_ENVIRONMENT=testnet
MAINNET_EXECUTION_ENABLED=false
NEAR_NETWORK=testnet
NEAR_RPC_URL=<approved HTTPS testnet RPC>
NEAR_REGISTRY_ACCOUNT=<existing funded registry account>
NEAR_REGISTRY_OWNER_ACCOUNT=<intended owner account>
NEAR_INITIAL_VERIFIERS_JSON=["<dedicated verifier account>"]
NEAR_DEPLOYER_PRIVATE_KEY=<registry account deployment key from secret store>
NEAR_MINIMUM_DEPLOYER_BALANCE_YOCTO=<reviewed deployment balance floor; defaults to 5 NEAR>
NEAR_DEPLOYMENT_MANIFEST_PATH=<new manifest path>
npm run deploy:near
```

`deploy:near` builds the pinned registry WASM, rebuilds the domain schemas, checks the Git commit and
clean worktree, validates the network and deployer access key, and refuses existing code. It sends
one finality-waited NEAR transaction containing the code deployment and `new` initialization
actions. A failed batch cannot be mistaken for a completed manifest. The script then reads final
code and state, checks the artifact SHA-256, owner, pending-owner state, verifier list, and storage,
and creates the manifest with exclusive-create semantics.

The manifest contains no RPC URL or key. It records the network, source commit, account identities,
artifact path and SHA-256, NEAR deployed-code hash, final transaction/block evidence, initialized
storage, timestamp, and `workflowWriteSwitchEnabled=false`.

## Read-only verification

Run this immediately after deployment and again before a hosted worker starts:

```text
MAINNET_EXECUTION_ENABLED=false
NEAR_NETWORK=testnet
NEAR_RPC_URL=<approved primary HTTPS RPC>
NEAR_RPC_FALLBACK_URLS_JSON=["<approved fallback>"]
NEAR_DEPLOYMENT_MANIFEST_PATH=<created manifest path>
NEAR_REGISTRY_ACCOUNT=<manifest registry account>
NEAR_REGISTRY_OWNER_ACCOUNT=<manifest owner account>
NEAR_REGISTRY_WASM_SHA256=<manifest wasmSha256>
npm run check:near-deployment
```

The verifier checks every configured endpoint for network identity, final contract bytes, artifact
SHA-256, NEAR code hash, owner, absent pending ownership transfer, exact verifier set, and initialized
storage. It also verifies the recorded deployment transaction at finality through the primary RPC.
An old transaction may require an approved archival primary, but current code and roles must still
agree through every configured runtime endpoint.

## Worker configuration and startup gate

Configure the hosted worker from the verified manifest and the separate verifier secret:

- `NEAR_NETWORK=testnet`
- `NEAR_RPC_URL` and `NEAR_RPC_FALLBACK_URLS_JSON`
- `NEAR_REGISTRY_ACCOUNT`
- `NEAR_REGISTRY_OWNER_ACCOUNT`
- `NEAR_REGISTRY_WASM_SHA256`
- `NEAR_SIGNER_ACCOUNT_ID`
- `NEAR_SIGNER_PRIVATE_KEY` from the secret store

Hosted sandbox, testnet, and write-enabled mainnet modes reject partial configuration. Before the
worker starts its queue, it reads final contract code through the approved failover client, hashes
the bytes, verifies the exact owner, requires no pending owner transfer, and confirms the signer is
an authorized verifier. A network mismatch, code/owner drift, missing role, or RPC outage prevents
command consumption.

Reads may fail over immediately. A registry transaction is still submitted to exactly one RPC. An
ambiguous outcome ends that durable attempt; the next attempt reconciles final registry state before
submitting any still-missing mutation.

## Evidence to preserve

- Git commit and green CI run URL.
- WASM SHA-256 and NEAR deployed-code hash.
- Manifest file hash and immutable copy.
- Registry, owner, and verifier account IDs.
- Deployment/initialization transaction hash, block hash, and block height.
- Readiness command output and timestamp.
- Explorer link to the registry account and deployment transaction.
- A post-deployment unauthorized-call rejection and an authorized test receipt smoke result.
- Proof that no key or credential appears in logs, manifest, traces, or repository history.

Only after those items pass may the roadmap's NEAR testnet deployment checkbox be completed. A
testnet workflow smoke must additionally prove the application receipt bundle hash equals the
immutable registry receipt hash. Mainnet deployment is a separate acceptance event and retains the
default-disabled application write switch.
