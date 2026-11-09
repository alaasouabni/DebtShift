// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

abstract contract ReentrancyGuard {
    error ReentrantCall();

    uint256 private _status = 1;

    modifier nonReentrant() {
        if (_status != 1) revert ReentrantCall();
        _status = 2;
        _;
        _status = 1;
    }
}
