// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../interfaces/IERC20.sol";
import { SafeToken } from "../libraries/SafeToken.sol";
import { TestToken } from "./TestToken.sol";

contract MockAaveV3Pool {
    using SafeToken for IERC20;

    error InvalidAmount();
    error PositionAlreadyExists();
    error PositionNotFound();
    error UnsupportedAsset();
    error UnsupportedRateMode();

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    IERC20 public immutable aToken;
    mapping(address borrower => uint256 debtUnits) public balanceOf;

    constructor(IERC20 collateralToken_, IERC20 debtToken_, IERC20 aToken_) {
        collateralToken = collateralToken_;
        debtToken = debtToken_;
        aToken = aToken_;
    }

    function openPosition(address borrower, uint256 collateralUnits, uint256 debtUnits) external {
        if (borrower == address(0) || collateralUnits == 0 || debtUnits == 0) {
            revert InvalidAmount();
        }
        if (balanceOf[borrower] != 0 || aToken.balanceOf(borrower) != 0) {
            revert PositionAlreadyExists();
        }
        collateralToken.transferFromWithExactDelta(borrower, address(this), collateralUnits);
        TestToken(address(aToken)).mint(borrower, collateralUnits);
        debtToken.transferWithExactDelta(borrower, debtUnits);
        balanceOf[borrower] = debtUnits;
    }

    function accrueDebt(address borrower, uint256 amountUnits) external {
        if (balanceOf[borrower] == 0) revert PositionNotFound();
        if (amountUnits == 0) revert InvalidAmount();
        balanceOf[borrower] += amountUnits;
    }

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256 repaidUnits)
    {
        if (asset != address(debtToken)) revert UnsupportedAsset();
        if (interestRateMode != 2) revert UnsupportedRateMode();
        uint256 currentDebt = balanceOf[onBehalfOf];
        if (currentDebt == 0) revert PositionNotFound();
        repaidUnits = amount < currentDebt ? amount : currentDebt;
        debtToken.transferFromWithExactDelta(msg.sender, address(this), repaidUnits);
        balanceOf[onBehalfOf] = currentDebt - repaidUnits;
    }

    function withdraw(address asset, uint256 amount, address receiver)
        external
        returns (uint256 withdrawnUnits)
    {
        if (asset != address(collateralToken)) revert UnsupportedAsset();
        if (amount == 0 || receiver == address(0)) revert InvalidAmount();
        aToken.transferFromWithExactDelta(msg.sender, address(this), amount);
        collateralToken.transferWithExactDelta(receiver, amount);
        return amount;
    }
}
