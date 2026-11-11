// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../interfaces/IERC20.sol";
import { ITargetLending } from "../interfaces/ITargetLending.sol";
import { SafeToken } from "../libraries/SafeToken.sol";

contract MockTargetLending is ITargetLending {
    using SafeToken for IERC20;

    error InvalidAmount();
    error Unauthorized();
    error PositionAlreadyExists();
    error UnsafeLoanToValue(uint256 requestedDebtValue, uint256 maximumDebtValue);

    struct Position {
        uint256 collateralUnits;
        uint256 debtUnits;
    }

    IERC20 public immutable override collateralToken;
    IERC20 public immutable override debtToken;
    address public immutable owner;
    uint16 public maximumLtvBps;
    uint256 public collateralPriceInDebtWad;
    uint16 public borrowAprBps;
    uint8 public immutable collateralDecimals;
    uint8 public immutable debtDecimals;
    mapping(address borrower => Position position) public positions;

    event PositionOpened(
        address indexed borrower,
        address indexed debtReceiver,
        uint256 collateralUnits,
        uint256 debtUnits
    );
    event MarketStateUpdated(
        uint256 collateralPriceInDebtWad, uint16 maximumLtvBps, uint16 borrowAprBps
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
        owner = msg.sender;
        collateralDecimals = collateralDecimals_;
        debtDecimals = debtDecimals_;
        collateralPriceInDebtWad = collateralPriceInDebtWad_;
        maximumLtvBps = maximumLtvBps_;
        borrowAprBps = 500;
    }

    function setMarketState(
        uint256 collateralPriceInDebtWad_,
        uint16 maximumLtvBps_,
        uint16 borrowAprBps_
    ) external {
        if (msg.sender != owner) revert Unauthorized();
        if (
            collateralPriceInDebtWad_ == 0 || maximumLtvBps_ == 0 || maximumLtvBps_ > 10_000
                || borrowAprBps_ > 10_000
        ) revert InvalidAmount();
        collateralPriceInDebtWad = collateralPriceInDebtWad_;
        maximumLtvBps = maximumLtvBps_;
        borrowAprBps = borrowAprBps_;
        emit MarketStateUpdated(collateralPriceInDebtWad_, maximumLtvBps_, borrowAprBps_);
    }

    function openPosition(
        address borrower,
        address collateralProvider,
        address debtReceiver,
        uint256 collateralUnits,
        uint256 debtUnits,
        bytes calldata authorizationData
    ) external {
        if (collateralUnits == 0 || debtUnits == 0 || authorizationData.length != 0) {
            revert InvalidAmount();
        }
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
