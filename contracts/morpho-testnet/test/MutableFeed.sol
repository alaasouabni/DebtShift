// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

import { IChainlinkFeed } from "../src/DebtShiftChainlinkOracle.sol";

contract MutableFeed is IChainlinkFeed {
    uint8 public immutable override decimals;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    constructor(uint8 feedDecimals, int256 initialAnswer) {
        decimals = feedDecimals;
        answer = initialAnswer;
        startedAt = block.timestamp > 10_000 ? block.timestamp - 10_000 : 1;
        updatedAt = block.timestamp;
    }

    function setRound(int256 nextAnswer, uint256 nextStartedAt, uint256 nextUpdatedAt) external {
        answer = nextAnswer;
        startedAt = nextStartedAt;
        updatedAt = nextUpdatedAt;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}
