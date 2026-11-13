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
9. No solver or test-vault commitment exists unless maximum safe destination borrowing plus confirmed
   external funding covers the complete repayment and financed-cost obligation.
10. No pending transfer, wallet balance, unsecured promise, or speculative future capacity is counted
    as funding.
11. No financial component is counted in more than one of solver principal, solver fee, capitalized
    cost, separately paid cost, borrower debt prepayment, or supplementary settlement funding.
12. No post-source-close capacity loss may trigger an unsafe target borrow or a false claim of solver
    repayment.
13. No mainnet irreversible command may run unless `DEBTSHIFT_MODE=mainnet` and
    `MAINNET_EXECUTION_ENABLED=true`; this application gate never replaces signed or onchain checks.
14. No source close may occur unless the configured recovery reserve is isolated and evidenced.

## Risk register

| ID   | Risk                                                                               | Severity | Required control                                                                                                                                                               | Verification                                                           | Status                 |
| ---- | ---------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------- |
| R-01 | Solver repays an EOA but cannot obtain collateral                                  | Critical | Atomic source mechanism or smart-account/user-execution alternative                                                                                                            | Pinned Aave fork proof                                                 | OPEN                   |
| R-02 | Forged or replayed authorization                                                   | Critical | EIP-712 domain binding, nonce, deadline, EIP-1271 support                                                                                                                      | Unit, fuzz, and replay tests                                           | OPEN                   |
| R-03 | Wrong token or decimal mapping                                                     | Critical | Address-based catalog, base-unit integers, runtime metadata cross-check                                                                                                        | Mutation and integration tests                                         | OPEN                   |
| R-04 | Signed plan does not bind committed transport details                              | Critical | Separate exact execution-plan signature                                                                                                                                        | Hash fixtures and contract negative tests                              | OPEN                   |
| R-05 | Transport reports success without correct delivery                                 | Critical | Independent receipt and balance verification                                                                                                                                   | Wrong token/receiver/amount E2E tests                                  | OPEN                   |
| R-06 | Stale market or oracle creates unsafe target position                              | High     | Fresh execution-time reads, oracle-age limit, stress buffer                                                                                                                    | Fork and stale-snapshot tests                                          | OPEN                   |
| R-07 | Worker retry duplicates asset movement                                             | Critical | Deterministic commands, outbox, evidence-before-send, onchain nonce                                                                                                            | Restart-every-command, duplicate-delivery, and onchain replay tests    | MITIGATED              |
| R-08 | Chain reorg invalidates evidence                                                   | High     | Finality policy, canonical block checks, evidence retraction                                                                                                                   | Simulated reorg tests                                                  | OPEN                   |
| R-09 | Solver payout exceeds agreement                                                    | Critical | Principal and fee caps, exact receiver, separate ledger entries                                                                                                                | Foundry invariant tests                                                | OPEN                   |
| R-10 | Destination is funded but target borrow is unavailable                             | High     | Escrow custody, bounded retry, signed recovery policy                                                                                                                          | Recovery E2E test                                                      | OPEN                   |
| R-11 | Transport refund goes to wrong or uncontrolled receiver                            | Critical | Refund receiver bound in execution plan and verified                                                                                                                           | Exact refund verification, escrow custody, and recovery E2E            | MITIGATED              |
| R-12 | Administrator steals active assets                                                 | Critical | Split roles, no active-balance sweep, narrow pause                                                                                                                             | Access-control tests                                                   | OPEN                   |
| R-13 | Non-standard token breaks accounting                                               | High     | Initial strict token allowlist and balance-delta checks                                                                                                                        | Adversarial token tests                                                | OPEN                   |
| R-14 | Queue and database disagree                                                        | High     | Transactional outbox; PostgreSQL is source of truth                                                                                                                            | Publish failure/recovery, stale-command, and redelivery tests          | MITIGATED              |
| R-15 | NEAR attestation is presented as trustless proof                                   | Medium   | Explicit verification scheme and verifier identity                                                                                                                             | UI/content review and contract tests                                   | OPEN                   |
| R-16 | Secrets or relayer keys leak                                                       | Critical | Secret manager, redaction, rotation, least privilege                                                                                                                           | Secret scan and rotation drill                                         | OPEN                   |
| R-17 | Mainnet transaction enabled in the wrong mode or while the execution switch is off | Critical | Validated mode, fail-closed `MAINNET_EXECUTION_ENABLED`, API/worker broadcast gates, independent contract roles and pause                                                      | Mode matrix and irreversible-command negative tests                    | OPEN                   |
| R-18 | USD quote field authorizes incorrect movement                                      | High     | USD is display-only; contracts use base-unit caps                                                                                                                              | Static review and mutation tests                                       | OPEN                   |
| R-19 | Cross-chain solver repayment has asset/chain mismatch                              | High     | Bind payout chain, asset, amount, and receiver                                                                                                                                 | Quote-schema and settlement tests                                      | OPEN                   |
| R-20 | Recovery leaves unexplained residual claims                                        | High     | Recovery case and balanced per-asset ledger                                                                                                                                    | Terminal-state invariant test                                          | OPEN                   |
| R-21 | First mainnet refinance exceeds the explicitly approved exposure                   | Critical | One active route, native/base-unit caps, exact receivers, recovery reserve, signed plan, owner preflight approval, immediate switch-off afterward                              | Policy mutation tests and signed preflight record                      | OPEN                   |
| R-22 | Sandbox/testnet evidence is misrepresented as production execution                 | High     | Provider/mode identity in evidence, actual transaction provenance, UI labels, and no simulator fallback in production                                                          | Content review, schema, and composition tests                          | OPEN                   |
| R-23 | LLM output influences financial authorization                                      | Critical | Deterministic policy owns decisions; LLM is explanation-only with no write tools                                                                                               | Capability tests and mutation review                                   | OPEN                   |
| R-24 | Free API outage or rate limiting corrupts route state                              | High     | Cache, bounded retry, direct onchain fallback, freshness gates, fail closed                                                                                                    | Provider outage integration tests                                      | OPEN                   |
| R-25 | Indexed API disagrees with current chain state                                     | Critical | Execution-time direct contract reads at recorded blocks                                                                                                                        | Mismatch and stale-data tests                                          | OPEN                   |
| R-26 | User-supplied AI API key leaks                                                     | Critical | Memory-only handling, redaction, no persistence, no telemetry                                                                                                                  | Log, storage, and error-path tests                                     | OPEN                   |
| R-27 | Custom AI endpoint enables SSRF                                                    | Critical | Presets by default, HTTPS enforcement, DNS/IP validation, private-network denial, explicit local mode                                                                          | URL mutation and network-boundary tests                                | OPEN                   |
| R-28 | Remote AI receives sensitive or unnecessary data                                   | High     | Minimal structured public inputs, field allowlist, no signatures/keys/session data                                                                                             | Payload snapshot tests                                                 | OPEN                   |
| R-29 | Development lint dependency has a glob-amplification advisory                      | Medium   | Run lint only against trusted repository paths, exclude generated/untrusted trees, require zero production audit findings, and monitor for a compatible minimatch/ESLint patch | `npm audit --omit=dev` and lint-input review                           | MITIGATED / MONITORING |
| R-30 | Destination capacity cannot cover principal, solver fee, and financed costs        | Critical | Mandatory reconciled feasibility model, stricter protocol/policy/liquidity/signed capacity minimum, zero-shortfall gate before reservation and source close                    | Boundary unit tests, fork capacity tests, and reservation negative E2E | OPEN                   |
| R-31 | Unconfirmed or unavailable borrower contribution is treated as funding             | Critical | Migration-specific escrow, finalized balance evidence, exact asset/chain/use/refund binding, no wallet-balance or promise credit                                               | Funding finality, mismatch, expiry, and isolation tests                | OPEN                   |
| R-32 | Destination price, liquidity, rate, or risk limit deteriorates after source close  | Critical | Conservative buffers, short quote life, checkpoint revalidation, signed recovery sources, exposure caps, no unsafe borrow                                                      | Price/liquidity shock E2E and recovery drills                          | OPEN                   |
| R-33 | A cost is omitted or counted twice across principal, fees, and external funding    | High     | Typed component ledger, unique component IDs, exclusive classification, sources-and-uses reconciliation                                                                        | Mutation, property, and ledger-invariant tests                         | OPEN                   |
| R-34 | Smart contracts are described as guaranteeing cross-chain solver repayment         | High     | Explicit non-atomicity disclosure, residual receivable states, loss/exposure policy, UI and documentation review                                                               | Content review and failed-settlement E2E                               | OPEN                   |
| R-35 | Wallet address selection or session replay exposes another borrower's data/actions | Critical | One-time EIP-4361 challenges, opaque hashed sessions, strict cookies, expiry/revocation, and borrower ownership checks                                                         | Auth replay, revocation, mismatch, and full-stack smoke tests          | MITIGATED              |

## Security review gates

### Before contract-backed sandbox asset movement

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

### Before any real funds

- All critical and high risks applicable to the initial route closed or explicitly accepted with
  bounded exposure and evidence; no unknown critical risk is accepted.
- Independent audit status disclosed. If no audit can be completed before the submission, do not
  describe the system as audited or production ready, and require explicit owner acceptance of the
  small fixed maximum exposure before deployment/execution.
- Production incident and recovery drills complete.
- Solver credit, timeout, and loss allocation defined outside code where necessary.
- Zero-shortfall feasibility, secured supplementary funding, capacity-loss recovery, and solver
  exposure limits independently reviewed and exercised.
- Product and operator materials state that cross-chain execution is non-atomic and repayment is not
  guaranteed solely by smart contracts.
- Explicit approval recorded in `08-progress-and-decisions.md`.
- Mainnet contracts and services deployed with writes disabled; bytecode, roles, balances, route
  identities, and every intended transaction simulation verified before the switch is enabled.
