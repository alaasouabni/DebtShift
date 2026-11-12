// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { DebtShiftHashing } from "../src/DebtShiftHashing.sol";
import { DestinationAdapter } from "../src/DestinationAdapter.sol";
import { MigrationEscrow } from "../src/MigrationEscrow.sol";
import { SourceAdapter } from "../src/SourceAdapter.sol";
import { LiquidityVault } from "../src/LiquidityVault.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";
import { MockEip1271Wallet } from "../src/mocks/MockEip1271Wallet.sol";
import { MockSourceLending } from "../src/mocks/MockSourceLending.sol";
import { MockTargetLending } from "../src/mocks/MockTargetLending.sol";
import { TestToken } from "../src/mocks/TestToken.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function getRecordedLogs() external returns (Log[] memory logs);
    function prank(address sender) external;
    function recordLogs() external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract SimulatedRefinanceTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant BORROWER_KEY = 0xA11CE;
    uint256 internal constant SOURCE_DEBT = 10_000_000_000;
    uint256 internal constant SOURCE_COLLATERAL = 10 ether;
    uint256 internal constant DESTINATION_COLLATERAL = 9.9 ether;
    uint256 internal constant DESTINATION_DEBT = 10_050_000_000;
    uint256 internal constant SOLVER_FEE = 50_000_000;

    struct CanonicalEventContext {
        DebtShiftHashing.ExecutionPlanHashInput plan;
        bytes32 planHash;
        bytes32 fundingMigrationId;
        bytes32 fundingEvidenceHash;
        MigrationEscrow.FundingRecord fundingRecord;
    }

    address internal borrower;
    bytes32 internal migrationId;
    bytes32 internal planHash;
    bytes32 internal feasibilityHash;
    DebtShiftHashing.ExecutionPlanHashInput internal plan;

    TestToken internal sourceDebtToken;
    TestToken internal sourceCollateralToken;
    MockSourceLending internal sourceLending;
    LiquidityVault internal vault;
    MigrationEscrow internal sourceEscrow;
    SourceAdapter internal sourceAdapter;

    TestToken internal destinationDebtToken;
    TestToken internal destinationCollateralToken;
    MockTargetLending internal targetLending;
    MigrationEscrow internal destinationEscrow;
    DestinationAdapter internal destinationAdapter;

    function setUp() public {
        borrower = vm.addr(BORROWER_KEY);
        sourceDebtToken = new TestToken("Source USD", "sUSDC", 6, address(this));
        sourceCollateralToken = new TestToken("Source Ether", "sWETH", 18, address(this));
        sourceLending = new MockSourceLending(
            IERC20(address(sourceCollateralToken)), IERC20(address(sourceDebtToken))
        );
        vault = new LiquidityVault(address(this));
        sourceEscrow = new MigrationEscrow(address(this));
        sourceAdapter = new SourceAdapter(address(this), vault, sourceLending, sourceEscrow);

        vault.setAsset(address(sourceDebtToken), true);
        vault.setAdapter(address(sourceAdapter), true);
        sourceEscrow.setDepositor(address(sourceAdapter), true);

        sourceDebtToken.mint(address(sourceLending), 100_000_000_000);
        sourceCollateralToken.mint(borrower, SOURCE_COLLATERAL);
        vm.prank(borrower);
        sourceCollateralToken.approve(address(sourceLending), SOURCE_COLLATERAL);
        vm.prank(borrower);
        sourceLending.openPosition(SOURCE_COLLATERAL, SOURCE_DEBT);

        sourceDebtToken.mint(address(this), 30_000_000_000);
        sourceDebtToken.approve(address(vault), 30_000_000_000);
        vault.deposit(IERC20(address(sourceDebtToken)), 30_000_000_000);
        sourceDebtToken.mint(address(this), 100_000_000_000);
        sourceDebtToken.approve(address(vault), type(uint256).max);

        destinationDebtToken = new TestToken("Destination USD", "dUSDC", 6, address(this));
        destinationCollateralToken = new TestToken("Destination Ether", "dWETH", 18, address(this));
        targetLending = new MockTargetLending(
            IERC20(address(destinationCollateralToken)),
            IERC20(address(destinationDebtToken)),
            18,
            6,
            2_000 ether,
            7_500
        );
        destinationEscrow = new MigrationEscrow(address(this));
        destinationAdapter = new DestinationAdapter(address(this), targetLending, destinationEscrow);
        destinationEscrow.setOperator(address(destinationAdapter), true);
        destinationAdapter.setPlanDomain(block.chainid, address(sourceAdapter), true);
        destinationDebtToken.mint(address(targetLending), 100_000_000_000);

        plan = _plan(borrower, 1);
        migrationId = plan.migrationId;
        planHash = _planHash(plan);
        feasibilityHash = _recordPassingFeasibility(plan, planHash, uint64(block.timestamp));
        vault.reserve(
            migrationId,
            IERC20(address(sourceDebtToken)),
            address(sourceAdapter),
            planHash,
            feasibilityHash,
            SOURCE_DEBT,
            SOLVER_FEE,
            plan.deadline
        );
    }

    function testHappyPathMovesExactBalancesAndRejectsReplay() public {
        bytes memory signature = _sign(planHash);
        sourceAdapter.closeSource(plan, signature);

        (uint256 sourceCollateralAfter, uint256 sourceDebtAfter) = sourceLending.positions(borrower);
        require(sourceCollateralAfter == 0 && sourceDebtAfter == 0, "source remains open");
        require(
            sourceEscrow.balances(migrationId, address(sourceCollateralToken)) == SOURCE_COLLATERAL,
            "source collateral not isolated"
        );
        require(
            vault.principalReceivable(address(sourceDebtToken)) == SOURCE_DEBT,
            "vault receivable mismatch"
        );

        (bool replayedSource,) = address(sourceAdapter)
            .call(abi.encodeCall(SourceAdapter.closeSource, (plan, signature)));
        require(!replayedSource, "source replay succeeded");

        sourceEscrow.release(
            migrationId, IERC20(address(sourceCollateralToken)), address(0x1234), SOURCE_COLLATERAL
        );
        destinationCollateralToken.mint(address(this), DESTINATION_COLLATERAL);
        destinationCollateralToken.approve(address(destinationEscrow), DESTINATION_COLLATERAL);
        destinationEscrow.assign(
            migrationId,
            IERC20(address(destinationCollateralToken)),
            address(this),
            DESTINATION_COLLATERAL
        );

        bytes32 destinationFeasibilityHash = destinationAdapter.recordFeasibility(
            migrationId, _destinationFeasibility(planHash, bytes32(0), 0, DESTINATION_DEBT, 1)
        );
        DestinationAdapter.OpenTerms memory openTerms =
            _openTerms(destinationFeasibilityHash, bytes32(0), DESTINATION_DEBT);
        destinationAdapter.openDestination(plan, signature, openTerms);
        (uint256 destinationCollateralAfter, uint256 destinationDebtAfter) =
            targetLending.positions(borrower);
        require(
            destinationCollateralAfter == DESTINATION_COLLATERAL, "destination collateral mismatch"
        );
        require(destinationDebtAfter == DESTINATION_DEBT, "destination debt mismatch");
        require(
            destinationDebtToken.balanceOf(borrower) == DESTINATION_DEBT, "payout receiver mismatch"
        );

        (bool replayedDestination,) = address(destinationAdapter)
            .call(abi.encodeCall(DestinationAdapter.openDestination, (plan, signature, openTerms)));
        require(!replayedDestination, "destination replay succeeded");

        sourceDebtToken.mint(address(this), SOURCE_DEBT + SOLVER_FEE);
        sourceDebtToken.approve(address(vault), SOURCE_DEBT + SOLVER_FEE);
        vault.settle(migrationId, address(this), SOLVER_FEE);
        require(vault.principalReceivable(address(sourceDebtToken)) == 0, "receivable remains");
        require(
            sourceDebtToken.balanceOf(address(vault)) == 30_000_000_000 + SOLVER_FEE,
            "vault settlement mismatch"
        );
        require(
            vault.lockedRecoveryReserves(address(sourceDebtToken)) == 0,
            "recovery reserve remained locked"
        );
    }

    function testRecoveryReserveIsIsolatedAndCanSettleFailedForwardExecution() public {
        require(
            vault.freeLiquidity(IERC20(address(sourceDebtToken))) == 20_000_000_000,
            "locked recovery reserve counted as lendable liquidity"
        );
        (,,,,,,,,, address reserveProvider, uint256 reserveUnits) = vault.reservations(migrationId);
        require(reserveProvider == address(this), "recovery reserve provider mismatch");
        require(reserveUnits == SOURCE_DEBT + SOLVER_FEE, "recovery reserve amount mismatch");

        sourceAdapter.closeSource(plan, _sign(planHash));
        vault.settleFromRecoveryReserve(migrationId);

        require(vault.principalReceivable(address(sourceDebtToken)) == 0, "receivable remains");
        require(
            vault.lockedRecoveryReserves(address(sourceDebtToken)) == 0,
            "recovery reserve remains locked"
        );
        require(
            sourceDebtToken.balanceOf(address(vault)) == 30_000_000_000 + SOLVER_FEE,
            "recovery reserve did not repay the vault"
        );
    }

    function testCanonicalContractEventsCarryExactIdentityAndAmounts() public {
        vm.recordLogs();
        CanonicalEventContext memory context = _executeCanonicalEventPath();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertSourceCanonicalLogs(logs, context);
        _assertDestinationCanonicalLogs(logs, context);
    }

    function testSupplementaryFundingIsSecuredBeforeReservationAndSettledExactly() public {
        DebtShiftHashing.ExecutionPlanHashInput memory fundedPlan = _plan(borrower, 2);
        bytes32 fundedPlanHash = _planHash(fundedPlan);
        bytes32 fundingEvidenceHash = _secureSupplementaryFee(fundedPlan);

        LiquidityVault.FeasibilityEvidence memory sourceEvidence =
            _feasibility(fundedPlanHash, uint64(block.timestamp), 1);
        sourceEvidence.externalFundingEvidenceHash = fundingEvidenceHash;
        sourceEvidence.confirmedExternalFundingUnits = SOLVER_FEE;
        sourceEvidence.maximumSafeBorrowingCapacityUnits = SOURCE_DEBT;
        sourceEvidence.requiredDestinationBorrowUnits = SOURCE_DEBT;
        bytes32 sourceEvidenceHash = vault.recordFeasibility(fundedPlan.migrationId, sourceEvidence);
        vault.reserve(
            fundedPlan.migrationId,
            IERC20(address(sourceDebtToken)),
            address(sourceAdapter),
            fundedPlanHash,
            sourceEvidenceHash,
            SOURCE_DEBT,
            SOLVER_FEE,
            fundedPlan.deadline
        );
        sourceAdapter.closeSource(fundedPlan, _sign(fundedPlanHash));

        destinationCollateralToken.mint(address(this), DESTINATION_COLLATERAL);
        destinationCollateralToken.approve(address(destinationEscrow), DESTINATION_COLLATERAL);
        destinationEscrow.assign(
            fundedPlan.migrationId,
            IERC20(address(destinationCollateralToken)),
            address(this),
            DESTINATION_COLLATERAL
        );
        bytes32 destinationEvidenceHash = destinationAdapter.recordFeasibility(
            fundedPlan.migrationId,
            _destinationFeasibility(fundedPlanHash, fundingEvidenceHash, SOLVER_FEE, SOURCE_DEBT, 1)
        );
        destinationAdapter.openDestination(
            fundedPlan,
            _sign(fundedPlanHash),
            _openTerms(destinationEvidenceHash, fundingEvidenceHash, SOURCE_DEBT)
        );

        (, uint256 destinationDebtAfter) = targetLending.positions(borrower);
        require(destinationDebtAfter == SOURCE_DEBT, "supplemented debt mismatch");
        require(
            destinationDebtToken.balanceOf(borrower) == SOURCE_DEBT + SOLVER_FEE,
            "combined payout mismatch"
        );
        MigrationEscrow.FundingRecord memory funding =
            destinationEscrow.fundingRecord(fundedPlan.migrationId);
        require(funding.status == MigrationEscrow.FundingStatus.SPENT, "funding was not consumed");
        require(
            destinationEscrow.balances(fundedPlan.migrationId, address(destinationDebtToken)) == 0,
            "settlement left an active balance"
        );
    }

    function testMismatchedFundingEvidenceCannotOpenDestinationOrConsumeEscrow() public {
        DebtShiftHashing.ExecutionPlanHashInput memory fundedPlan = _plan(borrower, 4);
        bytes32 fundedPlanHash = _planHash(fundedPlan);
        bytes32 fundingEvidenceHash = _secureSupplementaryFee(fundedPlan);

        destinationCollateralToken.mint(address(this), DESTINATION_COLLATERAL);
        destinationCollateralToken.approve(address(destinationEscrow), DESTINATION_COLLATERAL);
        destinationEscrow.assign(
            fundedPlan.migrationId,
            IERC20(address(destinationCollateralToken)),
            address(this),
            DESTINATION_COLLATERAL
        );
        bytes32 destinationEvidenceHash = destinationAdapter.recordFeasibility(
            fundedPlan.migrationId,
            _destinationFeasibility(fundedPlanHash, fundingEvidenceHash, SOLVER_FEE, SOURCE_DEBT, 1)
        );
        DestinationAdapter.OpenTerms memory openTerms =
            _openTerms(destinationEvidenceHash, keccak256("wrong-funding"), SOURCE_DEBT);
        (bool success,) = address(destinationAdapter)
            .call(
                abi.encodeCall(
                    DestinationAdapter.openDestination,
                    (fundedPlan, _sign(fundedPlanHash), openTerms)
                )
            );

        require(!success, "mismatched funding evidence opened destination");
        (, uint256 destinationDebtAfter) = targetLending.positions(borrower);
        require(destinationDebtAfter == 0, "failed open created destination debt");
        MigrationEscrow.FundingRecord memory funding =
            destinationEscrow.fundingRecord(fundedPlan.migrationId);
        require(
            funding.status == MigrationEscrow.FundingStatus.LOCKED, "failed open consumed funding"
        );
    }

    function testMutatedDestinationReceiverAndLowCollateralCannotMoveEscrow() public {
        destinationCollateralToken.mint(address(this), DESTINATION_COLLATERAL);
        destinationCollateralToken.approve(address(destinationEscrow), DESTINATION_COLLATERAL);
        destinationEscrow.assign(
            migrationId,
            IERC20(address(destinationCollateralToken)),
            address(this),
            DESTINATION_COLLATERAL
        );
        bytes32 destinationEvidenceHash = destinationAdapter.recordFeasibility(
            migrationId, _destinationFeasibility(planHash, bytes32(0), 0, DESTINATION_DEBT, 1)
        );
        bytes memory signature = _sign(planHash);
        DebtShiftHashing.ExecutionPlanHashInput memory mutatedPlan = plan;
        mutatedPlan.payoutReceiver = address(0xBAD);
        DestinationAdapter.OpenTerms memory openTerms =
            _openTerms(destinationEvidenceHash, bytes32(0), DESTINATION_DEBT);
        (bool mutatedReceiverAccepted,) = address(destinationAdapter)
            .call(
                abi.encodeCall(
                    DestinationAdapter.openDestination, (mutatedPlan, signature, openTerms)
                )
            );
        require(!mutatedReceiverAccepted, "mutated payout receiver was accepted");

        openTerms.collateralUnits = plan.minDestinationCollateral - 1;
        (bool lowCollateralAccepted,) = address(destinationAdapter)
            .call(abi.encodeCall(DestinationAdapter.openDestination, (plan, signature, openTerms)));
        require(!lowCollateralAccepted, "collateral below signed minimum was accepted");
        require(
            destinationEscrow.balances(migrationId, address(destinationCollateralToken))
                == DESTINATION_COLLATERAL,
            "failed destination authorization moved escrow collateral"
        );
        (, uint256 destinationDebtAfter) = targetLending.positions(borrower);
        require(destinationDebtAfter == 0, "failed authorization created target debt");
    }

    function testSupplementaryFundingRefundsOnlyAfterDeadlineToSignedReceiver() public {
        DebtShiftHashing.ExecutionPlanHashInput memory fundedPlan = _plan(borrower, 5);
        bytes32 fundingEvidenceHash = _secureSupplementaryFee(fundedPlan);

        (bool earlyRefund,) = address(destinationEscrow)
            .call(
                abi.encodeCall(
                    MigrationEscrow.refundSupplementaryFunding,
                    (fundedPlan.migrationId, fundingEvidenceHash)
                )
            );
        require(!earlyRefund, "funding refunded before deadline");

        vm.warp(uint256(fundedPlan.deadline) + 1);
        destinationEscrow.refundSupplementaryFunding(fundedPlan.migrationId, fundingEvidenceHash);
        require(
            destinationDebtToken.balanceOf(borrower) == SOLVER_FEE,
            "refund did not reach signed receiver"
        );
        MigrationEscrow.FundingRecord memory funding =
            destinationEscrow.fundingRecord(fundedPlan.migrationId);
        require(
            funding.status == MigrationEscrow.FundingStatus.REFUNDED,
            "funding refund status mismatch"
        );
    }

    function testTransportRefundCanBeReturnedWithoutCrossMigrationConsumption() public {
        sourceAdapter.closeSource(plan, _sign(planHash));
        sourceEscrow.release(
            migrationId, IERC20(address(sourceCollateralToken)), borrower, SOURCE_COLLATERAL
        );

        vm.prank(borrower);
        sourceCollateralToken.approve(address(sourceEscrow), SOURCE_COLLATERAL);
        sourceEscrow.assign(
            migrationId, IERC20(address(sourceCollateralToken)), borrower, SOURCE_COLLATERAL
        );
        sourceEscrow.release(
            migrationId, IERC20(address(sourceCollateralToken)), borrower, SOURCE_COLLATERAL
        );

        require(
            sourceCollateralToken.balanceOf(borrower) == SOURCE_COLLATERAL,
            "refund did not return collateral"
        );
        require(
            sourceEscrow.balances(migrationId, address(sourceCollateralToken)) == 0,
            "refund left escrow balance"
        );
    }

    function testMutatedExecutionPlanSignatureIsRejectedBeforeVaultDraw() public {
        bytes memory signature = _sign(planHash);
        plan.sourceRepaymentMax -= 1;
        (bool success,) = address(sourceAdapter)
            .call(abi.encodeCall(SourceAdapter.closeSource, (plan, signature)));
        require(!success, "mutated plan was accepted");
        require(
            _reservationStatus(migrationId) == LiquidityVault.ReservationStatus.ACTIVE,
            "failed authorization consumed reservation"
        );
    }

    function testReservationRejectsLatestProofWithUnresolvedShortfall() public {
        DebtShiftHashing.ExecutionPlanHashInput memory otherPlan = _plan(borrower, 2);
        bytes32 otherPlanHash = _planHash(otherPlan);
        LiquidityVault.FeasibilityEvidence memory evidence =
            _feasibility(otherPlanHash, uint64(block.timestamp), 1);
        evidence.maximumSafeBorrowingCapacityUnits = SOURCE_DEBT;
        evidence.fundingShortfallUnits = SOLVER_FEE;
        bytes32 otherFeasibilityHash = vault.recordFeasibility(otherPlan.migrationId, evidence);

        (bool success,) = address(vault)
            .call(
                abi.encodeCall(
                    LiquidityVault.reserve,
                    (
                        otherPlan.migrationId,
                        IERC20(address(sourceDebtToken)),
                        address(sourceAdapter),
                        otherPlanHash,
                        otherFeasibilityHash,
                        SOURCE_DEBT,
                        SOLVER_FEE,
                        otherPlan.deadline
                    )
                )
            );
        require(!success, "shortfall proof reserved liquidity");
    }

    function testNewerFailingProofSupersedesPassingReservation() public {
        vm.warp(block.timestamp + 1);
        LiquidityVault.FeasibilityEvidence memory failed =
            _feasibility(planHash, uint64(block.timestamp), 2);
        failed.maximumSafeBorrowingCapacityUnits = SOURCE_DEBT;
        failed.fundingShortfallUnits = SOLVER_FEE;
        vault.recordFeasibility(migrationId, failed);

        (bool success,) = address(sourceAdapter)
            .call(abi.encodeCall(SourceAdapter.closeSource, (plan, _sign(planHash))));
        require(!success, "stale passing proof remained executable");
        require(
            _reservationStatus(migrationId) == LiquidityVault.ReservationStatus.ACTIVE,
            "failed revalidation consumed reservation"
        );
    }

    function testAtomicReleaseForFeasibilityFailureBeforeSourceClose() public {
        vm.warp(block.timestamp + 1);
        LiquidityVault.FeasibilityEvidence memory failed =
            _feasibility(planHash, uint64(block.timestamp), 2);
        failed.maximumSafeBorrowingCapacityUnits = SOURCE_DEBT;
        failed.fundingShortfallUnits = SOLVER_FEE;

        bytes32 failedHash = vault.recordFailedFeasibilityAndRelease(migrationId, failed);

        require(failedHash == vault.latestFeasibilityHash(migrationId), "failure not recorded");
        require(
            _reservationStatus(migrationId) == LiquidityVault.ReservationStatus.RELEASED,
            "reservation not released"
        );
        require(vault.reservedUndrawn(address(sourceDebtToken)) == 0, "liquidity still reserved");
        require(
            vault.principalReceivable(address(sourceDebtToken)) == 0,
            "released reservation created receivable"
        );
        require(
            vault.lockedRecoveryReserves(address(sourceDebtToken)) == 0,
            "released reservation retained the recovery reserve"
        );
        (uint256 collateralUnits, uint256 debtUnits) = sourceLending.positions(borrower);
        require(collateralUnits == SOURCE_COLLATERAL, "source collateral moved");
        require(debtUnits == SOURCE_DEBT, "source debt moved");

        (bool success,) = address(sourceAdapter)
            .call(abi.encodeCall(SourceAdapter.closeSource, (plan, _sign(planHash))));
        require(!success, "released failing reservation closed source");
    }

    function testExpiredPlanCannotDrawLiquidity() public {
        vm.warp(uint256(plan.deadline) + 1);
        (bool success,) = address(sourceAdapter)
            .call(abi.encodeCall(SourceAdapter.closeSource, (plan, _sign(planHash))));
        require(!success, "expired plan closed source");
        require(vault.principalReceivable(address(sourceDebtToken)) == 0, "expired draw occurred");
    }

    function testUnusedAuthorizedPrincipalReturnsWithoutBreakingSettlement() public {
        uint256 authorizedPrincipal = SOURCE_DEBT + 100_000_000;
        DebtShiftHashing.ExecutionPlanHashInput memory bufferedPlan = _plan(borrower, 6);
        bufferedPlan.principalMax = authorizedPrincipal;
        bytes32 bufferedPlanHash = _planHash(bufferedPlan);
        LiquidityVault.FeasibilityEvidence memory evidence =
            _feasibility(bufferedPlanHash, uint64(block.timestamp), 1);
        evidence.solverPrincipalUnits = authorizedPrincipal;
        evidence.totalRequiredUnits = authorizedPrincipal + SOLVER_FEE;
        evidence.maximumSafeBorrowingCapacityUnits = authorizedPrincipal + SOLVER_FEE;
        evidence.requiredDestinationBorrowUnits = authorizedPrincipal + SOLVER_FEE;
        bytes32 evidenceHash = vault.recordFeasibility(bufferedPlan.migrationId, evidence);
        vault.reserve(
            bufferedPlan.migrationId,
            IERC20(address(sourceDebtToken)),
            address(sourceAdapter),
            bufferedPlanHash,
            evidenceHash,
            authorizedPrincipal,
            SOLVER_FEE,
            bufferedPlan.deadline
        );

        sourceAdapter.closeSource(bufferedPlan, _sign(bufferedPlanHash));
        (,,,,,,,, uint256 receivableUnits,,) = vault.reservations(bufferedPlan.migrationId);
        require(receivableUnits == SOURCE_DEBT, "unused principal remained receivable");
        require(
            vault.principalReceivable(address(sourceDebtToken)) == SOURCE_DEBT,
            "global receivable did not exclude returned funds"
        );

        sourceDebtToken.mint(address(this), SOURCE_DEBT + SOLVER_FEE);
        sourceDebtToken.approve(address(vault), SOURCE_DEBT + SOLVER_FEE);
        (bool staleSuccess,) = address(vault)
            .call(
                abi.encodeCall(
                    LiquidityVault.settle, (bufferedPlan.migrationId, address(this), SOLVER_FEE)
                )
            );
        require(!staleSuccess, "buffered feasibility ignored the returned principal");

        evidence.sequence = 2;
        evidence.solverPrincipalUnits = SOURCE_DEBT;
        evidence.totalRequiredUnits = SOURCE_DEBT + SOLVER_FEE;
        evidence.requiredDestinationBorrowUnits = SOURCE_DEBT + SOLVER_FEE;
        vault.recordFeasibility(bufferedPlan.migrationId, evidence);
        vault.settle(bufferedPlan.migrationId, address(this), SOLVER_FEE);
        require(
            vault.principalReceivable(address(sourceDebtToken)) == 0,
            "buffered reservation did not settle"
        );
    }

    function testSettlementRequiresTheExactAttestedFee() public {
        sourceAdapter.closeSource(plan, _sign(planHash));
        sourceDebtToken.mint(address(this), SOURCE_DEBT + SOLVER_FEE);
        sourceDebtToken.approve(address(vault), SOURCE_DEBT + SOLVER_FEE);

        (bool success,) = address(vault)
            .call(
                abi.encodeCall(LiquidityVault.settle, (migrationId, address(this), SOLVER_FEE - 1))
            );
        require(!success, "settlement accepted a fee below the attested amount");
        require(
            _reservationStatus(migrationId) == LiquidityVault.ReservationStatus.DRAWN,
            "failed settlement changed reservation status"
        );
    }

    function testEip1271BorrowerAuthorizationIsAccepted() public {
        MockEip1271Wallet wallet = new MockEip1271Wallet(address(this));
        sourceCollateralToken.mint(address(wallet), SOURCE_COLLATERAL);
        wallet.execute(
            address(sourceCollateralToken),
            abi.encodeCall(TestToken.approve, (address(sourceLending), SOURCE_COLLATERAL))
        );
        wallet.execute(
            address(sourceLending),
            abi.encodeCall(MockSourceLending.openPosition, (SOURCE_COLLATERAL, SOURCE_DEBT))
        );

        DebtShiftHashing.ExecutionPlanHashInput memory walletPlan = _plan(address(wallet), 3);
        bytes32 walletPlanHash = _planHash(walletPlan);
        bytes32 walletFeasibilityHash =
            _recordPassingFeasibility(walletPlan, walletPlanHash, uint64(block.timestamp));
        vault.reserve(
            walletPlan.migrationId,
            IERC20(address(sourceDebtToken)),
            address(sourceAdapter),
            walletPlanHash,
            walletFeasibilityHash,
            SOURCE_DEBT,
            SOLVER_FEE,
            walletPlan.deadline
        );
        wallet.approveDigest(walletPlanHash, true);

        sourceAdapter.closeSource(walletPlan, hex"01");
        (uint256 collateralAfter, uint256 debtAfter) = sourceLending.positions(address(wallet));
        require(collateralAfter == 0 && debtAfter == 0, "EIP-1271 source remains open");

        destinationCollateralToken.mint(address(this), DESTINATION_COLLATERAL);
        destinationCollateralToken.approve(address(destinationEscrow), DESTINATION_COLLATERAL);
        destinationEscrow.assign(
            walletPlan.migrationId,
            IERC20(address(destinationCollateralToken)),
            address(this),
            DESTINATION_COLLATERAL
        );
        bytes32 destinationEvidenceHash = destinationAdapter.recordFeasibility(
            walletPlan.migrationId,
            _destinationFeasibility(walletPlanHash, bytes32(0), 0, DESTINATION_DEBT, 1)
        );
        destinationAdapter.openDestination(
            walletPlan, hex"01", _openTerms(destinationEvidenceHash, bytes32(0), DESTINATION_DEBT)
        );
        (uint256 targetCollateral, uint256 targetDebt) = targetLending.positions(address(wallet));
        require(
            targetCollateral == DESTINATION_COLLATERAL && targetDebt == DESTINATION_DEBT,
            "EIP-1271 destination did not open"
        );
    }

    function _plan(address planBorrower, uint256 nonce)
        private
        view
        returns (DebtShiftHashing.ExecutionPlanHashInput memory result)
    {
        bytes32 intentHash = keccak256(abi.encode("intent", planBorrower));
        bytes32 quoteHash = keccak256(abi.encode("quote", nonce));
        result = DebtShiftHashing.ExecutionPlanHashInput({
            intentHash: intentHash,
            migrationId: DebtShiftHashing.computeMigrationId(intentHash, quoteHash, nonce),
            borrower: planBorrower,
            sourcePositionId: keccak256(abi.encode("source-position", planBorrower)),
            routeHash: keccak256(abi.encode("route", nonce)),
            transportQuoteHash: quoteHash,
            sourceRepaymentMax: SOURCE_DEBT,
            sourceCollateralMin: SOURCE_COLLATERAL,
            targetDebtMax: 10_100_000_000,
            minDestinationCollateral: 9.8 ether,
            principalMax: SOURCE_DEBT,
            feeMax: SOLVER_FEE,
            destinationReceiver: address(destinationEscrow) == address(0)
                ? address(0xD357)
                : address(destinationEscrow),
            transportRefundReceiver: address(sourceEscrow),
            refundReceiver: planBorrower,
            payoutReceiver: planBorrower,
            deadline: uint64(block.timestamp + 30 minutes),
            nonce: nonce
        });
    }

    function _planHash(DebtShiftHashing.ExecutionPlanHashInput memory input)
        private
        view
        returns (bytes32)
    {
        return DebtShiftHashing.hashExecutionPlan(input, block.chainid, address(sourceAdapter));
    }

    function _sign(bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BORROWER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _recordPassingFeasibility(
        DebtShiftHashing.ExecutionPlanHashInput memory input,
        bytes32 inputPlanHash,
        uint64 evaluatedAt
    ) private returns (bytes32) {
        return vault.recordFeasibility(
            input.migrationId, _feasibility(inputPlanHash, evaluatedAt, 1)
        );
    }

    function _feasibility(bytes32 inputPlanHash, uint64 evaluatedAt, uint64 sequence)
        private
        view
        returns (LiquidityVault.FeasibilityEvidence memory)
    {
        return LiquidityVault.FeasibilityEvidence({
            planHash: inputPlanHash,
            analysisHash: keccak256(abi.encode("analysis", inputPlanHash, evaluatedAt)),
            externalFundingEvidenceHash: bytes32(0),
            liquidityAsset: address(sourceDebtToken),
            solverPrincipalUnits: SOURCE_DEBT,
            solverFeeUnits: SOLVER_FEE,
            capitalizedCostUnits: 0,
            totalRequiredUnits: SOURCE_DEBT + SOLVER_FEE,
            confirmedExternalFundingUnits: 0,
            maximumSafeBorrowingCapacityUnits: SOURCE_DEBT + SOLVER_FEE,
            requiredDestinationBorrowUnits: SOURCE_DEBT + SOLVER_FEE,
            fundingShortfallUnits: 0,
            sequence: sequence,
            evaluatedAt: evaluatedAt,
            validUntil: uint64(block.timestamp + 30 minutes)
        });
    }

    function _destinationFeasibility(
        bytes32 inputPlanHash,
        bytes32 fundingEvidenceHash,
        uint256 confirmedFundingUnits,
        uint256 requiredBorrowUnits,
        uint64 sequence
    ) private view returns (DestinationAdapter.FeasibilityEvidence memory) {
        return DestinationAdapter.FeasibilityEvidence({
                planHash: inputPlanHash,
                analysisHash: keccak256(
                    abi.encode("destination-analysis", inputPlanHash, requiredBorrowUnits)
                ),
                externalFundingEvidenceHash: fundingEvidenceHash,
                settlementAsset: address(destinationDebtToken),
                solverPrincipalUnits: SOURCE_DEBT,
                solverFeeUnits: SOLVER_FEE,
                capitalizedCostUnits: 0,
                totalRequiredUnits: SOURCE_DEBT + SOLVER_FEE,
                confirmedExternalFundingUnits: confirmedFundingUnits,
                maximumSafeBorrowingCapacityUnits: requiredBorrowUnits,
                requiredDestinationBorrowUnits: requiredBorrowUnits,
                fundingShortfallUnits: 0,
                sequence: sequence,
                evaluatedAt: uint64(block.timestamp),
                validUntil: plan.deadline
            });
    }

    function _openTerms(
        bytes32 destinationFeasibilityHash,
        bytes32 fundingEvidenceHash,
        uint256 borrowUnits
    ) private view returns (DestinationAdapter.OpenTerms memory) {
        return DestinationAdapter.OpenTerms({
            sourceChainId: block.chainid,
            sourceAdapter: address(sourceAdapter),
            collateralUnits: DESTINATION_COLLATERAL,
            borrowUnits: borrowUnits,
            feasibilityHash: destinationFeasibilityHash,
            fundingEvidenceHash: fundingEvidenceHash,
            solverPrincipalUnits: SOURCE_DEBT,
            solverFeeUnits: SOLVER_FEE,
            capitalizedCostUnits: 0,
            capitalizedCostReceiver: address(0),
            lendingAuthorization: bytes("")
        });
    }

    function _secureSupplementaryFee(DebtShiftHashing.ExecutionPlanHashInput memory fundedPlan)
        private
        returns (bytes32)
    {
        MigrationEscrow.SettlementTerms memory settlementTerms = MigrationEscrow.SettlementTerms({
            migrationId: fundedPlan.migrationId,
            token: IERC20(address(destinationDebtToken)),
            fundingEvidenceHash: bytes32(0),
            solverPayoutReceiver: fundedPlan.payoutReceiver,
            capitalizedCostReceiver: address(0),
            residualReceiver: fundedPlan.refundReceiver,
            solverPrincipalUnits: SOURCE_DEBT,
            solverFeeUnits: SOLVER_FEE,
            capitalizedCostUnits: 0
        });
        bytes32 authorizedUseHash = destinationEscrow.computeAuthorizedUseHash(settlementTerms);
        destinationDebtToken.mint(address(this), SOLVER_FEE);
        destinationDebtToken.approve(address(destinationEscrow), SOLVER_FEE);
        return destinationEscrow.secureSupplementaryFunding(
            MigrationEscrow.FundingCommitment({
                migrationId: fundedPlan.migrationId,
                chainId: block.chainid,
                token: IERC20(address(destinationDebtToken)),
                depositor: address(this),
                refundReceiver: fundedPlan.refundReceiver,
                amountUnits: SOLVER_FEE,
                authorizedUseHash: authorizedUseHash,
                deadline: fundedPlan.deadline
            })
        );
    }

    function _executeCanonicalEventPath() private returns (CanonicalEventContext memory context) {
        context.plan = _plan(borrower, 2);
        context.planHash = _planHash(context.plan);
        DebtShiftHashing.ExecutionPlanHashInput memory fundingPlan = _plan(borrower, 3);
        context.fundingMigrationId = fundingPlan.migrationId;
        context.fundingEvidenceHash = _secureSupplementaryFee(fundingPlan);
        context.fundingRecord = destinationEscrow.fundingRecord(context.fundingMigrationId);

        bytes32 eventFeasibilityHash =
            _recordPassingFeasibility(context.plan, context.planHash, uint64(block.timestamp));
        vault.reserve(
            context.plan.migrationId,
            IERC20(address(sourceDebtToken)),
            address(sourceAdapter),
            context.planHash,
            eventFeasibilityHash,
            SOURCE_DEBT,
            SOLVER_FEE,
            context.plan.deadline
        );

        bytes memory signature = _sign(context.planHash);
        sourceAdapter.closeSource(context.plan, signature);
        destinationCollateralToken.mint(address(this), DESTINATION_COLLATERAL);
        destinationCollateralToken.approve(address(destinationEscrow), DESTINATION_COLLATERAL);
        destinationEscrow.assign(
            context.plan.migrationId,
            IERC20(address(destinationCollateralToken)),
            address(this),
            DESTINATION_COLLATERAL
        );
        bytes32 destinationFeasibilityHash = destinationAdapter.recordFeasibility(
            context.plan.migrationId,
            _destinationFeasibility(context.planHash, bytes32(0), 0, DESTINATION_DEBT, 1)
        );
        destinationAdapter.openDestination(
            context.plan,
            signature,
            _openTerms(destinationFeasibilityHash, bytes32(0), DESTINATION_DEBT)
        );
        sourceDebtToken.mint(address(this), SOURCE_DEBT + SOLVER_FEE);
        sourceDebtToken.approve(address(vault), SOURCE_DEBT + SOLVER_FEE);
        vault.settle(context.plan.migrationId, address(this), SOLVER_FEE);
    }

    function _assertSourceCanonicalLogs(Vm.Log[] memory logs, CanonicalEventContext memory context)
        private
        view
    {
        _assertLog(
            logs,
            address(vault),
            keccak256("LiquidityReserved(bytes32,address,address,uint256,uint256,uint64)"),
            context.plan.migrationId,
            _addressTopic(address(sourceDebtToken)),
            _addressTopic(address(sourceAdapter)),
            3,
            abi.encode(SOURCE_DEBT, SOLVER_FEE, context.plan.deadline)
        );
        _assertLog(
            logs,
            address(sourceAdapter),
            keccak256("MigrationAuthorized(bytes32,bytes32,address,uint256)"),
            context.plan.migrationId,
            context.planHash,
            _addressTopic(borrower),
            3,
            abi.encode(context.plan.nonce)
        );
        _assertLog(
            logs,
            address(sourceAdapter),
            keccak256("SourceClosed(bytes32,address,uint256,uint256)"),
            context.plan.migrationId,
            _addressTopic(borrower),
            bytes32(0),
            2,
            abi.encode(SOURCE_DEBT, SOURCE_COLLATERAL)
        );
        _assertLog(
            logs,
            address(vault),
            keccak256("LiquiditySettled(bytes32,uint256,uint256)"),
            context.plan.migrationId,
            bytes32(0),
            bytes32(0),
            1,
            abi.encode(SOURCE_DEBT, SOLVER_FEE)
        );
    }

    function _assertDestinationCanonicalLogs(
        Vm.Log[] memory logs,
        CanonicalEventContext memory context
    ) private view {
        _assertLog(
            logs,
            address(destinationEscrow),
            keccak256(
                "SupplementaryFundingSecured(bytes32,address,bytes32,address,address,uint256,bytes32,uint64)"
            ),
            context.fundingMigrationId,
            _addressTopic(address(destinationDebtToken)),
            context.fundingEvidenceHash,
            3,
            abi.encode(
                context.fundingRecord.depositor,
                context.fundingRecord.refundReceiver,
                context.fundingRecord.amountUnits,
                context.fundingRecord.authorizedUseHash,
                context.fundingRecord.deadline
            )
        );
        _assertLog(
            logs,
            address(destinationEscrow),
            keccak256("CollateralAssigned(bytes32,address,address,uint256)"),
            context.plan.migrationId,
            _addressTopic(address(destinationCollateralToken)),
            _addressTopic(address(this)),
            3,
            abi.encode(DESTINATION_COLLATERAL)
        );
        _assertLog(
            logs,
            address(destinationAdapter),
            keccak256("DestinationOpened(bytes32,address,bytes32,uint256,uint256)"),
            context.plan.migrationId,
            _addressTopic(borrower),
            context.planHash,
            3,
            abi.encode(DESTINATION_COLLATERAL, DESTINATION_DEBT)
        );
    }

    function _assertLog(
        Vm.Log[] memory logs,
        address emitter,
        bytes32 signatureTopic,
        bytes32 indexedTopic1,
        bytes32 indexedTopic2,
        bytes32 indexedTopic3,
        uint256 indexedCount,
        bytes memory expectedData
    ) private pure {
        for (uint256 index = 0; index < logs.length; index++) {
            Vm.Log memory candidate = logs[index];
            if (
                candidate.emitter != emitter || candidate.topics.length != indexedCount + 1
                    || candidate.topics[0] != signatureTopic || candidate.topics[1] != indexedTopic1
                    || (indexedCount > 1 && candidate.topics[2] != indexedTopic2)
                    || (indexedCount > 2 && candidate.topics[3] != indexedTopic3)
            ) continue;
            require(keccak256(candidate.data) == keccak256(expectedData), "event data mismatch");
            return;
        }
        revert("canonical event missing");
    }

    function _addressTopic(address value) private pure returns (bytes32) {
        return bytes32(uint256(uint160(value)));
    }

    function _reservationStatus(bytes32 id)
        private
        view
        returns (LiquidityVault.ReservationStatus status)
    {
        (,,,,,, status,,,,) = vault.reservations(id);
    }
}
