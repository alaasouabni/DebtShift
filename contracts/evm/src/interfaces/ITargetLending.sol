// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "./IERC20.sol";

interface ITargetLending {
    function collateralToken() external view returns (IERC20);

    function debtToken() external view returns (IERC20);

    function openPosition(
        address borrower,
        address collateralProvider,
        address debtReceiver,
        uint256 collateralUnits,
        uint256 debtUnits,
        bytes calldata authorizationData
    ) external;
}
