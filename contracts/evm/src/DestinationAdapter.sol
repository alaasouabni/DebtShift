// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { MigrationEscrow } from "./MigrationEscrow.sol";
import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { MockTargetLending } from "./mocks/MockTargetLending.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

contract DestinationAdapter is ReentrancyGuard {
    using SafeToken for IERC20;

    error Unauthorized();
    error Paused();
    error Expired();
    error MigrationAlreadyConsumed();
    error AmountOutsideAuthorization();

    struct OpenTerms {
        bytes32 migrationId;
        address borrower;
        address payoutReceiver;
        uint256 collateralUnits;
        uint256 minimumCollateralUnits;
        uint256 borrowUnits;
        uint256 maximumDebtUnits;
        uint64 deadline;
    }

    address public owner;
    bool public paused;
    MockTargetLending public immutable lending;
    MigrationEscrow public immutable escrow;
    IERC20 public immutable debtToken;
    IERC20 public immutable collateralToken;
    mapping(address executor => bool allowed) public executors;
    mapping(bytes32 migrationId => bool consumed) public consumedMigrations;

    event DestinationOpened(
        bytes32 indexed migrationId,
        address indexed borrower,
        uint256 collateralUnits,
        uint256 debtUnits
    );
    event LiquidityPayout(
        bytes32 indexed migrationId,
        address indexed receiver,
        address indexed asset,
        uint256 amountUnits
    );

    constructor(address owner_, MockTargetLending lending_, MigrationEscrow escrow_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
        executors[owner_] = true;
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

    function openDestination(OpenTerms calldata terms) external nonReentrant {
        if (!executors[msg.sender]) revert Unauthorized();
        if (paused) revert Paused();
        if (block.timestamp > terms.deadline) revert Expired();
        if (consumedMigrations[terms.migrationId]) revert MigrationAlreadyConsumed();
        if (
            terms.collateralUnits < terms.minimumCollateralUnits || terms.borrowUnits == 0
                || terms.borrowUnits > terms.maximumDebtUnits
        ) revert AmountOutsideAuthorization();

        consumedMigrations[terms.migrationId] = true;
        escrow.release(terms.migrationId, collateralToken, address(this), terms.collateralUnits);
        collateralToken.forceApprove(address(lending), terms.collateralUnits);
        lending.openPosition(
            terms.borrower, address(this), address(this), terms.collateralUnits, terms.borrowUnits
        );
        debtToken.safeTransfer(terms.payoutReceiver, terms.borrowUnits);

        emit DestinationOpened(
            terms.migrationId, terms.borrower, terms.collateralUnits, terms.borrowUnits
        );
        emit LiquidityPayout(
            terms.migrationId, terms.payoutReceiver, address(debtToken), terms.borrowUnits
        );
    }
}
