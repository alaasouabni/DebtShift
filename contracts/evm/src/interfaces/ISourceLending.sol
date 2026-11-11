// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "./IERC20.sol";

interface ISourceLending {
    function debtToken() external view returns (IERC20);
    function collateralToken() external view returns (IERC20);

    function closePosition(
        address borrower,
        uint256 maximumDebtUnits,
        uint256 minimumCollateralUnits,
        address collateralReceiver
    ) external returns (uint256 repaidDebtUnits, uint256 releasedCollateralUnits);
}
