# Frontend implementation handoff

## Purpose

This document is the working contract between the DebtShift backend/contracts track and the
frontend owner. It defines what can be built now, the current API and signing flow, the required
user-visible safety boundaries, and the backend work that is still in progress.

The frontend owner may refactor or replace the current prototype in `apps/web`, but must preserve
the financial, authorization, and environment rules in this document.

## Ownership and collaboration boundary

### Frontend owner

- Owns `apps/web`, its component structure, visual design, accessibility, responsive behavior, and
  browser-side state management.
- Implements wallet connection, route review, authorization review, migration monitoring, recovery
  presentation, and AI explanation settings.
- Consumes backend results; it does not reproduce route ranking, financing feasibility, hash
  construction, or migration-phase derivation.
- Adds frontend tests and keeps the web lint, typecheck, test, and production build gates green.

### Backend and contracts owner

- Owns `apps/api`, `apps/worker`, `packages/*`, `contracts/*`, database migrations, provider
  integrations, signing schemas, and deterministic financial logic.
- Publishes shared types and schemas and documents breaking API changes.
- Keeps simulator and live-provider behavior visibly distinguishable.
- Provides stable execution, reconciliation, evidence, and recovery semantics.

### Shared files

Changes to root configuration, shared packages, environment variables, or cross-package schemas
should be coordinated before merging. The frontend should import shared types and signing helpers
rather than copy them into a second source of truth.

## Implementation baseline

- Start from `main` at or after commit `f2e86f8` and pull the strategy update before changing
  environment or execution UI.
- Create a separate branch, for example `feat/frontend-product`.
- The current `apps/web/src/components/debtshift-app.tsx` is a functional reference implementation,
  not a fixed design system.
- The current end-to-end write implementation is contract-backed dual-Anvil, but the target API is
  one provider-neutral workflow composed as `sandbox`, `testnet`, `mainnet-readonly`, or `mainnet`.
- Mainnet write capability is server-owned and defaults disabled through
  `MAINNET_EXECUTION_ENABLED=false`; the frontend only displays the effective capability.
- 1Click does not provide a testnet. A simulator receipt must never be presented as a 1Click
  transaction.

## Local setup

Use the root setup rather than inventing a separate frontend fixture server:

```sh
cp .env.example .env
npm ci
npm run infra:up
npm run db:migrate --workspace @debtshift/database
npm run local:chains
```

Keep `local:chains` running, then start the application in another terminal:

```sh
npm run dev
```

Defaults:

- Web: `http://localhost:3000`
- API: `http://localhost:3001/v1`
- API documentation: `http://localhost:3001/docs`
- Browser API configuration: `NEXT_PUBLIC_API_URL=http://localhost:3001/v1`

The API allows the origin configured by `WEB_PUBLIC_URL`, which defaults to
`http://localhost:3000`.

## What is ready to build now

The frontend owner can immediately implement or redesign:

1. Wallet connection and account/network-change handling.
2. Source position and provenance display.
3. Deterministic route comparison, rejection reasons, economics, safety, and freshness display.
4. Default financial-agent explanations.
5. Optional local Ollama or user-supplied API explanation settings.
6. Exact intent and execution-plan review.
7. Two explicit EIP-712 signature prompts.
8. Simulator execution confirmation.
9. Migration phase, command, evidence, event, and ledger timelines.
10. Terminal success, failed-safe, expiry, and recovery presentations.
11. Responsive, accessible loading, empty, error, and disconnected states.

The frontend must keep backend calls behind a typed client module. This is especially important
while wallet-session authentication and controlled production-read paths are completed.

## Current API contract

All application routes use the `/v1` prefix. JSON requests must send
`Content-Type: application/json`.

| Method | Route                               | Current purpose                                                             | UI use                             |
| ------ | ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| GET    | `/health`                           | API process health                                                          | Environment/status indicator       |
| GET    | `/positions/:wallet`                | Current supported source position with provenance                           | Primary position card              |
| GET    | `/positions/:wallet/history`        | Persisted position/snapshot history                                         | History or diagnostic view         |
| GET    | `/markets`                          | Persisted enabled markets                                                   | Market labels and future selectors |
| POST   | `/analysis/routes`                  | Deterministic route analysis plus optional explanation                      | Comparison and recommendation      |
| POST   | `/quotes`                           | Environment-gated transport quote                                           | Advanced/diagnostic quoting        |
| POST   | `/migrations/prepare`               | Exact mode-bound intent, plan, quote, funding, and hashes for wallet review | Authorization review               |
| POST   | `/migrations/execute`               | Verify signatures/capabilities and durably start the configured workflow    | Final submit after signatures      |
| GET    | `/migrations/:migrationId`          | Migration, evidence, events, commands, ledger, and reservations             | Authoritative monitoring view      |
| GET    | `/migrations/:migrationId/events`   | Authoritative event history                                                 | Optional focused event timeline    |
| GET    | `/migrations/:migrationId/evidence` | Normalized evidence records                                                 | Optional evidence explorer         |

There is currently no WebSocket or server-sent-event endpoint. Poll migration details while a
migration is non-terminal. Start around 1.5-2 seconds, pause polling when the tab is hidden, use
backoff after transient failures, and stop at `COMPLETED`, `FAILED_SAFE`, `REQUOTE_REQUIRED`, or
`EXPIRED`.

### Route analysis request

```json
{
  "wallet": "0x...",
  "explanation": { "mode": "DETERMINISTIC" }
}
```

`explanation` may be omitted. Supported variants are:

```ts
type ExplanationConfiguration =
  | { mode: 'DETERMINISTIC' }
  | { mode: 'LOCAL_AI'; baseUrl: string; model: string }
  | {
      mode: 'USER_API';
      provider: 'OPENAI' | 'OPENROUTER' | 'CUSTOM';
      model: string;
      apiKey: string;
      baseUrl?: string;
    };
```

The response contains:

- `analysis.agent = "DEBTSHIFT_ROUTE_RISK_AGENT"`;
- `analysis.deterministic = true`;
- one or more source-position analyses;
- each route's eligibility, rank, economics, safety, financing, rejections, and provenance;
- a separate explanation with `decisionHash`, provider, fallback status, and user-facing text.

The model explanation is descriptive only. It cannot change route eligibility, ranking, amounts,
hashes, signatures, or execution.

### Prepare request and response

Request:

```json
{ "borrower": "0x..." }
```

The current response includes:

```ts
interface PreparedMigration {
  environment: {
    mode: 'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet';
    transportProvider: 'DEBTSHIFT_SIMULATOR' | 'NEAR_INTENTS_1CLICK';
    executionEnabled: boolean;
    warning?: string;
  };
  verifyingContract: Address;
  intent: RefinanceIntent;
  intentHash: Hex;
  plan: ExecutionPlan;
  planHash: Hex;
  quote: ProviderQuote;
  sourceSnapshot: PositionSnapshot;
  routeAnalysis: RouteAnalysisResponse;
}
```

Until the provider-neutral backend is complete, preparation fails closed outside the current
sandbox workflow. Do not hide or rewrite that error. The frontend must consume backend capability
metadata rather than infer behavior from the hostname or expose a mode switch.

### Execute request

Send the exact prepared objects back with their wallet signatures:

```ts
{
  signedIntent: {
    intent: prepared.intent,
    intentHash: prepared.intentHash,
    signature: intentSignature
  },
  signedPlan: {
    plan: prepared.plan,
    planHash: prepared.planHash,
    signature: planSignature
  },
  quote: prepared.quote,
  sourceSnapshot: prepared.sourceSnapshot
}
```

Do not rebuild, round, normalize, reorder, or mutate a prepared financial object before execution.
If a user changes a limit or route selection, discard the preparation and request a new one.

`POST /migrations/execute` is idempotent for the same authorized migration. A successful response
contains at least `migrationId`; it may also state whether the database row was newly created.

### Transport quote request

The standalone quote route accepts:

```ts
{
  inputAsset: TokenReference;
  outputAsset: TokenReference;
  amountInUnits: string;
  maxSlippageBps: number;
  destinationReceiver: Address;
  refundReceiver: Address;
}
```

This endpoint is not required for the primary simulator UI because `/migrations/prepare` obtains
and binds the quote. A live provider response may be a dry quote and must not be presented as a
committed transfer or a completed refinance.

### Error envelope

NestJS errors normally return an HTTP status plus a body containing `message`, where `message` may
be a string or an array of strings. The client should:

1. Preserve the HTTP status.
2. Join array messages for display.
3. Keep a stable client error code or request context for UI routing.
4. Never treat an unknown or unparseable response as success.
5. Avoid showing provider credentials, authorization payloads, or internal stack traces.

## Shared types are the source of truth

Use exports from `@debtshift/domain` for financial and authorization objects:

- `PositionSnapshot`
- `RefinanceIntent`
- `ExecutionPlan`
- `ProviderQuote`
- `Migration`, `MigrationPhase`, `Evidence`, `Command`, `LedgerEntry`, and `AuditEvent`
- `getRefinanceIntentTypedData`
- `getExecutionPlanTypedData`

Use `@debtshift/optimizer` for route-evaluation types when they are exposed to the web package.
Until an API response type is exported, keep the temporary interface in one API-client module,
validate the response at that boundary, and do not spread duplicate interfaces across components.

All token amounts are integer strings in token base units. USD analytical amounts are integer
micro-dollars. Never convert authorization or accounting values through JavaScript `number`.
Formatting is a display-only operation and must retain the original string value.

## Wallet and EIP-712 flow

### Wallet connection

The current reference uses an injected EIP-1193 provider and `viem`. A replacement may use a wallet
library, but it must:

- Request accounts only after a user action.
- Track `accountsChanged`, `chainChanged`, disconnect, and rejected-request conditions.
- Clear prepared authorization and migration submission state when the active account changes.
- Require the connected account to equal `intent.borrower` and `plan.borrower`.
- Prompt a network switch with context; never switch or add a network without user interaction.
- Never request, accept, log, or persist a private key or seed phrase.

Wallet challenge/session authentication is not implemented yet. Until it exists, the wallet address
selects read data and the two execution signatures authorize the sandbox migration. The frontend
architecture should reserve a session/auth layer rather than treating address selection as
production authentication.

### Signing

Use the shared helpers exactly:

```ts
const intentSignature = await wallet.signTypedData({
  account,
  ...getRefinanceIntentTypedData(prepared.intent, prepared.verifyingContract),
});

const planSignature = await wallet.signTypedData({
  account,
  ...getExecutionPlanTypedData(prepared.plan, prepared.verifyingContract),
});
```

The user must see a human-readable review before each signature. At minimum show:

- source and target protocol/chain/market;
- source debt repayment cap and collateral minimum;
- target debt cap and minimum delivered collateral;
- solver principal, maximum fee, capitalized costs, separately paid costs, and any borrower funding;
- funding shortfall, which must be zero;
- slippage and safety limits;
- destination and refund receivers;
- transport provider and quote expiry;
- intent expiration and execution deadline;
- simulator/live environment label.

Two signatures are intentional: the refinance intent authorizes bounded policy and target scope;
the execution plan authorizes exact route, amounts, receivers, provider quote, financing, and
deadline. Do not combine them into a misleading single UI consent.

Support for EIP-1271 verification exists in the backend design, but the current preparation path
creates an EOA intent. Treat smart-account UX as pending until preparation exposes account type and
the corresponding wallet flow is verified end to end.

## Required borrower journey

1. **Landing/disconnected:** explain DebtShift and clearly label the environment.
2. **Connect wallet:** request account access; handle missing wallet and rejection.
3. **Position discovery:** show balances, protocol, market, source block, and observation time.
4. **Route analysis:** show all candidates, not only the winner. Explain ineligible routes and stale
   data.
5. **Route review:** separate deterministic calculations from optional AI explanation.
6. **Prepare:** obtain fresh exact terms and display the quote countdown.
7. **Review intent:** show bounded policy authorization and request the intent signature.
8. **Review plan:** show exact execution authorization and request the plan signature.
9. **Submit:** send both signatures and retain the returned migration ID.
10. **Monitor:** show phase, commands, evidence verification, transactions, and timestamps.
11. **Finish:** distinguish `COMPLETED`, `FAILED_SAFE`, `REQUOTE_REQUIRED`, and `EXPIRED`; expose
    recovery evidence and residual/refund information when present.

If the quote, intent, or plan expires before submission, discard both signatures and prepare again.

## Migration presentation

Ordered forward phases are:

```text
DRAFT -> QUOTED -> AUTHORIZED -> RESERVED -> SOURCE_CLOSED -> ROUTING
      -> DEST_FUNDED -> TARGET_OPEN -> SETTLED -> COMPLETED
```

Exceptional terminal/recovery phases are:

- `RECOVERY`: recovery is active and must not be presented as finished.
- `FAILED_SAFE`: execution did not complete, but the persisted evidence shows the safe recovery
  outcome.
- `REQUOTE_REQUIRED`: a pre-source feasibility check failed, the undrawn liquidity reservation was
  released atomically, and the source position was left unchanged. Tell the user that market
  capacity changed and a new plan is required. Never silently retry, reuse either signature, or
  imply that funds entered recovery.
- `EXPIRED`: the authorized window ended without a successful completion.

The frontend does not derive or advance phases. It renders the authoritative phase returned by the
API. Provider status, queue delivery, or an individual successful transaction must never be shown
as equivalent to `COMPLETED`.

For evidence, display verification state (`PROVISIONAL`, `CONFIRMED`, `FINALIZED`, `RETRACTED`, or
`REJECTED`) and chain/block/transaction provenance when available. Only link to an explorer when
the environment and chain are known and the hash is present.

## Environment and safety labels

An environment badge must remain visible throughout preparation, signing, and monitoring.

### Sandbox and testnet

- Use language such as `Contract-backed sandbox / test funds` or `Public testnet / simulated transport`.
- Show the warning returned by `/migrations/prepare`.
- Link actual EVM/NEAR transaction receipts and label only the transport-provider observation simulated.
- Never link a simulator receipt to the public 1Click service.

### Live read-only

- Use language such as `Live market data / execution disabled`.
- Live Aave/Morpho observations and live 1Click dry quotes do not authorize execution.
- Disable funded migration buttons when the backend reports that live execution is unavailable.

### Mainnet

- Display `Mainnet execution disabled` while the backend reports
  `MAINNET_EXECUTION_ENABLED=false`; the UI cannot override it.
- Before submission, display exact principal, collateral, minimum delivery, maximum target debt,
  solver fee, gas budget, deposit/destination/refund/payout receivers, deadline, and recovery
  exposure from the signed preparation response.
- Request borrower signatures through the wallet and require the explicit final confirmation flow.
- Never imply that enabling a browser control can activate mainnet writes.

## AI explanation settings

The default mode is deterministic and requires no model or API key. Optional modes must remain
secondary to the financial result.

- `LOCAL_AI` targets a local Ollama-compatible endpoint.
- `USER_API` supports OpenAI, OpenRouter, or an explicitly enabled custom HTTPS endpoint.
- API keys are request-only secrets. Keep them in component memory, do not put them in URLs, browser
  storage, analytics, logs, crash reports, or repository files.
- State clearly that proxy mode sends the key through the DebtShift backend for that request.
- Show `fallbackUsed` when an AI request fails and the deterministic explanation is returned.
- Changing provider, model, endpoint, or key must not change the decision hash or financial values.

## Suggested frontend structure

The exact framework structure is the frontend owner's decision, but keep these boundaries:

```text
apps/web/src/
  app/                 routes, layouts, error/loading boundaries
  components/          presentational components
  features/
    wallet/            EIP-1193 connection and account/network state
    positions/         source-position views
    routes/            route comparison and explanation views
    authorization/     prepare, review, expiry, and EIP-712 signing
    migrations/        polling, phase timeline, evidence, recovery
    settings/          explanation-provider settings
  lib/
    api/               one typed HTTP client and response validation
    formatting/        base-unit, bps, WAD, timestamp, and address display
    environment/       environment/capability labels
```

Keep financial calculations out of components. Components may format authoritative values, compare
UI state, and present backend rejection reasons; they must not recalculate route eligibility.

## Required UI states

Every data-driven screen must deliberately support:

- disconnected wallet;
- wallet unavailable;
- wallet request rejected;
- wrong or unsupported network;
- loading and empty data;
- no supported source position;
- no eligible route, including visible rejection reasons;
- stale position, market, or oracle data;
- AI fallback to deterministic explanation;
- quote/intent/plan expiry;
- first or second signature rejected;
- API validation failure;
- transient monitoring failure without losing the migration ID;
- active recovery;
- completed, failed-safe, and expired terminal outcomes.

Persisting the migration ID locally for page recovery is acceptable. Do not persist signatures,
prepared authorization payloads, user API keys, or provider secrets.

## Testing and acceptance criteria

### Component and client tests

- Request construction and error-envelope normalization.
- Base-unit, bps, micro-USD, WAD, and timestamp formatting without floating-point authorization
  calculations.
- Environment labels and simulator warnings.
- Eligible and rejected route rendering.
- Intent/plan review coverage for every material signed field.
- Expiry countdown and invalidation.
- Phase timeline, recovery, and terminal-state rendering.
- AI fallback and credential non-persistence.

### Browser journey tests

- Connect wallet and load a source position.
- Compare at least two deterministic routes.
- Prepare and review exact simulator terms.
- Reject either signature without submitting.
- Sign both payloads, start the migration, and reach `COMPLETED`.
- Exercise the refund/recovery scenario and reach `FAILED_SAFE` with recovery evidence.
- Deteriorate destination liquidity before source close and reach `REQUOTE_REQUIRED`; verify that
  the UI asks for a fresh plan instead of showing recovery or retrying the signed plan.
- Refresh during monitoring and resume from a retained migration ID.
- Confirm that no provider success alone is displayed as a completed refinance.

### Merge gate

Before merging frontend work:

```sh
npm run format:check
npm run lint --workspace @debtshift/web
npm run typecheck --workspace @debtshift/web
npm run test --workspace @debtshift/web
npm run build --workspace @debtshift/web
```

Run the root `npm run check` before a release or when shared packages change.

## Known backend dependencies and change points

The frontend may proceed now, but these contracts are not yet production-final:

| Dependency                              | Current state                                                  | Frontend preparation                                       |
| --------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| Wallet challenge/session authentication | Not implemented                                                | Keep auth/session logic behind a dedicated boundary        |
| Generated public API response DTOs      | Domain schemas exist; some controller bodies are still unknown | Centralize temporary response interfaces in the API client |
| Live funded refinance                   | Production workflow/composition still incomplete               | Render backend capabilities; never infer availability      |
| Smart-account preparation               | Verification exists; prepare currently emits EOA               | Do not claim EIP-1271 UX completion                        |
| Streaming migration updates             | Not implemented                                                | Isolate polling so it can later be replaced                |
| Explorer metadata                       | Not yet a frontend API contract                                | Use an environment map only for known chains               |
| Mainnet readiness/enable state          | Server-side environment and operator responsibility            | Display read-only capability and exact preflight terms     |

Backend changes should preserve or version shared schemas. A breaking change must update this
handoff, the shared type/schema package, tests, and the frontend owner in the same work period.

## Non-negotiable frontend rules

- Never store or request a borrower private key.
- Never allow an AI model to select, mutate, sign, or execute a route.
- Never use floating-point arithmetic for token or authorization amounts.
- Never present a dry quote, provider success, transaction broadcast, or queue success as
  `COMPLETED`.
- Never silently weaken a signed limit or substitute a receiver, token, chain, market, quote, or
  deadline.
- Never hide route rejection, stale-data, shortfall, recovery, or simulator status from the user.
- Never label the local transport simulator as 1Click testnet.
- Never enable real-fund execution solely through a frontend flag.
