// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { MigrationEscrow } from "./MigrationEscrow.sol";
import { TestLiquidityVault } from "./TestLiquidityVault.sol";
import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { MockSourceLending } from "./mocks/MockSourceLending.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

contract SourceAdapter is ReentrancyGuard {
    using SafeToken for IERC20;

    error Unauthorized();
    error Paused();
    error Expired();
    error MigrationAlreadyConsumed();
    error AssetMismatch();

    struct CloseTerms {
        bytes32 migrationId;
        address borrower;
        uint256 maximumDebtUnits;
        uint256 minimumCollateralUnits;
        uint64 deadline;
    }

    address public owner;
    bool public paused;
    TestLiquidityVault public immutable vault;
    MockSourceLending public immutable lending;
    MigrationEscrow public immutable escrow;
    IERC20 public immutable debtToken;
    IERC20 public immutable collateralToken;
    mapping(address executor => bool allowed) public executors;
    mapping(bytes32 migrationId => bool consumed) public consumedMigrations;

    event SourceClosed(
        bytes32 indexed migrationId,
        address indexed borrower,
        uint256 repaidDebtUnits,
        uint256 releasedCollateralUnits
    );

    constructor(
        address owner_,
        TestLiquidityVault vault_,
        MockSourceLending lending_,
        MigrationEscrow escrow_
    ) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
        executors[owner_] = true;
        vault = vault_;
        lending = lending_;
        escrow = escrow_;
        debtToken = lending_.debtToken();
        collateralToken = lending_.collateralToken();
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function setExecutor(address executor, bool allowed) external onlyOwner {
        executors[executor] = allowed;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    function closeSource(CloseTerms calldata terms)
        external
        nonReentrant
        returns (uint256 repaidDebtUnits, uint256 collateralUnits)
    {
        if (!executors[msg.sender]) revert Unauthorized();
        if (paused) revert Paused();
        if (block.timestamp > terms.deadline) revert Expired();
        if (consumedMigrations[terms.migrationId]) revert MigrationAlreadyConsumed();

        consumedMigrations[terms.migrationId] = true;
        uint256 fundedUnits = vault.draw(terms.migrationId, address(this));
        if (fundedUnits > terms.maximumDebtUnits) revert AssetMismatch();

        debtToken.forceApprove(address(lending), fundedUnits);
        (repaidDebtUnits, collateralUnits) = lending.closePosition(
            terms.borrower, terms.maximumDebtUnits, terms.minimumCollateralUnits, address(this)
        );

        uint256 unusedUnits = fundedUnits - repaidDebtUnits;
        if (unusedUnits != 0) {
            debtToken.forceApprove(address(vault), unusedUnits);
            vault.returnUnused(terms.migrationId, unusedUnits);
        }

        collateralToken.forceApprove(address(escrow), collateralUnits);
        escrow.assign(terms.migrationId, collateralToken, address(this), collateralUnits);
        emit SourceClosed(terms.migrationId, terms.borrower, repaidDebtUnits, collateralUnits);
    }
}
