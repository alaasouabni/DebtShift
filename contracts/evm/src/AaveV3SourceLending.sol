// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "./interfaces/IERC20.sol";
import { ISourceLending } from "./interfaces/ISourceLending.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

interface IAaveV3Pool {
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256 repaidUnits);

    function withdraw(address asset, uint256 amount, address receiver)
        external
        returns (uint256 withdrawnUnits);
}

/// @notice Atomic Aave V3 position-close module used only by DebtShift's signed SourceAdapter.
/// @dev The borrower pre-approves exactly the signed collateral amount in aTokens. Repayment,
///      aToken transfer, underlying withdrawal, and receiver balance validation all share one
///      transaction, so a failed collateral claim also reverts the solver-funded repayment.
contract AaveV3SourceLending is ISourceLending, ReentrancyGuard {
    using SafeToken for IERC20;

    error Unauthorized();
    error AlreadyConfigured();
    error InvalidConfiguration();
    error PositionNotFound();
    error DebtCapExceeded(uint256 debtUnits, uint256 maximumUnits);
    error CollateralBelowMinimum(uint256 collateralUnits, uint256 minimumUnits);
    error RepaymentMismatch(uint256 expectedUnits, uint256 actualUnits);
    error DebtRemains(uint256 remainingUnits);
    error WithdrawalMismatch(uint256 expectedUnits, uint256 actualUnits);

    uint256 private constant VARIABLE_INTEREST_RATE_MODE = 2;

    address public immutable owner;
    IAaveV3Pool public immutable pool;
    IERC20 public immutable aToken;
    IERC20 public immutable variableDebtToken;
    IERC20 public immutable override collateralToken;
    IERC20 public immutable override debtToken;
    address public sourceAdapter;

    event SourceAdapterConfigured(address indexed sourceAdapter);
    event AavePositionClosed(
        address indexed borrower,
        address indexed collateralReceiver,
        uint256 repaidDebtUnits,
        uint256 releasedCollateralUnits
    );

    constructor(
        address owner_,
        IAaveV3Pool pool_,
        IERC20 aToken_,
        IERC20 variableDebtToken_,
        IERC20 collateralToken_,
        IERC20 debtToken_
    ) {
        if (
            owner_ == address(0) || address(pool_) == address(0) || address(aToken_) == address(0)
                || address(variableDebtToken_) == address(0)
                || address(collateralToken_) == address(0) || address(debtToken_) == address(0)
                || address(collateralToken_) == address(debtToken_)
                || address(aToken_) == address(variableDebtToken_)
        ) revert InvalidConfiguration();
        owner = owner_;
        pool = pool_;
        aToken = aToken_;
        variableDebtToken = variableDebtToken_;
        collateralToken = collateralToken_;
        debtToken = debtToken_;
    }

    function setSourceAdapter(address sourceAdapter_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (sourceAdapter != address(0)) revert AlreadyConfigured();
        if (sourceAdapter_ == address(0) || sourceAdapter_.code.length == 0) {
            revert InvalidConfiguration();
        }
        sourceAdapter = sourceAdapter_;
        emit SourceAdapterConfigured(sourceAdapter_);
    }

    function closePosition(
        address borrower,
        uint256 maximumDebtUnits,
        uint256 minimumCollateralUnits,
        address collateralReceiver
    )
        external
        override
        nonReentrant
        returns (uint256 repaidDebtUnits, uint256 releasedCollateralUnits)
    {
        if (msg.sender != sourceAdapter) revert Unauthorized();
        if (
            borrower == address(0) || collateralReceiver == address(0) || maximumDebtUnits == 0
                || minimumCollateralUnits == 0
        ) revert InvalidConfiguration();

        uint256 debtUnits = variableDebtToken.balanceOf(borrower);
        if (debtUnits == 0) revert PositionNotFound();
        if (debtUnits > maximumDebtUnits) revert DebtCapExceeded(debtUnits, maximumDebtUnits);

        uint256 collateralUnits = aToken.balanceOf(borrower);
        if (collateralUnits < minimumCollateralUnits) {
            revert CollateralBelowMinimum(collateralUnits, minimumCollateralUnits);
        }

        debtToken.transferFromWithExactDelta(msg.sender, address(this), debtUnits);
        debtToken.forceApprove(address(pool), debtUnits);
        repaidDebtUnits =
            pool.repay(address(debtToken), debtUnits, VARIABLE_INTEREST_RATE_MODE, borrower);
        debtToken.forceApprove(address(pool), 0);
        if (repaidDebtUnits != debtUnits) revert RepaymentMismatch(debtUnits, repaidDebtUnits);

        uint256 remainingDebt = variableDebtToken.balanceOf(borrower);
        if (remainingDebt != 0) revert DebtRemains(remainingDebt);

        aToken.transferFromWithExactDelta(borrower, address(this), minimumCollateralUnits);
        // Aave burns the caller's aTokens directly. The bounded approval is inert there and also
        // lets deterministic protocol fixtures model the same ownership transition with ERC-20.
        aToken.forceApprove(address(pool), minimumCollateralUnits);
        uint256 receiverBalanceBefore = collateralToken.balanceOf(collateralReceiver);
        releasedCollateralUnits =
            pool.withdraw(address(collateralToken), minimumCollateralUnits, collateralReceiver);
        aToken.forceApprove(address(pool), 0);
        if (releasedCollateralUnits != minimumCollateralUnits) {
            revert WithdrawalMismatch(minimumCollateralUnits, releasedCollateralUnits);
        }
        uint256 receiverDelta =
            collateralToken.balanceOf(collateralReceiver) - receiverBalanceBefore;
        if (receiverDelta != minimumCollateralUnits) {
            revert WithdrawalMismatch(minimumCollateralUnits, receiverDelta);
        }

        emit AavePositionClosed(
            borrower, collateralReceiver, repaidDebtUnits, releasedCollateralUnits
        );
    }
}
