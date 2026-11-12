// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract MockAaveV3ProtocolDataProvider {
    error UnsupportedAsset();

    address public immutable asset;
    address public immutable aToken;
    address public immutable variableDebtToken;

    constructor(address asset_, address aToken_, address variableDebtToken_) {
        if (asset_ == address(0) || aToken_ == address(0) || variableDebtToken_ == address(0)) {
            revert UnsupportedAsset();
        }
        asset = asset_;
        aToken = aToken_;
        variableDebtToken = variableDebtToken_;
    }

    function getReserveTokensAddresses(address requestedAsset)
        external
        view
        returns (
            address aTokenAddress,
            address stableDebtTokenAddress,
            address variableDebtTokenAddress
        )
    {
        if (requestedAsset != asset) revert UnsupportedAsset();
        return (aToken, address(0), variableDebtToken);
    }
}
