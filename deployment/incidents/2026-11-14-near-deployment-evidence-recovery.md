# NEAR testnet registry evidence recovery

## Status

The registry deployment and initialization succeeded atomically. Only the original local
post-deployment evidence reader failed. The manifest was recovered through read-only verification;
no second deployment or state mutation occurred.

## Final transaction

- Source commit: `7d6fd5c756b626cb791efbcf39c9662eee9e0262`
- Registry: `debtshift-registry-alaa-2026.testnet`
- Owner: `debtshift-owner-alaa-2026.testnet`
- Initial verifier: `debtshift-verifier-alaa-2026.testnet`
- Transaction: `Fjtfg2derYBQ7Mt2wmyh5XnHUQGkwCw4WmqBPxZFaQnQ`
- Final block height: `277602998`
- Final block hash: `Cu5hXsCMEo4JrMoBFDxNRy7wSauVSeNW5myjxikxxkxG`
- WASM SHA-256: `0x4a9adf1ed8f95b047b2f99e9ec296484540f3571147af3e761d1ecabdc0ef56d`
- NEAR deployed-code hash: `62E942bp8fnX38QhB552175SKUGr7WmAkachMzno4toW`
- Initial storage usage: `232100`
- Mainnet execution: disabled

The finalized transaction contains exactly two actions: the reviewed deploy-code hash and `new`
with 100 Tgas, zero deposit, the reviewed owner, and the single reviewed verifier. Final contract
bytes, owner, null pending owner, verifier set, storage, transaction identity, block, and success
status were all re-read before the manifest was created.

## Reader failure and correction

The contract allows verifier-list pages of at most `50`, while both post-deployment readers
requested `64`. The already-final deployment therefore returned `Page limit exceeds maximum` only
when the local script tried to inspect state after the transaction. Both readers now request `50`,
and the readiness test asserts that exact bounded query.

The recovered manifest is `near-testnet-registry-20261114-v1.json`. It records the original final
transaction and source commit and keeps `workflowWriteSwitchEnabled` false.
