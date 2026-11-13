# Contract-backed sandbox evidence example

## Purpose and scope

This record shows the expected evidence shape for one complete DebtShift sandbox migration. It is a
reproducible engineering example, not proof of a public testnet or mainnet refinance. The source and
destination are private Anvil chains (`31337` and `31338`), and the unavailable external 1Click
boundary is explicitly represented by `DEBTSHIFT_SIMULATOR`. Every asset-moving leg below is still a
real finalized transaction against deployed local contracts.

## Capture metadata

| Field                         | Captured value                                                            |
| ----------------------------- | ------------------------------------------------------------------------- |
| Captured                      | 2026-11-13                                                                |
| Runtime mode                  | `sandbox`                                                                 |
| Migration ID                  | `0x47f738fb20f8adc1733e1c12ba2ef36d69917b6d2ac42d0a6406ffc1723ac40b`      |
| Application image             | `sha256:9109c9619b29d319498c60de3d7c327098a2f78222171b56b66dddffa416442d` |
| BuildKit attestation manifest | `sha256:e7a95e643ac1048ee1b72bf9a4d5bfff0bffcf008ca2b0cc92ad5dcc396e7b8c` |
| Rebuild command               | `npm run infra:up`                                                        |
| Acceptance command            | `npm run smoke:local`                                                     |
| Terminal workflow phase       | `SETTLED`                                                                 |
| Evidence records              | `17`                                                                      |
| Ledger entries                | `16`                                                                      |
| Unexplained imbalance         | `0` base units                                                            |
| Session / SSE / metrics       | all verified                                                              |

The image downloads Foundry `1.9.0` from the signed upstream release and checks the Linux archive
against SHA-256 `8d17599b42e3139f1a9c171be3798c4ed8e743ae17b84cc3435e57bf2a51ae99`
before extraction. The runtime image retains Anvil but removes Forge, Cast, Chisel, npm, Corepack,
Yarn, and build-only download tooling.

## Persisted evidence

All entries were read back from PostgreSQL after the smoke command returned. Empty transaction
cells are signed or observed offchain evidence; transaction-bearing entries are finalized against
the stated private chain. Repeated transaction hashes are intentional where one atomic contract
transaction produces multiple independently typed evidence records.

| Evidence type                  | Chain   | Evidence ID                                                          | Transaction hash                                                     |
| ------------------------------ | ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `SOURCE_POSITION_SNAPSHOT`     | `31337` | `0xe31b42cd34d5e749e8bec524d6569d44e0187c850604e5fe69218bcef3ba3207` | -                                                                    |
| `FINANCING_FEASIBILITY`        | -       | `0x7fcf2335cb83ce17b5438cdf87729041366989e9a5e7c555f7e6bf8012906b8b` | -                                                                    |
| `INTENT_AUTHORIZATION`         | -       | `0xe6fdaa990937d6bde1223b5b44352cb7d697ec63a744e694bb43ffeb34f3d5a8` | -                                                                    |
| `EXECUTION_PLAN_AUTHORIZATION` | -       | `0x58ee45c547e6a8169e3bd4d071cf6ffb05edd74c8684d1bb09e0c3b613c9042c` | -                                                                    |
| `SOURCE_LENDING_AUTHORIZATION` | -       | `0x02753973b14354748e72e7dac8c5c694a77cc7e9d8692249f5f1738fb28dcd85` | -                                                                    |
| `ROUTE_QUOTE`                  | -       | `0xbc7191a471a59e1a0eb231daf1f79430b3c828722b1b77b452488600d204bfa7` | -                                                                    |
| `FINANCING_REVALIDATION`       | `31337` | `0x50f6017f82793cbd64591dc820523df831282218a6b8ae54c5b8ccc9b1185f92` | `0xf8ab7102ac85aa1aa77250de6f373b1ebf58ce1fde2b79ebd43154838d52119b` |
| `LIQUIDITY_RESERVATION`        | `31337` | `0x0e390a3209c70e351a598a93243571f5bba0597ec57214333e14c875cd02e045` | `0xf8ab7102ac85aa1aa77250de6f373b1ebf58ce1fde2b79ebd43154838d52119b` |
| `FINANCING_REVALIDATION`       | `31337` | `0x470a509a6c5598f9fa405ae776f2eda1a234ab6459b831c7c8f8b9e86683b443` | `0x7f904352c5121925318b6f7de7d35b9cecbeddf982522cdee1f7355224c0aa83` |
| `SOURCE_CLOSE`                 | `31337` | `0x6059a05b755f73aa3b2cd7bd626c90d118eb3fa0f24bac44e94ee73e3a3ecc46` | `0x7f904352c5121925318b6f7de7d35b9cecbeddf982522cdee1f7355224c0aa83` |
| `TRANSPORT_ORIGIN`             | `31337` | `0xd476ddf16f331df5f6b48ab12bfe95bed86736961714713c8b9cbf98cd95bb9e` | `0x99b10ce436262dd475b2c1b258752a9de144c01b67d7849ea712053d758aee01` |
| `TRANSPORT_DESTINATION`        | `31338` | `0x7c485cb0b2a8305c1693a0ec89dcf66030ad1662551386b62057969117d78c2d` | `0xd2b53ae3d8e380ee457797903c30e5a1be5ec03000c3b3afc8e3bd28fc81cc37` |
| `FINANCING_REVALIDATION`       | `31338` | `0x8efce94ce33942d2d30c13052689bcdd7166aeb1ebd371cc315787f8ae82fbd0` | `0x881f61c1d9f88e5deeced42639cb71b55f4df5dc4e453f9b43c5f891d19cd311` |
| `TARGET_POSITION`              | `31338` | `0x64e32d39c421c03a5cb88dfa67d3bedcc43175d9e2052c356ef9c66870b869ff` | `0x881f61c1d9f88e5deeced42639cb71b55f4df5dc4e453f9b43c5f891d19cd311` |
| `FINANCING_REVALIDATION`       | `31337` | `0xb0503a8abf30951150370356bc17b0c2233dd99565d6bb34efb28b652877ee38` | `0x02d9fbeed1e34edf135fb49a4ded5a2f8789c12a2fe0aa8b77c1ee54ade85ba1` |
| `LIQUIDITY_SETTLEMENT`         | `31337` | `0x1055f64ac4c9a49a5a7d9fba825722fee9139934c56c050acb20e30bee5ac860` | `0x02d9fbeed1e34edf135fb49a4ded5a2f8789c12a2fe0aa8b77c1ee54ade85ba1` |
| `LEDGER_RECONCILIATION`        | `31337` | `0xe23628cc1239ee27c76660030efdd8aa50ac1fe23a426cdea3836b1db6f9ec36` | `0x02d9fbeed1e34edf135fb49a4ded5a2f8789c12a2fe0aa8b77c1ee54ade85ba1` |

Every row had `verification_state=FINALIZED`. The workflow stops at `SETTLED`, not `COMPLETED`,
because no NEAR registry account or signer is configured in the local Compose environment. That is
the intended fail-closed boundary: the application does not fabricate a registry receipt.

## Reproduction and promotion rule

Run `npm run infra:up` followed by `npm run smoke:local`. A new migration ID and new local-chain
transaction hashes are expected after the chains restart; the evidence types, phase, accounting,
and verification invariants must remain the same. This example may be promoted to public evidence
only by replacing the private-chain hashes with explorer-verifiable public testnet transactions and
adding the matching NEAR testnet receipt. It must never be relabeled as mainnet evidence.
