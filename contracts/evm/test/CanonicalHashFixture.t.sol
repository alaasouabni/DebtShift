// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { DebtShiftHashing } from "../src/DebtShiftHashing.sol";

contract CanonicalHashFixtureTest {
    uint256 internal constant SOURCE_CHAIN_ID = 31_337;
    address internal constant BORROWER = 0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa;
    address internal constant VERIFYING_CONTRACT = 0x9000000000000000000000000000000000000009;
    bytes32 internal constant QUOTE_HASH =
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
    bytes32 internal constant RESERVATION_HASH =
        0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    bytes32 internal constant FINANCING_HASH =
        0x85f3bad6e3b068aab393e9edcf51b3839cd982b0786e4bc6d5ebbdd0793a9319;

    bytes32 internal constant EXPECTED_POSITION =
        0xc0552755e1b8638016061a1864011b9be643b108a402cd4fee6be1086fe0b229;
    bytes32 internal constant EXPECTED_INTENT =
        0xc2e5a504712bc821fa9e832436b40d73c0e22a6455b20cb5936ee309cadc4f68;
    bytes32 internal constant EXPECTED_MIGRATION =
        0xa7a7958ed9a149c205e67a7b5985d63b4932f7f326ea3f45a0d0d0cc969d8662;
    bytes32 internal constant EXPECTED_ROUTE =
        0xc994f5511dd058f4a504da5ba0c56415e06d695b13ff91ef8ed2bbfafe7aed9e;
    bytes32 internal constant EXPECTED_PLAN =
        0x8a692505f195855ff08566af7cb4cfbfe3acd3934ff4bca295cd51e629cd824e;

    function testCanonicalHashFixture() public pure {
        bytes32 sourceMarket = DebtShiftHashing.hashMarketReference(
            SOURCE_CHAIN_ID,
            DebtShiftHashing.protocolId("debtshift.protocol.local-aave-mock.v1"),
            0x1000000000000000000000000000000000000001,
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111))
        );
        bytes32 sourceCollateral = DebtShiftHashing.hashTokenReference(
            SOURCE_CHAIN_ID, 0x2000000000000000000000000000000000000002, 18
        );
        bytes32 sourceDebt = DebtShiftHashing.hashTokenReference(
            SOURCE_CHAIN_ID, 0x3000000000000000000000000000000000000003, 6
        );
        bytes32 position = DebtShiftHashing.hashSourcePosition(
            sourceMarket, BORROWER, sourceCollateral, sourceDebt
        );
        require(position == EXPECTED_POSITION, "source position fixture mismatch");

        bytes32 targetMarket = DebtShiftHashing.hashMarketReference(
            31_338,
            DebtShiftHashing.protocolId("debtshift.protocol.local-morpho-mock.v1"),
            0x4000000000000000000000000000000000000004,
            bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222))
        );
        bytes32[] memory allowedTargets = new bytes32[](1);
        allowedTargets[0] = targetMarket;

        DebtShiftHashing.RefinanceIntentHashInput memory intentInput =
            DebtShiftHashing.RefinanceIntentHashInput({
                borrower: BORROWER,
                sourcePositionId: position,
                allowedTargetsHash: keccak256(abi.encode(allowedTargets)),
                feeAssetHash: DebtShiftHashing.hashTokenReference(
                    31_338, 0x5000000000000000000000000000000000000005, 6
                ),
                maxSourceDebt: 10_000_000_000,
                minSourceCollateral: 9_900_000_000_000_000_000,
                maxTotalFee: 100_000_000,
                maxSlippageBps: 50,
                minAprReductionBps: 150,
                safetyPolicyHash: keccak256(
                    abi.encode(
                        keccak256("debtshift.safety.max-ltv-bps.v1"), uint256(7000), uint256(6500)
                    )
                ),
                maxDurationSeconds: 1800,
                expiration: 1_794_000_000,
                nonce: 7
            });
        bytes32 intentHash = DebtShiftHashing.hashRefinanceIntent(
            intentInput, SOURCE_CHAIN_ID, VERIFYING_CONTRACT
        );
        require(intentHash == EXPECTED_INTENT, "intent fixture mismatch");

        bytes32 migrationId = DebtShiftHashing.computeMigrationId(intentHash, QUOTE_HASH, 9);
        require(migrationId == EXPECTED_MIGRATION, "migration fixture mismatch");

        bytes32 routeHash =
            _routeHash(position, sourceMarket, targetMarket, sourceDebt, sourceCollateral);
        require(routeHash == EXPECTED_ROUTE, "route fixture mismatch");

        DebtShiftHashing.ExecutionPlanHashInput memory planInput =
            DebtShiftHashing.ExecutionPlanHashInput({
                intentHash: intentHash,
                migrationId: migrationId,
                borrower: BORROWER,
                sourcePositionId: position,
                routeHash: routeHash,
                transportQuoteHash: QUOTE_HASH,
                sourceRepaymentMax: 10_000_000_000,
                sourceCollateralMin: 9_900_000_000_000_000_000,
                targetDebtMax: 10_050_000_000,
                minDestinationCollateral: 9_800_000_000_000_000_000,
                principalMax: 10_000_000_000,
                feeMax: 50_000_000,
                destinationReceiver: 0x7000000000000000000000000000000000000007,
                transportRefundReceiver: 0x7100000000000000000000000000000000000007,
                refundReceiver: BORROWER,
                payoutReceiver: 0x8000000000000000000000000000000000000008,
                deadline: 1_793_999_000,
                nonce: 9
            });
        bytes32 planHash =
            DebtShiftHashing.hashExecutionPlan(planInput, SOURCE_CHAIN_ID, VERIFYING_CONTRACT);
        require(planHash == EXPECTED_PLAN, "execution plan fixture mismatch");
    }

    function _routeHash(
        bytes32 position,
        bytes32 sourceMarket,
        bytes32 targetMarket,
        bytes32 sourceDebt,
        bytes32 sourceCollateral
    ) private pure returns (bytes32) {
        return DebtShiftHashing.hashRoute(
            DebtShiftHashing.RouteHashInput({
                sourcePositionId: position,
                sourceMarketHash: sourceMarket,
                targetMarketHash: targetMarket,
                sourceDebtAssetHash: sourceDebt,
                sourceCollateralAssetHash: sourceCollateral,
                destinationDebtAssetHash: DebtShiftHashing.hashTokenReference(
                    31_338, 0x5000000000000000000000000000000000000005, 6
                ),
                destinationCollateralAssetHash: DebtShiftHashing.hashTokenReference(
                    31_338, 0x6000000000000000000000000000000000000006, 18
                ),
                sourceRepaymentMax: 10_000_000_000,
                sourceCollateralMin: 9_900_000_000_000_000_000,
                targetDebtMax: 10_050_000_000,
                minDestinationCollateral: 9_800_000_000_000_000_000,
                transportProviderHash: keccak256("DEBTSHIFT_SIMULATOR"),
                transportQuoteHash: QUOTE_HASH,
                transportDepositAddressHash: keccak256("simulator:deposit:migration-7"),
                destinationReceiver: 0x7000000000000000000000000000000000000007,
                transportRefundReceiver: 0x7100000000000000000000000000000000000007,
                refundReceiver: BORROWER,
                fundingProvider: 0x8000000000000000000000000000000000000008,
                reservationHash: RESERVATION_HASH,
                payoutAssetHash: DebtShiftHashing.hashTokenReference(
                    31_338, 0x5000000000000000000000000000000000000005, 6
                ),
                payoutReceiver: 0x8000000000000000000000000000000000000008,
                principalMax: 10_000_000_000,
                feeMax: 50_000_000,
                financingHash: FINANCING_HASH,
                deadline: 1_793_999_000
            })
        );
    }
}
