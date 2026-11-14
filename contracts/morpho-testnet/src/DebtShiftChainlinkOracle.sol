// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

interface IChainlinkFeed {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @notice Testnet-only Morpho oracle backed by two configured Chainlink feeds.
/// @dev The returned value is loan-token base units per collateral-token base
/// unit, scaled by Morpho's required 1e36. Production mainnet uses the oracle
/// already registered by the allowlisted Morpho market instead of this contract.
contract DebtShiftChainlinkOracle {
    error InvalidConfiguration();
    error InvalidPrice();
    error StalePrice();
    error SequencerUnavailable();
    error SequencerGracePeriod();

    IChainlinkFeed public immutable COLLATERAL_FEED;
    IChainlinkFeed public immutable LOAN_FEED;
    IChainlinkFeed public immutable SEQUENCER_UPTIME_FEED;
    uint256 public immutable COLLATERAL_MAX_PRICE_AGE;
    uint256 public immutable LOAN_MAX_PRICE_AGE;
    uint256 public immutable SEQUENCER_GRACE_PERIOD;
    uint256 public immutable SCALE_FACTOR;

    constructor(
        address collateralToken,
        address loanToken,
        IChainlinkFeed collateralFeed,
        IChainlinkFeed loanFeed,
        IChainlinkFeed sequencerUptimeFeed,
        uint256 collateralMaxPriceAge,
        uint256 loanMaxPriceAge,
        uint256 sequencerGracePeriod
    ) {
        if (
            collateralToken.code.length == 0 || loanToken.code.length == 0
                || address(collateralFeed).code.length == 0 || address(loanFeed).code.length == 0
                || collateralMaxPriceAge == 0 || loanMaxPriceAge == 0
        ) revert InvalidConfiguration();
        if (
            address(sequencerUptimeFeed) == address(0) && sequencerGracePeriod != 0
                || address(sequencerUptimeFeed) != address(0)
                && (address(sequencerUptimeFeed).code.length == 0 || sequencerGracePeriod == 0)
        ) revert InvalidConfiguration();

        uint256 collateralDecimals = IERC20Metadata(collateralToken).decimals();
        uint256 loanDecimals = IERC20Metadata(loanToken).decimals();
        uint256 collateralFeedDecimals = collateralFeed.decimals();
        uint256 loanFeedDecimals = loanFeed.decimals();
        uint256 scaleExponent = 36 + loanDecimals + loanFeedDecimals;
        uint256 scaleReduction = collateralDecimals + collateralFeedDecimals;
        if (scaleExponent < scaleReduction || scaleExponent - scaleReduction > 36) {
            revert InvalidConfiguration();
        }

        COLLATERAL_FEED = collateralFeed;
        LOAN_FEED = loanFeed;
        SEQUENCER_UPTIME_FEED = sequencerUptimeFeed;
        COLLATERAL_MAX_PRICE_AGE = collateralMaxPriceAge;
        LOAN_MAX_PRICE_AGE = loanMaxPriceAge;
        SEQUENCER_GRACE_PERIOD = sequencerGracePeriod;
        SCALE_FACTOR = 10 ** (scaleExponent - scaleReduction);
    }

    function price() external view returns (uint256) {
        _assertSequencerReady();
        uint256 collateralPrice = _readFeed(COLLATERAL_FEED, COLLATERAL_MAX_PRICE_AGE);
        uint256 loanPrice = _readFeed(LOAN_FEED, LOAN_MAX_PRICE_AGE);
        return collateralPrice * SCALE_FACTOR / loanPrice;
    }

    function _readFeed(IChainlinkFeed feed, uint256 maximumAge) private view returns (uint256) {
        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed.latestRoundData();
        if (
            answer <= 0 || startedAt == 0 || startedAt > updatedAt || updatedAt == 0
                || answeredInRound < roundId
        ) revert InvalidPrice();
        // Block time is the canonical reference for Chainlink heartbeat age.
        // forge-lint: disable-next-line(block-timestamp)
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maximumAge) {
            revert StalePrice();
        }
        // The positivity check above makes this conversion lossless.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(answer);
    }

    function _assertSequencerReady() private view {
        if (address(SEQUENCER_UPTIME_FEED) == address(0)) return;
        (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = SEQUENCER_UPTIME_FEED.latestRoundData();
        if (
            answer != 0 || startedAt == 0 || updatedAt == 0 || startedAt > updatedAt
                || answeredInRound < roundId
        ) {
            revert SequencerUnavailable();
        }
        // Block time is the canonical reference for the uptime-feed grace period.
        // forge-lint: disable-next-line(block-timestamp)
        if (updatedAt > block.timestamp) revert SequencerUnavailable();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) {
            revert SequencerGracePeriod();
        }
    }
}
