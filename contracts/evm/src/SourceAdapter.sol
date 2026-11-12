// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { MigrationEscrow } from "./MigrationEscrow.sol";
import { DebtShiftHashing } from "./DebtShiftHashing.sol";
import { TestLiquidityVault } from "./TestLiquidityVault.sol";
import { IERC20 } from "./interfaces/IERC20.sol";
import { ISourceLending } from "./interfaces/ISourceLending.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { SignatureChecker } from "./libraries/SignatureChecker.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

contract SourceAdapter is ReentrancyGuard {
    using SafeToken for IERC20;

    error Unauthorized();
    error Paused();
    error Expired();
    error MigrationAlreadyConsumed();
    error AssetMismatch();
    error InvalidPlan();
    error InvalidSignature();
    error NonceAlreadyConsumed();

    address public owner;
    bool public paused;
    TestLiquidityVault public immutable vault;
    ISourceLending public immutable lending;
    MigrationEscrow public immutable escrow;
    IERC20 public immutable debtToken;
    IERC20 public immutable collateralToken;
    mapping(address executor => bool allowed) public executors;
    mapping(bytes32 migrationId => bool consumed) public consumedMigrations;
    mapping(address borrower => mapping(uint256 nonce => bool consumed)) public consumedNonces;

    event SourceClosed(
        bytes32 indexed migrationId,
        address indexed borrower,
        uint256 repaidDebtUnits,
        uint256 releasedCollateralUnits
    );
    event ExecutionPlanConsumed(
        bytes32 indexed migrationId,
        bytes32 indexed planHash,
        address indexed borrower,
        uint256 nonce
    );
    event MigrationAuthorized(
        bytes32 indexed migrationId,
        bytes32 indexed planHash,
        address indexed borrower,
        uint256 nonce
    );

    constructor(
        address owner_,
        TestLiquidityVault vault_,
        ISourceLending lending_,
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

    function executionPlanHash(DebtShiftHashing.ExecutionPlanHashInput calldata plan)
        external
        view
        returns (bytes32)
    {
        return DebtShiftHashing.hashExecutionPlan(plan, block.chainid, address(this));
    }

    function closeSource(
        DebtShiftHashing.ExecutionPlanHashInput calldata plan,
        bytes calldata borrowerSignature
    ) external nonReentrant returns (uint256 repaidDebtUnits, uint256 collateralUnits) {
        if (!executors[msg.sender]) revert Unauthorized();
        if (paused) revert Paused();
        if (block.timestamp > plan.deadline) revert Expired();
        if (consumedMigrations[plan.migrationId]) revert MigrationAlreadyConsumed();
        if (consumedNonces[plan.borrower][plan.nonce]) revert NonceAlreadyConsumed();
        if (
            plan.migrationId
                    != DebtShiftHashing.computeMigrationId(
                        plan.intentHash, plan.transportQuoteHash, plan.nonce
                    ) || plan.borrower == address(0) || plan.sourceRepaymentMax == 0
                || plan.sourceCollateralMin == 0 || plan.principalMax < plan.sourceRepaymentMax
        ) revert InvalidPlan();

        bytes32 planHash = DebtShiftHashing.hashExecutionPlan(plan, block.chainid, address(this));
        if (!SignatureChecker.isValidSignatureNow(plan.borrower, planHash, borrowerSignature)) {
            revert InvalidSignature();
        }
        vault.assertExecutable(plan.migrationId, planHash);

        consumedMigrations[plan.migrationId] = true;
        consumedNonces[plan.borrower][plan.nonce] = true;
        uint256 fundedUnits = vault.draw(plan.migrationId, address(this));
        if (fundedUnits > plan.principalMax || fundedUnits < plan.sourceRepaymentMax) {
            revert AssetMismatch();
        }

        debtToken.forceApprove(address(lending), fundedUnits);
        (repaidDebtUnits, collateralUnits) = lending.closePosition(
            plan.borrower, plan.sourceRepaymentMax, plan.sourceCollateralMin, address(this)
        );

        uint256 unusedUnits = fundedUnits - repaidDebtUnits;
        if (unusedUnits != 0) {
            debtToken.forceApprove(address(vault), unusedUnits);
            vault.returnUnused(plan.migrationId, unusedUnits);
        }

        collateralToken.forceApprove(address(escrow), collateralUnits);
        escrow.assign(plan.migrationId, collateralToken, address(this), collateralUnits);
        emit ExecutionPlanConsumed(plan.migrationId, planHash, plan.borrower, plan.nonce);
        emit MigrationAuthorized(plan.migrationId, planHash, plan.borrower, plan.nonce);
        emit SourceClosed(plan.migrationId, plan.borrower, repaidDebtUnits, collateralUnits);
    }
}
