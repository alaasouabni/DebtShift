// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { DebtShiftHashing } from "./DebtShiftHashing.sol";
import { MigrationEscrow } from "./MigrationEscrow.sol";
import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { SignatureChecker } from "./libraries/SignatureChecker.sol";
import { MockTargetLending } from "./mocks/MockTargetLending.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

contract DestinationAdapter is ReentrancyGuard {
    using SafeToken for IERC20;

    error Unauthorized();
    error Paused();
    error Expired();
    error MigrationAlreadyConsumed();
    error NonceAlreadyConsumed();
    error AmountOutsideAuthorization();
    error InvalidSignature();
    error InvalidPlan();
    error InvalidFeasibility();
    error StaleFeasibility();
    error FeasibilityMismatch();

    struct OpenTerms {
        uint256 sourceChainId;
        address sourceAdapter;
        uint256 collateralUnits;
        uint256 borrowUnits;
        bytes32 feasibilityHash;
        bytes32 fundingEvidenceHash;
        uint256 solverPrincipalUnits;
        uint256 solverFeeUnits;
        uint256 capitalizedCostUnits;
        address capitalizedCostReceiver;
    }

    struct FeasibilityEvidence {
        bytes32 planHash;
        bytes32 analysisHash;
        bytes32 externalFundingEvidenceHash;
        address settlementAsset;
        uint256 solverPrincipalUnits;
        uint256 solverFeeUnits;
        uint256 capitalizedCostUnits;
        uint256 totalRequiredUnits;
        uint256 confirmedExternalFundingUnits;
        uint256 maximumSafeBorrowingCapacityUnits;
        uint256 requiredDestinationBorrowUnits;
        uint256 fundingShortfallUnits;
        uint64 sequence;
        uint64 evaluatedAt;
        uint64 validUntil;
    }

    address public owner;
    bool public paused;
    MockTargetLending public immutable lending;
    MigrationEscrow public immutable escrow;
    IERC20 public immutable debtToken;
    IERC20 public immutable collateralToken;
    mapping(address executor => bool allowed) public executors;
    mapping(address verifier => bool allowed) public verifiers;
    mapping(bytes32 planDomain => bool allowed) public planDomains;
    mapping(bytes32 migrationId => bool consumed) public consumedMigrations;
    mapping(address borrower => mapping(uint256 nonce => bool consumed)) public consumedNonces;
    mapping(bytes32 migrationId => FeasibilityEvidence evidence) private _latestFeasibility;
    mapping(bytes32 migrationId => bytes32 evidenceHash) public latestFeasibilityHash;
    mapping(bytes32 migrationId => uint64 sequence) public latestFeasibilitySequence;

    event DestinationPlanDomainConfigured(
        uint256 indexed sourceChainId, address indexed sourceAdapter, bool allowed
    );
    event DestinationFeasibilityRecorded(
        bytes32 indexed migrationId,
        bytes32 indexed planHash,
        bytes32 indexed feasibilityHash,
        address verifier,
        uint256 fundingShortfallUnits,
        uint64 sequence,
        uint64 evaluatedAt,
        uint64 validUntil
    );
    event DestinationOpened(
        bytes32 indexed migrationId,
        address indexed borrower,
        bytes32 indexed planHash,
        uint256 collateralUnits,
        uint256 debtUnits
    );
    event LiquidityPayout(
        bytes32 indexed migrationId,
        address indexed receiver,
        address indexed asset,
        uint256 principalUnits,
        uint256 feeUnits
    );
    event DestinationSettlementCompleted(
        bytes32 indexed migrationId,
        bytes32 indexed planHash,
        bytes32 indexed feasibilityHash,
        bytes32 fundingEvidenceHash,
        uint256 borrowedUnits,
        uint256 supplementaryFundingUnits,
        uint256 capitalizedCostUnits
    );

    constructor(address owner_, MockTargetLending lending_, MigrationEscrow escrow_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
        executors[owner_] = true;
        verifiers[owner_] = true;
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

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        verifiers[verifier] = allowed;
    }

    function setPlanDomain(uint256 sourceChainId, address sourceAdapter, bool allowed)
        external
        onlyOwner
    {
        if (sourceChainId == 0 || sourceAdapter == address(0)) revert InvalidPlan();
        planDomains[_planDomain(sourceChainId, sourceAdapter)] = allowed;
        emit DestinationPlanDomainConfigured(sourceChainId, sourceAdapter, allowed);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    function latestFeasibility(bytes32 migrationId)
        external
        view
        returns (FeasibilityEvidence memory)
    {
        return _latestFeasibility[migrationId];
    }

    function recordFeasibility(bytes32 migrationId, FeasibilityEvidence calldata evidence)
        external
        returns (bytes32 feasibilityHash)
    {
        if (!verifiers[msg.sender]) revert Unauthorized();
        _validateFeasibilityShape(migrationId, evidence);

        FeasibilityEvidence storage current = _latestFeasibility[migrationId];
        feasibilityHash = keccak256(abi.encode(migrationId, evidence));
        if (current.evaluatedAt != 0) {
            if (evidence.sequence == current.sequence) {
                if (latestFeasibilityHash[migrationId] != feasibilityHash) {
                    revert StaleFeasibility();
                }
                return feasibilityHash;
            }
            if (
                evidence.sequence != current.sequence + 1
                    || evidence.evaluatedAt < current.evaluatedAt
            ) revert StaleFeasibility();
        } else if (evidence.sequence != 1) {
            revert StaleFeasibility();
        }

        _latestFeasibility[migrationId] = evidence;
        latestFeasibilityHash[migrationId] = feasibilityHash;
        latestFeasibilitySequence[migrationId] = evidence.sequence;
        emit DestinationFeasibilityRecorded(
            migrationId,
            evidence.planHash,
            feasibilityHash,
            msg.sender,
            evidence.fundingShortfallUnits,
            evidence.sequence,
            evidence.evaluatedAt,
            evidence.validUntil
        );
    }

    function openDestination(
        DebtShiftHashing.ExecutionPlanHashInput calldata plan,
        bytes calldata borrowerSignature,
        OpenTerms calldata terms
    ) external nonReentrant {
        if (!executors[msg.sender]) revert Unauthorized();
        if (paused) revert Paused();
        bytes32 planHash = _validatePlan(plan, borrowerSignature, terms);
        _validateCurrentFeasibility(plan, planHash, terms);

        consumedMigrations[plan.migrationId] = true;
        consumedNonces[plan.borrower][plan.nonce] = true;
        escrow.release(plan.migrationId, collateralToken, address(this), terms.collateralUnits);
        collateralToken.forceApprove(address(lending), terms.collateralUnits);
        lending.openPosition(
            plan.borrower, address(this), address(this), terms.collateralUnits, terms.borrowUnits
        );
        debtToken.forceApprove(address(escrow), terms.borrowUnits);
        escrow.assignLoanProceeds(plan.migrationId, debtToken, terms.borrowUnits);
        escrow.settle(
            MigrationEscrow.SettlementTerms({
                migrationId: plan.migrationId,
                token: debtToken,
                fundingEvidenceHash: terms.fundingEvidenceHash,
                solverPayoutReceiver: plan.payoutReceiver,
                capitalizedCostReceiver: terms.capitalizedCostReceiver,
                residualReceiver: plan.refundReceiver,
                solverPrincipalUnits: terms.solverPrincipalUnits,
                solverFeeUnits: terms.solverFeeUnits,
                capitalizedCostUnits: terms.capitalizedCostUnits
            })
        );

        FeasibilityEvidence storage evidence = _latestFeasibility[plan.migrationId];
        emit DestinationOpened(
            plan.migrationId, plan.borrower, planHash, terms.collateralUnits, terms.borrowUnits
        );
        emit LiquidityPayout(
            plan.migrationId,
            plan.payoutReceiver,
            address(debtToken),
            terms.solverPrincipalUnits,
            terms.solverFeeUnits
        );
        emit DestinationSettlementCompleted(
            plan.migrationId,
            planHash,
            terms.feasibilityHash,
            terms.fundingEvidenceHash,
            terms.borrowUnits,
            evidence.confirmedExternalFundingUnits,
            terms.capitalizedCostUnits
        );
    }

    function _validatePlan(
        DebtShiftHashing.ExecutionPlanHashInput calldata plan,
        bytes calldata borrowerSignature,
        OpenTerms calldata terms
    ) private view returns (bytes32 planHash) {
        if (block.timestamp > plan.deadline) revert Expired();
        if (consumedMigrations[plan.migrationId]) revert MigrationAlreadyConsumed();
        if (consumedNonces[plan.borrower][plan.nonce]) revert NonceAlreadyConsumed();
        if (
            plan.borrower == address(0) || plan.destinationReceiver != address(escrow)
                || plan.refundReceiver == address(0) || plan.payoutReceiver == address(0)
                || plan.migrationId
                    != DebtShiftHashing.computeMigrationId(
                        plan.intentHash, plan.transportQuoteHash, plan.nonce
                    ) || !planDomains[_planDomain(terms.sourceChainId, terms.sourceAdapter)]
        ) revert InvalidPlan();
        if (
            terms.collateralUnits < plan.minDestinationCollateral || terms.borrowUnits == 0
                || terms.borrowUnits > plan.targetDebtMax
                || terms.solverPrincipalUnits > plan.principalMax
                || terms.solverFeeUnits > plan.feeMax
                || (terms.capitalizedCostUnits == 0 && terms.capitalizedCostReceiver != address(0))
                || (terms.capitalizedCostUnits != 0 && terms.capitalizedCostReceiver == address(0))
        ) revert AmountOutsideAuthorization();

        planHash =
            DebtShiftHashing.hashExecutionPlan(plan, terms.sourceChainId, terms.sourceAdapter);
        if (!SignatureChecker.isValidSignatureNow(plan.borrower, planHash, borrowerSignature)) {
            revert InvalidSignature();
        }
    }

    function _validateCurrentFeasibility(
        DebtShiftHashing.ExecutionPlanHashInput calldata plan,
        bytes32 planHash,
        OpenTerms calldata terms
    ) private view {
        FeasibilityEvidence storage evidence = _latestFeasibility[plan.migrationId];
        if (
            latestFeasibilityHash[plan.migrationId] != terms.feasibilityHash
                || evidence.planHash != planHash || evidence.settlementAsset != address(debtToken)
                || evidence.externalFundingEvidenceHash != terms.fundingEvidenceHash
                || evidence.solverPrincipalUnits != terms.solverPrincipalUnits
                || evidence.solverFeeUnits != terms.solverFeeUnits
                || evidence.capitalizedCostUnits != terms.capitalizedCostUnits
                || evidence.requiredDestinationBorrowUnits != terms.borrowUnits
                || evidence.fundingShortfallUnits != 0
                || evidence.requiredDestinationBorrowUnits
                    > evidence.maximumSafeBorrowingCapacityUnits
                || block.timestamp > evidence.validUntil
        ) revert FeasibilityMismatch();
    }

    function _validateFeasibilityShape(bytes32 migrationId, FeasibilityEvidence calldata evidence)
        private
        view
    {
        if (
            migrationId == bytes32(0) || evidence.planHash == bytes32(0)
                || evidence.analysisHash == bytes32(0)
                || evidence.settlementAsset != address(debtToken)
                || evidence.solverPrincipalUnits == 0 || evidence.sequence == 0
                || evidence.evaluatedAt > block.timestamp
                || evidence.validUntil < evidence.evaluatedAt
                || (evidence.confirmedExternalFundingUnits == 0
                    && evidence.externalFundingEvidenceHash != bytes32(0))
                || (evidence.confirmedExternalFundingUnits != 0
                    && evidence.externalFundingEvidenceHash == bytes32(0))
        ) revert InvalidFeasibility();

        uint256 totalRequired =
            evidence.solverPrincipalUnits + evidence.solverFeeUnits + evidence.capitalizedCostUnits;
        uint256 requiredBorrow = totalRequired > evidence.confirmedExternalFundingUnits
            ? totalRequired - evidence.confirmedExternalFundingUnits
            : 0;
        uint256 totalAvailable =
            evidence.maximumSafeBorrowingCapacityUnits + evidence.confirmedExternalFundingUnits;
        uint256 shortfall = totalRequired > totalAvailable ? totalRequired - totalAvailable : 0;
        if (
            evidence.totalRequiredUnits != totalRequired
                || evidence.requiredDestinationBorrowUnits != requiredBorrow
                || evidence.fundingShortfallUnits != shortfall
        ) revert InvalidFeasibility();
    }

    function _planDomain(uint256 sourceChainId, address sourceAdapter)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(sourceChainId, sourceAdapter));
    }
}
