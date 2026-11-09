// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { DestinationAdapter } from "../src/DestinationAdapter.sol";
import { MigrationEscrow } from "../src/MigrationEscrow.sol";
import { SourceAdapter } from "../src/SourceAdapter.sol";
import { TestLiquidityVault } from "../src/TestLiquidityVault.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";
import { MockSourceLending } from "../src/mocks/MockSourceLending.sol";
import { MockTargetLending } from "../src/mocks/MockTargetLending.sol";
import { TestToken } from "../src/mocks/TestToken.sol";

contract SimulatedRefinanceTest {
    bytes32 internal constant MIGRATION_ID =
        0x67c5975085073b2512ada4bfe6296d62b485f963078bb88c104d68958287d692;
    uint256 internal constant SOURCE_DEBT = 10_000_000_000;
    uint256 internal constant SOURCE_COLLATERAL = 10 ether;
    uint256 internal constant DESTINATION_COLLATERAL = 9.9 ether;
    uint256 internal constant DESTINATION_DEBT = 10_050_000_000;

    TestToken internal sourceDebtToken;
    TestToken internal sourceCollateralToken;
    MockSourceLending internal sourceLending;
    TestLiquidityVault internal vault;
    MigrationEscrow internal sourceEscrow;
    SourceAdapter internal sourceAdapter;

    TestToken internal destinationDebtToken;
    TestToken internal destinationCollateralToken;
    MockTargetLending internal targetLending;
    MigrationEscrow internal destinationEscrow;
    DestinationAdapter internal destinationAdapter;

    function setUp() public {
        sourceDebtToken = new TestToken("Source USD", "sUSDC", 6, address(this));
        sourceCollateralToken = new TestToken("Source Ether", "sWETH", 18, address(this));
        sourceLending = new MockSourceLending(
            IERC20(address(sourceCollateralToken)), IERC20(address(sourceDebtToken))
        );
        vault = new TestLiquidityVault(address(this));
        sourceEscrow = new MigrationEscrow(address(this));
        sourceAdapter = new SourceAdapter(address(this), vault, sourceLending, sourceEscrow);

        vault.setAsset(address(sourceDebtToken), true);
        vault.setAdapter(address(sourceAdapter), true);
        sourceEscrow.setDepositor(address(sourceAdapter), true);

        sourceDebtToken.mint(address(sourceLending), 100_000_000_000);
        sourceCollateralToken.mint(address(this), SOURCE_COLLATERAL);
        sourceCollateralToken.approve(address(sourceLending), SOURCE_COLLATERAL);
        sourceLending.openPosition(SOURCE_COLLATERAL, SOURCE_DEBT);

        sourceDebtToken.mint(address(this), 20_000_000_000);
        sourceDebtToken.approve(address(vault), 20_000_000_000);
        vault.deposit(IERC20(address(sourceDebtToken)), 20_000_000_000);
        vault.reserve(
            MIGRATION_ID,
            IERC20(address(sourceDebtToken)),
            address(sourceAdapter),
            SOURCE_DEBT,
            100_000_000,
            uint64(block.timestamp + 1 hours)
        );

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
        destinationDebtToken.mint(address(targetLending), 100_000_000_000);
    }

    function testHappyPathMovesExactBalancesAndRejectsReplay() public {
        SourceAdapter.CloseTerms memory closeTerms = _closeTerms();
        sourceAdapter.closeSource(closeTerms);

        (uint256 sourceCollateralAfter, uint256 sourceDebtAfter) =
            sourceLending.positions(address(this));
        require(sourceCollateralAfter == 0 && sourceDebtAfter == 0, "source remains open");
        require(
            sourceEscrow.balances(MIGRATION_ID, address(sourceCollateralToken))
                == SOURCE_COLLATERAL,
            "source collateral not isolated"
        );
        require(
            vault.principalReceivable(address(sourceDebtToken)) == SOURCE_DEBT,
            "vault receivable mismatch"
        );

        (bool replayedSource,) =
            address(sourceAdapter).call(abi.encodeCall(SourceAdapter.closeSource, (closeTerms)));
        require(!replayedSource, "source replay succeeded");

        sourceEscrow.release(
            MIGRATION_ID, IERC20(address(sourceCollateralToken)), address(0x1234), SOURCE_COLLATERAL
        );
        destinationCollateralToken.mint(address(this), DESTINATION_COLLATERAL);
        destinationCollateralToken.approve(address(destinationEscrow), DESTINATION_COLLATERAL);
        destinationEscrow.assign(
            MIGRATION_ID,
            IERC20(address(destinationCollateralToken)),
            address(this),
            DESTINATION_COLLATERAL
        );

        DestinationAdapter.OpenTerms memory openTerms = _openTerms();
        destinationAdapter.openDestination(openTerms);
        (uint256 destinationCollateralAfter, uint256 destinationDebtAfter) =
            targetLending.positions(address(this));
        require(
            destinationCollateralAfter == DESTINATION_COLLATERAL, "destination collateral mismatch"
        );
        require(destinationDebtAfter == DESTINATION_DEBT, "destination debt mismatch");
        require(
            destinationDebtToken.balanceOf(address(this)) == DESTINATION_DEBT,
            "payout receiver mismatch"
        );

        (bool replayedDestination,) = address(destinationAdapter)
            .call(abi.encodeCall(DestinationAdapter.openDestination, (openTerms)));
        require(!replayedDestination, "destination replay succeeded");

        sourceDebtToken.mint(address(this), 50_000_000);
        sourceDebtToken.approve(address(vault), DESTINATION_DEBT);
        vault.settle(MIGRATION_ID, address(this), 50_000_000);
        require(vault.principalReceivable(address(sourceDebtToken)) == 0, "receivable remains");
        require(
            sourceDebtToken.balanceOf(address(vault)) == 20_050_000_000, "vault settlement mismatch"
        );
    }

    function testTransportRefundCanBeReturnedWithoutCrossMigrationConsumption() public {
        sourceAdapter.closeSource(_closeTerms());
        sourceEscrow.release(
            MIGRATION_ID, IERC20(address(sourceCollateralToken)), address(this), SOURCE_COLLATERAL
        );

        sourceCollateralToken.approve(address(sourceEscrow), SOURCE_COLLATERAL);
        sourceEscrow.assign(
            MIGRATION_ID, IERC20(address(sourceCollateralToken)), address(this), SOURCE_COLLATERAL
        );
        sourceEscrow.release(
            MIGRATION_ID, IERC20(address(sourceCollateralToken)), address(this), SOURCE_COLLATERAL
        );

        require(
            sourceCollateralToken.balanceOf(address(this)) == SOURCE_COLLATERAL,
            "refund did not return collateral"
        );
        require(
            sourceEscrow.balances(MIGRATION_ID, address(sourceCollateralToken)) == 0,
            "refund left escrow balance"
        );
    }

    function _closeTerms() private view returns (SourceAdapter.CloseTerms memory) {
        return SourceAdapter.CloseTerms({
            migrationId: MIGRATION_ID,
            borrower: address(this),
            maximumDebtUnits: SOURCE_DEBT,
            minimumCollateralUnits: SOURCE_COLLATERAL,
            deadline: uint64(block.timestamp + 30 minutes)
        });
    }

    function _openTerms() private view returns (DestinationAdapter.OpenTerms memory) {
        return DestinationAdapter.OpenTerms({
            migrationId: MIGRATION_ID,
            borrower: address(this),
            payoutReceiver: address(this),
            collateralUnits: DESTINATION_COLLATERAL,
            minimumCollateralUnits: 9.8 ether,
            borrowUnits: DESTINATION_DEBT,
            maximumDebtUnits: 10_100_000_000,
            deadline: uint64(block.timestamp + 30 minutes)
        });
    }
}
