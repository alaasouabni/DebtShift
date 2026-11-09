// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../interfaces/IERC20.sol";
import { SafeToken } from "../libraries/SafeToken.sol";

contract MockTargetLending {
    using SafeToken for IERC20;

    error InvalidAmount();
    error PositionAlreadyExists();
    error UnsafeLoanToValue(uint256 requestedDebtValue, uint256 maximumDebtValue);

    struct Position {
        uint256 collateralUnits;
        uint256 debtUnits;
    }

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken;
    uint16 public immutable maximumLtvBps;
    uint256 public immutable collateralPriceInDebtWad;
    uint8 public immutable collateralDecimals;
    uint8 public immutable debtDecimals;
    mapping(address borrower => Position position) public positions;

    event PositionOpened(
        address indexed borrower,
        address indexed debtReceiver,
        uint256 collateralUnits,
        uint256 debtUnits
    );

    constructor(
        IERC20 collateralToken_,
        IERC20 debtToken_,
        uint8 collateralDecimals_,
        uint8 debtDecimals_,
        uint256 collateralPriceInDebtWad_,
        uint16 maximumLtvBps_
    ) {
        if (maximumLtvBps_ == 0 || maximumLtvBps_ > 10_000 || collateralPriceInDebtWad_ == 0) {
            revert InvalidAmount();
        }
        collateralToken = collateralToken_;
        debtToken = debtToken_;
        collateralDecimals = collateralDecimals_;
        debtDecimals = debtDecimals_;
        collateralPriceInDebtWad = collateralPriceInDebtWad_;
        maximumLtvBps = maximumLtvBps_;
    }

    function openPosition(
        address borrower,
        address collateralProvider,
        address debtReceiver,
        uint256 collateralUnits,
        uint256 debtUnits
    ) external {
        if (collateralUnits == 0 || debtUnits == 0) revert InvalidAmount();
        if (positions[borrower].collateralUnits != 0) revert PositionAlreadyExists();

        uint256 normalizedCollateral = _scaleTo18(collateralUnits, collateralDecimals);
        uint256 normalizedDebt = _scaleTo18(debtUnits, debtDecimals);
        uint256 collateralValueInDebt = (normalizedCollateral * collateralPriceInDebtWad) / 1e18;
        uint256 maximumDebt = (collateralValueInDebt * maximumLtvBps) / 10_000;
        if (normalizedDebt > maximumDebt) {
            revert UnsafeLoanToValue(normalizedDebt, maximumDebt);
        }

        collateralToken.transferFromWithExactDelta(
            collateralProvider, address(this), collateralUnits
        );
        debtToken.safeTransfer(debtReceiver, debtUnits);
        positions[borrower] = Position(collateralUnits, debtUnits);
        emit PositionOpened(borrower, debtReceiver, collateralUnits, debtUnits);
    }

    function _scaleTo18(uint256 amount, uint8 tokenDecimals) private pure returns (uint256) {
        if (tokenDecimals == 18) return amount;
        if (tokenDecimals < 18) return amount * (10 ** (18 - tokenDecimals));
        return amount / (10 ** (tokenDecimals - 18));
    }
}
