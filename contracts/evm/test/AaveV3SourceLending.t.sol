// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AaveV3SourceLending, IAaveV3Pool } from "../src/AaveV3SourceLending.sol";
import { DebtShiftHashing } from "../src/DebtShiftHashing.sol";
import { MigrationEscrow } from "../src/MigrationEscrow.sol";
import { SourceAdapter } from "../src/SourceAdapter.sol";
import { LiquidityVault } from "../src/LiquidityVault.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";
import { ISourceLending } from "../src/interfaces/ISourceLending.sol";
import { MockAaveV3Pool } from "../src/mocks/MockAaveV3Pool.sol";
import { TestToken } from "../src/mocks/TestToken.sol";

interface AaveVm {
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
}

contract AaveV3SourceLendingTest {
    AaveVm private constant vm = AaveVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BORROWER_KEY = 0xA11CE;
    uint256 private constant SOURCE_DEBT = 10_000_000_000;
    uint256 private constant SOURCE_COLLATERAL = 10 ether;
    uint256 private constant SOLVER_FEE = 50_000_000;

    address private borrower;
    TestToken private debtToken;
    TestToken private collateralToken;
    TestToken private aToken;
    MockAaveV3Pool private pool;
    LiquidityVault private vault;
    MigrationEscrow private escrow;
    AaveV3SourceLending private aaveLending;
    SourceAdapter private sourceAdapter;
    DebtShiftHashing.ExecutionPlanHashInput private plan;
    bytes32 private planHash;

    function setUp() public {
        borrower = vm.addr(BORROWER_KEY);
        debtToken = new TestToken("USD Coin", "USDC", 6, address(this));
        collateralToken = new TestToken("Wrapped Ether", "WETH", 18, address(this));
        aToken = new TestToken("Aave Wrapped Ether", "aBasWETH", 18, address(this));
        pool = new MockAaveV3Pool(
            IERC20(address(collateralToken)), IERC20(address(debtToken)), IERC20(address(aToken))
        );
        aToken.setMinter(address(pool), true);

        collateralToken.mint(borrower, SOURCE_COLLATERAL);
        debtToken.mint(address(pool), 100_000_000_000);
        vm.prank(borrower);
        collateralToken.approve(address(pool), SOURCE_COLLATERAL);
        pool.openPosition(borrower, SOURCE_COLLATERAL, SOURCE_DEBT);

        vault = new LiquidityVault(address(this));
        escrow = new MigrationEscrow(address(this));
        aaveLending = new AaveV3SourceLending(
            address(this),
            IAaveV3Pool(address(pool)),
            IERC20(address(aToken)),
            IERC20(address(pool)),
            IERC20(address(collateralToken)),
            IERC20(address(debtToken))
        );
        sourceAdapter =
            new SourceAdapter(address(this), vault, ISourceLending(address(aaveLending)), escrow);
        aaveLending.setSourceAdapter(address(sourceAdapter));

        vault.setAsset(address(debtToken), true);
        vault.setAdapter(address(sourceAdapter), true);
        escrow.setDepositor(address(sourceAdapter), true);
        debtToken.mint(address(this), 20_000_000_000);
        debtToken.approve(address(vault), 20_000_000_000);
        vault.deposit(IERC20(address(debtToken)), 20_000_000_000);
        debtToken.mint(address(this), 100_000_000_000);
        debtToken.approve(address(vault), type(uint256).max);

        vm.prank(borrower);
        aToken.approve(address(aaveLending), SOURCE_COLLATERAL);

        plan = _plan(1);
        planHash = DebtShiftHashing.hashExecutionPlan(plan, block.chainid, address(sourceAdapter));
        bytes32 feasibilityHash = vault.recordFeasibility(plan.migrationId, _feasibility(planHash));
        vault.reserve(
            plan.migrationId,
            IERC20(address(debtToken)),
            address(sourceAdapter),
            planHash,
            feasibilityHash,
            SOURCE_DEBT,
            SOLVER_FEE,
            plan.deadline
        );
    }

    function testAtomicAaveCloseClaimsOnlySignedCollateral() public {
        sourceAdapter.closeSource(plan, _sign(planHash));

        require(pool.balanceOf(borrower) == 0, "Aave debt remains");
        require(aToken.balanceOf(borrower) == 0, "borrower aToken remains");
        require(aToken.balanceOf(address(aaveLending)) == 0, "module retained aToken");
        require(debtToken.balanceOf(address(aaveLending)) == 0, "module retained debt asset");
        require(
            escrow.balances(plan.migrationId, address(collateralToken)) == SOURCE_COLLATERAL,
            "collateral was not isolated"
        );
        require(
            escrow.categorizedBalances(
                plan.migrationId,
                address(collateralToken),
                MigrationEscrow.BalanceKind.TRANSPORTED_COLLATERAL
            ) == SOURCE_COLLATERAL,
            "collateral category mismatch"
        );
        require(
            vault.principalReceivable(address(debtToken)) == SOURCE_DEBT,
            "vault receivable mismatch"
        );
    }

    function testMissingATokenAllowanceRevertsRepaymentAndVaultDraw() public {
        vm.prank(borrower);
        aToken.approve(address(aaveLending), 0);

        bool reverted;
        try sourceAdapter.closeSource(plan, _sign(planHash)) { }
        catch {
            reverted = true;
        }
        require(reverted, "close unexpectedly succeeded");
        require(pool.balanceOf(borrower) == SOURCE_DEBT, "debt repayment was not reverted");
        require(aToken.balanceOf(borrower) == SOURCE_COLLATERAL, "aToken claim was not reverted");
        require(
            _reservationStatus(plan.migrationId) == LiquidityVault.ReservationStatus.ACTIVE,
            "reservation draw was not reverted"
        );
        require(vault.principalReceivable(address(debtToken)) == 0, "vault receivable was created");
        require(!sourceAdapter.consumedMigrations(plan.migrationId), "migration was consumed");
    }

    function testDebtAboveSignedCapRevertsBeforeVaultExposure() public {
        pool.accrueDebt(borrower, 1);

        bool reverted;
        try sourceAdapter.closeSource(plan, _sign(planHash)) { }
        catch {
            reverted = true;
        }
        require(reverted, "over-cap close unexpectedly succeeded");
        require(pool.balanceOf(borrower) == SOURCE_DEBT + 1, "debt changed on cap failure");
        require(
            aToken.balanceOf(borrower) == SOURCE_COLLATERAL, "collateral changed on cap failure"
        );
        require(
            _reservationStatus(plan.migrationId) == LiquidityVault.ReservationStatus.ACTIVE,
            "reservation changed on cap failure"
        );
        require(vault.principalReceivable(address(debtToken)) == 0, "vault gained exposure");
    }

    function testSourceAdapterCanOnlyBeConfiguredOnce() public {
        bool reverted;
        try aaveLending.setSourceAdapter(address(sourceAdapter)) { }
        catch {
            reverted = true;
        }
        require(reverted, "source adapter was reconfigured");
    }

    function _plan(uint256 nonce)
        private
        view
        returns (DebtShiftHashing.ExecutionPlanHashInput memory result)
    {
        bytes32 intentHash = keccak256(abi.encode("aave-intent", borrower));
        bytes32 quoteHash = keccak256(abi.encode("aave-quote", nonce));
        result = DebtShiftHashing.ExecutionPlanHashInput({
            intentHash: intentHash,
            migrationId: DebtShiftHashing.computeMigrationId(intentHash, quoteHash, nonce),
            borrower: borrower,
            sourcePositionId: keccak256(abi.encode("aave-position", borrower)),
            routeHash: keccak256(abi.encode("aave-route", nonce)),
            transportQuoteHash: quoteHash,
            sourceRepaymentMax: SOURCE_DEBT,
            sourceCollateralMin: SOURCE_COLLATERAL,
            targetDebtMax: SOURCE_DEBT + SOLVER_FEE,
            minDestinationCollateral: 9.8 ether,
            principalMax: SOURCE_DEBT,
            feeMax: SOLVER_FEE,
            destinationReceiver: address(0xD357),
            transportRefundReceiver: address(escrow),
            refundReceiver: borrower,
            payoutReceiver: borrower,
            deadline: uint64(block.timestamp + 30 minutes),
            nonce: nonce
        });
    }

    function _feasibility(bytes32 inputPlanHash)
        private
        view
        returns (LiquidityVault.FeasibilityEvidence memory)
    {
        return LiquidityVault.FeasibilityEvidence({
            planHash: inputPlanHash,
            analysisHash: keccak256(abi.encode("aave-analysis", inputPlanHash)),
            externalFundingEvidenceHash: bytes32(0),
            liquidityAsset: address(debtToken),
            solverPrincipalUnits: SOURCE_DEBT,
            solverFeeUnits: SOLVER_FEE,
            capitalizedCostUnits: 0,
            totalRequiredUnits: SOURCE_DEBT + SOLVER_FEE,
            confirmedExternalFundingUnits: 0,
            maximumSafeBorrowingCapacityUnits: SOURCE_DEBT + SOLVER_FEE,
            requiredDestinationBorrowUnits: SOURCE_DEBT + SOLVER_FEE,
            fundingShortfallUnits: 0,
            sequence: 1,
            evaluatedAt: uint64(block.timestamp),
            validUntil: plan.deadline
        });
    }

    function _sign(bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BORROWER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _reservationStatus(bytes32 migrationId)
        private
        view
        returns (LiquidityVault.ReservationStatus status)
    {
        (,,,,,, status,,,,) = vault.reservations(migrationId);
    }
}
