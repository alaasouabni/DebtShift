// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library DebtShiftHashing {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant NAME_HASH = keccak256("DebtShift");
    bytes32 internal constant VERSION_HASH = keccak256("1");
    bytes32 internal constant REFINANCE_INTENT_TYPEHASH = keccak256(
        "RefinanceIntent(address borrower,bytes32 sourcePositionId,bytes32 allowedTargetsHash,bytes32 feeAssetHash,uint256 maxSourceDebt,uint256 minSourceCollateral,uint256 maxTotalFee,uint32 maxSlippageBps,uint32 minAprReductionBps,bytes32 safetyPolicyHash,uint32 maxDurationSeconds,uint64 expiration,uint256 nonce)"
    );
    bytes32 internal constant EXECUTION_PLAN_TYPEHASH = keccak256(
        "ExecutionPlan(bytes32 intentHash,bytes32 migrationId,address borrower,bytes32 sourcePositionId,bytes32 routeHash,bytes32 transportQuoteHash,uint256 sourceRepaymentMax,uint256 sourceCollateralMin,uint256 targetDebtMax,uint256 minDestinationCollateral,uint256 principalMax,uint256 feeMax,address destinationReceiver,address refundReceiver,address payoutReceiver,uint64 deadline,uint256 nonce)"
    );

    struct RefinanceIntentHashInput {
        address borrower;
        bytes32 sourcePositionId;
        bytes32 allowedTargetsHash;
        bytes32 feeAssetHash;
        uint256 maxSourceDebt;
        uint256 minSourceCollateral;
        uint256 maxTotalFee;
        uint32 maxSlippageBps;
        uint32 minAprReductionBps;
        bytes32 safetyPolicyHash;
        uint32 maxDurationSeconds;
        uint64 expiration;
        uint256 nonce;
    }

    struct ExecutionPlanHashInput {
        bytes32 intentHash;
        bytes32 migrationId;
        address borrower;
        bytes32 sourcePositionId;
        bytes32 routeHash;
        bytes32 transportQuoteHash;
        uint256 sourceRepaymentMax;
        uint256 sourceCollateralMin;
        uint256 targetDebtMax;
        uint256 minDestinationCollateral;
        uint256 principalMax;
        uint256 feeMax;
        address destinationReceiver;
        address refundReceiver;
        address payoutReceiver;
        uint64 deadline;
        uint256 nonce;
    }

    struct RouteHashInput {
        bytes32 sourcePositionId;
        bytes32 sourceMarketHash;
        bytes32 targetMarketHash;
        bytes32 sourceDebtAssetHash;
        bytes32 sourceCollateralAssetHash;
        bytes32 destinationDebtAssetHash;
        bytes32 destinationCollateralAssetHash;
        uint256 sourceRepaymentMax;
        uint256 sourceCollateralMin;
        uint256 targetDebtMax;
        uint256 minDestinationCollateral;
        bytes32 transportProviderHash;
        bytes32 transportQuoteHash;
        bytes32 transportDepositAddressHash;
        address destinationReceiver;
        address refundReceiver;
        address fundingProvider;
        bytes32 reservationHash;
        bytes32 payoutAssetHash;
        address payoutReceiver;
        uint256 principalMax;
        uint256 feeMax;
        bytes32 financingHash;
        uint64 deadline;
    }

    function protocolId(string memory canonicalProtocolName) internal pure returns (bytes32) {
        return keccak256(bytes(canonicalProtocolName));
    }

    function hashMarketReference(
        uint256 chainId,
        bytes32 protocol,
        address deployment,
        bytes32 marketId
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, protocol, deployment, marketId));
    }

    function hashTokenReference(uint256 chainId, address token, uint8 decimals)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, token, decimals));
    }

    function hashSourcePosition(
        bytes32 marketHash,
        address borrower,
        bytes32 collateralAssetHash,
        bytes32 debtAssetHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(marketHash, borrower, collateralAssetHash, debtAssetHash));
    }

    function hashRoute(RouteHashInput memory input) internal pure returns (bytes32) {
        return keccak256(abi.encode(input));
    }

    function computeMigrationId(bytes32 intentHash, bytes32 transportQuoteHash, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(intentHash, transportQuoteHash, nonce));
    }

    function hashRefinanceIntent(
        RefinanceIntentHashInput memory input,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(REFINANCE_INTENT_TYPEHASH, input));
        return _hashTypedData(structHash, chainId, verifyingContract);
    }

    function hashExecutionPlan(
        ExecutionPlanHashInput memory input,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(EXECUTION_PLAN_TYPEHASH, input));
        return _hashTypedData(structHash, chainId, verifyingContract);
    }

    function _hashTypedData(bytes32 structHash, uint256 chainId, address verifyingContract)
        private
        pure
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, verifyingContract)
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}
