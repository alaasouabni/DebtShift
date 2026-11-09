# Security strategy and risk register

## Non-negotiable invariants

1. No transfer or lending action exceeds signed chain, market, token, amount, receiver, fee, nonce, or deadline limits.
2. No migration is completed without verified source, transport, destination, settlement, and registry evidence.
3. Provider delivery status alone never proves target lending success.
4. No external command is executed more than once logically.
5. No active-migration asset can be swept to an administrative address.
6. No ledger imbalance is hidden by netting different tokens or chains.
7. No unknown external state advances the workflow.
8. No borrower private key enters backend custody.

## Risk register

| ID   | Risk                                                          | Severity | Required control                                                                                                                                                               | Verification                                 | Status                 |
| ---- | ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------- |
| R-01 | Solver repays an EOA but cannot obtain collateral             | Critical | Atomic source mechanism or smart-account/user-execution alternative                                                                                                            | Pinned Aave fork proof                       | OPEN                   |
| R-02 | Forged or replayed authorization                              | Critical | EIP-712 domain binding, nonce, deadline, EIP-1271 support                                                                                                                      | Unit, fuzz, and replay tests                 | OPEN                   |
| R-03 | Wrong token or decimal mapping                                | Critical | Address-based catalog, base-unit integers, runtime metadata cross-check                                                                                                        | Mutation and integration tests               | OPEN                   |
| R-04 | Signed plan does not bind committed transport details         | Critical | Separate exact execution-plan signature                                                                                                                                        | Hash fixtures and contract negative tests    | OPEN                   |
| R-05 | Transport reports success without correct delivery            | Critical | Independent receipt and balance verification                                                                                                                                   | Wrong token/receiver/amount E2E tests        | OPEN                   |
| R-06 | Stale market or oracle creates unsafe target position         | High     | Fresh execution-time reads, oracle-age limit, stress buffer                                                                                                                    | Fork and stale-snapshot tests                | OPEN                   |
| R-07 | Worker retry duplicates asset movement                        | Critical | Deterministic commands, outbox, evidence-before-send, onchain nonce                                                                                                            | Crash and duplicate-delivery tests           | OPEN                   |
| R-08 | Chain reorg invalidates evidence                              | High     | Finality policy, canonical block checks, evidence retraction                                                                                                                   | Simulated reorg tests                        | OPEN                   |
| R-09 | Solver payout exceeds agreement                               | Critical | Principal and fee caps, exact receiver, separate ledger entries                                                                                                                | Foundry invariant tests                      | OPEN                   |
| R-10 | Destination is funded but target borrow is unavailable        | High     | Escrow custody, bounded retry, signed recovery policy                                                                                                                          | Recovery E2E test                            | OPEN                   |
| R-11 | Transport refund goes to wrong or uncontrolled receiver       | Critical | Refund receiver bound in execution plan and verified                                                                                                                           | Contract and simulator tests                 | OPEN                   |
| R-12 | Administrator steals active assets                            | Critical | Split roles, no active-balance sweep, narrow pause                                                                                                                             | Access-control tests                         | OPEN                   |
| R-13 | Non-standard token breaks accounting                          | High     | Initial strict token allowlist and balance-delta checks                                                                                                                        | Adversarial token tests                      | OPEN                   |
| R-14 | Queue and database disagree                                   | High     | Transactional outbox; PostgreSQL is source of truth                                                                                                                            | Interruption tests                           | OPEN                   |
| R-15 | NEAR attestation is presented as trustless proof              | Medium   | Explicit verification scheme and verifier identity                                                                                                                             | UI/content review and contract tests         | OPEN                   |
| R-16 | Secrets or relayer keys leak                                  | Critical | Secret manager, redaction, rotation, least privilege                                                                                                                           | Secret scan and rotation drill               | OPEN                   |
| R-17 | Mainnet transaction enabled outside the isolated canary       | Critical | Capability-based environment lock and default deny                                                                                                                             | Automated environment negative test          | OPEN                   |
| R-18 | USD quote field authorizes incorrect movement                 | High     | USD is display-only; contracts use base-unit caps                                                                                                                              | Static review and mutation tests             | OPEN                   |
| R-19 | Cross-chain solver repayment has asset/chain mismatch         | High     | Bind payout chain, asset, amount, and receiver                                                                                                                                 | Quote-schema and settlement tests            | OPEN                   |
| R-20 | Recovery leaves unexplained residual claims                   | High     | Recovery case and balanced per-asset ledger                                                                                                                                    | Terminal-state invariant test                | OPEN                   |
| R-21 | Live canary exceeds the intended exposure                     | Critical | Dedicated low-balance wallet, base-unit cap, fixed route and receivers, manual confirmation                                                                                    | Policy mutation tests and preflight record   | OPEN                   |
| R-22 | Canary is misrepresented as a full live refinance             | High     | Separate record type, UI labeling, and README disclosure                                                                                                                       | Content review and schema tests              | OPEN                   |
| R-23 | LLM output influences financial authorization                 | Critical | Deterministic policy owns decisions; LLM is explanation-only with no write tools                                                                                               | Capability tests and mutation review         | OPEN                   |
| R-24 | Free API outage or rate limiting corrupts route state         | High     | Cache, bounded retry, direct onchain fallback, freshness gates, fail closed                                                                                                    | Provider outage integration tests            | OPEN                   |
| R-25 | Indexed API disagrees with current chain state                | Critical | Execution-time direct contract reads at recorded blocks                                                                                                                        | Mismatch and stale-data tests                | OPEN                   |
| R-26 | User-supplied AI API key leaks                                | Critical | Memory-only handling, redaction, no persistence, no telemetry                                                                                                                  | Log, storage, and error-path tests           | OPEN                   |
| R-27 | Custom AI endpoint enables SSRF                               | Critical | Presets by default, HTTPS enforcement, DNS/IP validation, private-network denial, explicit local mode                                                                          | URL mutation and network-boundary tests      | OPEN                   |
| R-28 | Remote AI receives sensitive or unnecessary data              | High     | Minimal structured public inputs, field allowlist, no signatures/keys/session data                                                                                             | Payload snapshot tests                       | OPEN                   |
| R-29 | Development lint dependency has a glob-amplification advisory | Medium   | Run lint only against trusted repository paths, exclude generated/untrusted trees, require zero production audit findings, and monitor for a compatible minimatch/ESLint patch | `npm audit --omit=dev` and lint-input review | MITIGATED / MONITORING |

## Security review gates

### Before simulated asset movement

- Domain schemas and amount types reviewed.
- State transitions and idempotency keys tested.
- No secret-bearing configuration committed.

### Before protocol fork execution

- EIP-712 fixtures match TypeScript and Solidity.
- Contract access controls and pause behavior tested.
- Source-ownership mechanism explicitly approved or rejected through evidence.

### Before NEAR testnet

- Verifier and administrator roles reviewed.
- Duplicate and conflicting finalization tests pass.
- Attestation trust is accurately represented in API and UI.

### Before any future real funds

- All critical and high risks closed with evidence.
- Independent contract audit complete.
- Production incident and recovery drills complete.
- Solver credit, timeout, and loss allocation defined outside code where necessary.
- Explicit approval recorded in `08-progress-and-decisions.md`.
