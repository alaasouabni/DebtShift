// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../interfaces/IERC20.sol";
import { IMorphoBlue } from "../interfaces/IMorphoBlue.sol";
import { SafeToken } from "../libraries/SafeToken.sol";

contract MockMorphoBlue is IMorphoBlue {
    using SafeToken for IERC20;

    error InvalidMarket();
    error InvalidAuthorization();
    error InvalidAmount();

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");
    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    mapping(bytes32 id => IMorphoBlue.MarketParams params) private _marketParams;
    mapping(bytes32 id => mapping(address user => Position positionData)) private _positions;
    mapping(address authorizer => mapping(address authorized => bool allowed))
        public
        override isAuthorized;
    mapping(address authorizer => uint256 currentNonce) public override nonce;

    constructor(IMorphoBlue.MarketParams memory marketParams_) {
        bytes32 id = keccak256(abi.encode(marketParams_));
        _marketParams[id] = marketParams_;
        DOMAIN_SEPARATOR = keccak256(abi.encode(DOMAIN_TYPEHASH, block.chainid, address(this)));
    }

    function idToMarketParams(bytes32 id)
        external
        view
        override
        returns (IMorphoBlue.MarketParams memory)
    {
        return _marketParams[id];
    }

    function position(bytes32 id, address user)
        external
        view
        override
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)
    {
        Position storage stored = _positions[id][user];
        return (stored.supplyShares, stored.borrowShares, stored.collateral);
    }

    function setAuthorizationWithSig(
        IMorphoBlue.Authorization calldata authorization,
        IMorphoBlue.Signature calldata signature
    ) external override {
        if (
            block.timestamp > authorization.deadline
                || authorization.nonce != nonce[authorization.authorizer]
        ) {
            revert InvalidAuthorization();
        }
        bytes32 structHash = keccak256(abi.encode(AUTHORIZATION_TYPEHASH, authorization));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash));
        address signer = ecrecover(digest, signature.v, signature.r, signature.s);
        if (signer == address(0) || signer != authorization.authorizer) {
            revert InvalidAuthorization();
        }
        nonce[authorization.authorizer] = authorization.nonce + 1;
        isAuthorized[authorization.authorizer][authorization.authorized] =
        authorization.isAuthorized;
    }

    function supplyCollateral(
        IMorphoBlue.MarketParams calldata marketParams_,
        uint256 assets,
        address onBehalf,
        bytes calldata
    ) external override {
        bytes32 id = _assertMarket(marketParams_);
        if (assets == 0 || assets > type(uint128).max) revert InvalidAmount();
        IERC20(marketParams_.collateralToken)
            .transferFromWithExactDelta(msg.sender, address(this), assets);
        _positions[id][onBehalf].collateral += uint128(assets);
    }

    function borrow(
        IMorphoBlue.MarketParams calldata marketParams_,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external override returns (uint256 assetsBorrowed, uint256 sharesBorrowed) {
        bytes32 id = _assertMarket(marketParams_);
        if (
            !isAuthorized[onBehalf][msg.sender] || assets == 0 || shares != 0
                || assets > type(uint128).max
        ) revert InvalidAmount();
        _positions[id][onBehalf].borrowShares += uint128(assets);
        IERC20(marketParams_.loanToken).safeTransfer(receiver, assets);
        return (assets, assets);
    }

    function _assertMarket(IMorphoBlue.MarketParams calldata marketParams_)
        private
        view
        returns (bytes32 id)
    {
        id = keccak256(abi.encode(marketParams_));
        if (_marketParams[id].loanToken == address(0)) revert InvalidMarket();
    }
}
