// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library DebtShiftTypes {
    enum MigrationPhase {
        DRAFT,
        QUOTED,
        AUTHORIZED,
        RESERVED,
        SOURCE_CLOSED,
        ROUTING,
        DEST_FUNDED,
        TARGET_OPEN,
        SETTLED,
        COMPLETED,
        RECOVERY,
        FAILED_SAFE,
        EXPIRED
    }

    struct AssetRef {
        uint256 chainId;
        address token;
        uint8 decimals;
    }
}
