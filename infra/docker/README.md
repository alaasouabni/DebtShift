# DebtShift sandbox stack

This stack runs the same provider-neutral workflow used by the production modes. It deploys real
contracts to two private Anvil chains, migrates PostgreSQL, and starts the API, durable worker,
Redis, and web application. Only the unavailable external 1Click transport boundary is simulated;
the source close, destination release/open, settlement, receipts, balances, and evidence are real
local-chain operations.

## Run it

```sh
docker-compose -f infra/docker/docker-compose.yml up --build -d
npm run smoke:local
docker-compose -f infra/docker/docker-compose.yml ps
```

The default URLs are web `http://localhost:3000`, API documentation
`http://localhost:3001/docs`, source RPC `http://localhost:8545`, and destination RPC
`http://localhost:8546`.

The default Anvil keys and addresses are disposable public test fixtures. Never fund or reuse them
outside this private sandbox. `MAINNET_EXECUTION_ENABLED` is hard-set to `false` in this stack.
PostgreSQL, Redis, and the unlocked private-chain RPCs bind only to host loopback; do not publish
them through a public load balancer or reverse proxy.

## Hosted sandbox registry gate

Local development intentionally remains at financially `SETTLED` with a retryable
`FINALIZE_NEAR_RECEIPT` command when no NEAR registry signer is configured; it never fabricates a
terminal NEAR receipt or advances to `COMPLETED`. A hosted sandbox must set all of:

- `DEBTSHIFT_NODE_ENV=production`
- `NEAR_NETWORK=testnet`
- `NEAR_RPC_URL` set to the selected NEAR testnet RPC endpoint
- `NEAR_RPC_FALLBACK_URLS_JSON` set to an ordered JSON array of zero to four independently operated,
  explicitly approved testnet RPC endpoints
- `NEAR_REGISTRY_ACCOUNT`
- `NEAR_SIGNER_ACCOUNT_ID`
- `NEAR_SIGNER_PRIVATE_KEY`

Production startup then fails closed if any registry credential is missing. The signer must be a
dedicated funded testnet verifier account with only the required registry permissions. A private
NEAR sandbox remains valid for developer-operated deployments, but its evidence must retain the
`sandbox` network label.

Every configured public NEAR URL must use HTTPS and report `testnet`. Final-state registry reads may
fail over immediately. A registry write is never rebroadcast to another RPC during the same worker
attempt; an ambiguous outcome is reconciled from final contract state on the next durable attempt.

`NEXT_PUBLIC_API_URL` is a build argument. Set it to the public API `/v1` URL before building a
hosted image. Set `WEB_PUBLIC_URL` and `API_PUBLIC_URL` to the matching public origins. Do not put
mainnet keys, 1Click credentials, or real funds in this sandbox compose file. Supply unique hosted
PostgreSQL credentials through the deployment secret store, and expose the web/API only behind TLS.
