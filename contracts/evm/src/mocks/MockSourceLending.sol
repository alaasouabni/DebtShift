// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../interfaces/IERC20.sol";
import { SafeToken } from "../libraries/SafeToken.sol";

contract MockSourceLending {
    using SafeToken for IERC20;

    error InvalidAmount();
    error PositionAlreadyExists();
    error PositionNotFound();
    error DebtCapExceeded(uint256 debt, uint256 maximum);
    error CollateralBelowMinimum(uint256 collateral, uint256 minimum);

    struct Position {
        uint256 collateralUnits;
        uint256 debtUnits;
    }

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    mapping(address borrower => Position position) public positions;

    event PositionOpened(address indexed borrower, uint256 collateralUnits, uint256 debtUnits);
    event PositionClosed(
        address indexed borrower,
        address indexed collateralReceiver,
        uint256 repaidDebtUnits,
        uint256 releasedCollateralUnits
    );

    constructor(IERC20 collateralToken_, IERC20 debtToken_) {
        collateralToken = collateralToken_;
        debtToken = debtToken_;
    }

    function openPosition(uint256 collateralUnits, uint256 debtUnits) external {
        if (collateralUnits == 0 || debtUnits == 0) revert InvalidAmount();
        if (positions[msg.sender].collateralUnits != 0) revert PositionAlreadyExists();

        collateralToken.transferFromWithExactDelta(msg.sender, address(this), collateralUnits);
        debtToken.safeTransfer(msg.sender, debtUnits);
        positions[msg.sender] = Position(collateralUnits, debtUnits);
        emit PositionOpened(msg.sender, collateralUnits, debtUnits);
    }

    function closePosition(
        address borrower,
        uint256 maximumDebtUnits,
        uint256 minimumCollateralUnits,
        address collateralReceiver
    ) external returns (uint256 repaidDebtUnits, uint256 releasedCollateralUnits) {
        Position memory position = positions[borrower];
        if (position.collateralUnits == 0) revert PositionNotFound();
        if (position.debtUnits > maximumDebtUnits) {
            revert DebtCapExceeded(position.debtUnits, maximumDebtUnits);
        }
        if (position.collateralUnits < minimumCollateralUnits) {
            revert CollateralBelowMinimum(position.collateralUnits, minimumCollateralUnits);
        }

        delete positions[borrower];
        debtToken.transferFromWithExactDelta(msg.sender, address(this), position.debtUnits);
        collateralToken.safeTransfer(collateralReceiver, position.collateralUnits);
        emit PositionClosed(
            borrower, collateralReceiver, position.debtUnits, position.collateralUnits
        );
        return (position.debtUnits, position.collateralUnits);
    }
}
