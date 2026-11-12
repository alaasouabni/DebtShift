# Deployment manifests

Every external DebtShift deployment must produce an immutable version-1 JSON manifest here. The
manifest records deployment and configuration transaction hashes, block numbers, runtime code
hashes, exact Aave/Morpho identities, owner/executor roles, the route-file hash, and the fact that
workflow writes were disabled at deployment time.

The deployment command refuses to overwrite an existing manifest and never stores RPC URLs or
private keys:

```bash
npm run deploy:evm
```

This is an external write operation. Do not set `DEBTSHIFT_DEPLOYMENT_APPROVED=true` until the exact
network, signer, balances, route file, and output path have been reviewed. Mainnet additionally
requires the exact `MAINNET_CONTRACT_DEPLOYMENT_CONFIRMATION` value enforced by the script, while
`MAINNET_EXECUTION_ENABLED` must remain `false`.

No example with invented transaction hashes is committed because a deployment manifest is evidence,
not configuration. Testnet and mainnet files are added only after the corresponding receipts exist.
