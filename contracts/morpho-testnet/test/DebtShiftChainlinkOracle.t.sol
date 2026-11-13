// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import { DebtShiftChainlinkOracle, IChainlinkFeed } from "../src/DebtShiftChainlinkOracle.sol";
import { MutableFeed } from "./MutableFeed.sol";

interface Vm {
    function warp(uint256 timestamp) external;
}

contract MetadataToken {
    uint8 public immutable decimals;

    constructor(uint8 tokenDecimals) {
        decimals = tokenDecimals;
    }
}

contract DebtShiftChainlinkOracleTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MetadataToken private collateral = new MetadataToken(18);
    MetadataToken private loan = new MetadataToken(6);
    MutableFeed private collateralFeed = new MutableFeed(8, 2_000e8);
    MutableFeed private loanFeed = new MutableFeed(8, 1e8);

    function testReturnsMorphoScaledCrossPrice() external {
        DebtShiftChainlinkOracle oracle = new DebtShiftChainlinkOracle(
            address(collateral),
            address(loan),
            collateralFeed,
            loanFeed,
            IChainlinkFeed(address(0)),
            1 days,
            0
        );
        require(oracle.SCALE_FACTOR() == 1e24, "unexpected scale");
        require(oracle.price() == 2_000e24, "unexpected price");
    }

    function testRejectsStaleFeed() external {
        DebtShiftChainlinkOracle oracle = new DebtShiftChainlinkOracle(
            address(collateral),
            address(loan),
            collateralFeed,
            loanFeed,
            IChainlinkFeed(address(0)),
            60,
            0
        );
        vm.warp(1_000);
        collateralFeed.setRound(2_000e8, 1, 1);
        try oracle.price() returns (uint256) {
            revert("stale price accepted");
        } catch { }
    }

    function testRejectsSequencerOutage() external {
        MutableFeed sequencerFeed = new MutableFeed(0, 1);
        DebtShiftChainlinkOracle oracle = new DebtShiftChainlinkOracle(
            address(collateral), address(loan), collateralFeed, loanFeed, sequencerFeed, 1 days, 1
        );
        try oracle.price() returns (uint256) {
            revert("sequencer outage accepted");
        } catch { }
    }
}
