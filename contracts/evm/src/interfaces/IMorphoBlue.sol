// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IMorphoBlue {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Authorization {
        address authorizer;
        address authorized;
        bool isAuthorized;
        uint256 nonce;
        uint256 deadline;
    }

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function isAuthorized(address authorizer, address authorized) external view returns (bool);

    function nonce(address authorizer) external view returns (uint256);

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function setAuthorizationWithSig(
        Authorization calldata authorization,
        Signature calldata signature
    ) external;

    function supplyCollateral(
        MarketParams calldata marketParams,
        uint256 assets,
        address onBehalf,
        bytes calldata data
    ) external;

    function borrow(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);
}
