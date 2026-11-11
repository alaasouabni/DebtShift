// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "./interfaces/IERC20.sol";
import { IMorphoBlue } from "./interfaces/IMorphoBlue.sol";
import { ITargetLending } from "./interfaces/ITargetLending.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

contract MorphoBlueTargetLending is ITargetLending, ReentrancyGuard {
    using SafeToken for IERC20;

    struct OpenRequest {
        address borrower;
        address collateralProvider;
        address debtReceiver;
        uint256 collateralUnits;
        uint256 debtUnits;
    }

    struct AuthorizationPair {
        IMorphoBlue.Authorization enable;
        IMorphoBlue.Signature enableSignature;
        IMorphoBlue.Authorization disable;
        IMorphoBlue.Signature disableSignature;
    }

    struct BalanceSnapshot {
        uint256 receiverDebt;
        uint256 moduleCollateral;
        uint256 moduleDebt;
    }

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidAuthorization();
    error ExistingPosition();
    error PositionMismatch();
    error BorrowMismatch();
    error ResidualBalance();

    address public immutable owner;
    IMorphoBlue public immutable morpho;
    IERC20 public immutable override collateralToken;
    IERC20 public immutable override debtToken;
    bytes32 public immutable marketId;
    address public destinationAdapter;

    IMorphoBlue.MarketParams private _marketParams;

    event DestinationAdapterConfigured(address indexed destinationAdapter);
    event MorphoPositionOpened(
        address indexed borrower,
        address indexed debtReceiver,
        bytes32 indexed marketId,
        uint256 collateralUnits,
        uint256 debtUnits,
        uint256 borrowShares
    );

    constructor(
        address owner_,
        IMorphoBlue morpho_,
        IMorphoBlue.MarketParams memory marketParams_
    ) {
        if (
            owner_ == address(0) || address(morpho_) == address(0)
                || marketParams_.loanToken == address(0)
                || marketParams_.collateralToken == address(0) || marketParams_.oracle == address(0)
                || marketParams_.lltv == 0
        ) revert InvalidConfiguration();

        bytes32 marketId_ = keccak256(abi.encode(marketParams_));
        IMorphoBlue.MarketParams memory registered = morpho_.idToMarketParams(marketId_);
        if (
            registered.loanToken != marketParams_.loanToken
                || registered.collateralToken != marketParams_.collateralToken
                || registered.oracle != marketParams_.oracle || registered.irm != marketParams_.irm
                || registered.lltv != marketParams_.lltv
        ) revert InvalidConfiguration();

        owner = owner_;
        morpho = morpho_;
        collateralToken = IERC20(marketParams_.collateralToken);
        debtToken = IERC20(marketParams_.loanToken);
        marketId = marketId_;
        _marketParams = marketParams_;
    }

    function setDestinationAdapter(address destinationAdapter_) external {
        if (
            msg.sender != owner || destinationAdapter != address(0)
                || destinationAdapter_ == address(0)
        ) {
            revert Unauthorized();
        }
        destinationAdapter = destinationAdapter_;
        emit DestinationAdapterConfigured(destinationAdapter_);
    }

    function marketParams() external view returns (IMorphoBlue.MarketParams memory) {
        return _marketParams;
    }

    function openPosition(
        address borrower,
        address collateralProvider,
        address debtReceiver,
        uint256 collateralUnits,
        uint256 debtUnits,
        bytes calldata authorizationData
    ) external nonReentrant {
        if (msg.sender != destinationAdapter || collateralProvider != msg.sender) {
            revert Unauthorized();
        }
        if (
            borrower == address(0) || debtReceiver == address(0) || collateralUnits == 0
                || debtUnits == 0 || authorizationData.length == 0
        ) revert InvalidConfiguration();

        OpenRequest memory request = OpenRequest({
            borrower: borrower,
            collateralProvider: collateralProvider,
            debtReceiver: debtReceiver,
            collateralUnits: collateralUnits,
            debtUnits: debtUnits
        });
        AuthorizationPair memory authorizations = abi.decode(authorizationData, (AuthorizationPair));
        _validateAuthorizationPair(request.borrower, authorizations.enable, authorizations.disable);
        _openPosition(request, authorizations);
    }

    function _openPosition(OpenRequest memory request, AuthorizationPair memory authorizations)
        private
    {
        (uint256 supplySharesBefore, uint128 borrowSharesBefore, uint128 collateralBefore) =
            morpho.position(marketId, request.borrower);
        supplySharesBefore;
        if (borrowSharesBefore != 0 || collateralBefore != 0) revert ExistingPosition();

        BalanceSnapshot memory balances = BalanceSnapshot({
            receiverDebt: debtToken.balanceOf(request.debtReceiver),
            moduleCollateral: collateralToken.balanceOf(address(this)),
            moduleDebt: debtToken.balanceOf(address(this))
        });
        collateralToken.transferFromWithExactDelta(
            request.collateralProvider, address(this), request.collateralUnits
        );
        collateralToken.forceApprove(address(morpho), request.collateralUnits);

        morpho.setAuthorizationWithSig(authorizations.enable, authorizations.enableSignature);
        morpho.supplyCollateral(_marketParams, request.collateralUnits, request.borrower, bytes(""));
        (uint256 borrowedAssets, uint256 borrowedShares) = morpho.borrow(
            _marketParams, request.debtUnits, 0, request.borrower, request.debtReceiver
        );
        if (borrowedAssets != request.debtUnits || borrowedShares == 0) revert BorrowMismatch();
        morpho.setAuthorizationWithSig(authorizations.disable, authorizations.disableSignature);

        collateralToken.forceApprove(address(morpho), 0);
        if (morpho.isAuthorized(request.borrower, address(this))) revert InvalidAuthorization();
        if (morpho.nonce(request.borrower) != authorizations.disable.nonce + 1) {
            revert InvalidAuthorization();
        }

        (, uint128 borrowSharesAfter, uint128 collateralAfter) =
            morpho.position(marketId, request.borrower);
        if (
            uint256(collateralAfter) != uint256(collateralBefore) + request.collateralUnits
                || uint256(borrowSharesAfter) != uint256(borrowSharesBefore) + borrowedShares
        ) revert PositionMismatch();
        if (debtToken.balanceOf(request.debtReceiver) - balances.receiverDebt != request.debtUnits)
        {
            revert BorrowMismatch();
        }
        if (
            collateralToken.balanceOf(address(this)) != balances.moduleCollateral
                || debtToken.balanceOf(address(this)) != balances.moduleDebt
        ) revert ResidualBalance();

        emit MorphoPositionOpened(
            request.borrower,
            request.debtReceiver,
            marketId,
            request.collateralUnits,
            request.debtUnits,
            borrowedShares
        );
    }

    function _validateAuthorizationPair(
        address borrower,
        IMorphoBlue.Authorization memory enable,
        IMorphoBlue.Authorization memory disable
    ) private view {
        if (
            enable.authorizer != borrower || disable.authorizer != borrower
                || enable.authorized != address(this) || disable.authorized != address(this)
                || !enable.isAuthorized || disable.isAuthorized || disable.nonce != enable.nonce + 1
                || enable.deadline < block.timestamp || disable.deadline < block.timestamp
                || morpho.nonce(borrower) != enable.nonce
                || morpho.isAuthorized(borrower, address(this))
        ) revert InvalidAuthorization();
    }
}
