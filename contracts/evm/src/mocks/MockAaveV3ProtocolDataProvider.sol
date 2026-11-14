// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract MockAaveV3ProtocolDataProvider {
    error UnsupportedAsset();

    address public immutable collateralAsset;
    address public immutable collateralAToken;
    address public immutable collateralVariableDebtToken;
    address public immutable debtAsset;
    address public immutable debtAToken;
    address public immutable debtVariableDebtToken;

    constructor(
        address collateralAsset_,
        address collateralAToken_,
        address collateralVariableDebtToken_,
        address debtAsset_,
        address debtAToken_,
        address debtVariableDebtToken_
    ) {
        if (
            collateralAsset_ == address(0) || collateralAToken_ == address(0)
                || collateralVariableDebtToken_ == address(0) || debtAsset_ == address(0)
                || debtAToken_ == address(0) || debtVariableDebtToken_ == address(0)
                || collateralAsset_ == debtAsset_
        ) {
            revert UnsupportedAsset();
        }
        collateralAsset = collateralAsset_;
        collateralAToken = collateralAToken_;
        collateralVariableDebtToken = collateralVariableDebtToken_;
        debtAsset = debtAsset_;
        debtAToken = debtAToken_;
        debtVariableDebtToken = debtVariableDebtToken_;
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
        if (requestedAsset == collateralAsset) {
            return (collateralAToken, address(0), collateralVariableDebtToken);
        }
        if (requestedAsset == debtAsset) {
            return (debtAToken, address(0), debtVariableDebtToken);
        }
        revert UnsupportedAsset();
    }
}
