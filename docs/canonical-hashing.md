# Canonical hashing and cross-language fixture

DebtShift never hashes JSON, display strings, floating-point values, or implementation-specific object layouts. Version 1 identifiers use explicit EVM ABI encoding and Keccak-256. User authorizations use EIP-712 with domain name `DebtShift`, version `1`, the source chain ID, and the source-chain authorization contract.

The machine-readable fixture is [`fixtures/canonical-hashes-v2.json`](./fixtures/canonical-hashes-v2.json). Its outputs are independently reproduced by:

- TypeScript: `packages/domain/src/domain.test.ts`, using the production functions in `packages/domain/src/hashing.ts`.
- Solidity: `contracts/evm/test/CanonicalHashFixture.t.sol`, using `contracts/evm/src/DebtShiftHashing.sol`.
- Rust: `contracts/near/registry/src/lib.rs`, which independently ABI-encodes the fixed-width migration-ID fields and runs NEAR's Keccak-256 host function.

## Version 1 encodings

| Identifier                  | Exact preimage                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Protocol ID                 | UTF-8 bytes of the versioned canonical protocol name                                                   |
| Market reference            | `abi.encode(uint256 chainId, bytes32 protocolId, address deployment, bytes32 marketId)`                |
| Token reference             | `abi.encode(uint256 chainId, address token, uint8 decimals)`                                           |
| Source position             | `abi.encode(bytes32 marketHash, address borrower, bytes32 collateralHash, bytes32 debtHash)`           |
| Allowed targets             | ABI-encoded, lexicographically sorted `bytes32[]` market hashes                                        |
| Migration ID                | `abi.encode(bytes32 intentHash, bytes32 transportQuoteHash, uint256 planNonce)`                        |
| Route hash                  | The exact ordered route fields in `computeRouteHash`; text fields are NFC-normalized before Keccak-256 |
| Intent and execution hashes | Standard EIP-712 digest of the versioned type definitions in `packages/domain/src/hashing.ts`          |

Any change to field order, type width, canonical name, normalization rule, or EIP-712 domain is a breaking encoding change and requires a new fixture version. Existing signed intents remain bound to version 1.

## Verification

Run:

```text
npm run test --workspace @debtshift/domain
forge test --root contracts/evm --match-contract CanonicalHashFixtureTest
cargo test --manifest-path contracts/near/Cargo.toml --workspace
```

All three checks must pass before a contract, registry, or SDK release.
