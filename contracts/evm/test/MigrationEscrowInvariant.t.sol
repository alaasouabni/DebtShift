// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { MigrationEscrow } from "../src/MigrationEscrow.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";
import { TestToken } from "../src/mocks/TestToken.sol";

interface InvariantVm {
    function warp(uint256 timestamp) external;
}

contract MigrationEscrowHandler {
    struct Model {
        uint256 collateralUnits;
        uint256 loanUnits;
        uint256 supplementaryUnits;
        bytes32 fundingEvidenceHash;
    }

    InvariantVm private constant VM =
        InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 internal constant MIGRATION_ONE = keccak256("invariant-migration-one");
    bytes32 internal constant MIGRATION_TWO = keccak256("invariant-migration-two");

    MigrationEscrow public immutable escrow;
    TestToken public immutable token;
    mapping(bytes32 migrationId => Model model) private _models;

    constructor(MigrationEscrow escrow_, TestToken token_) {
        escrow = escrow_;
        token = token_;
        token.approve(address(escrow_), type(uint256).max);
    }

    function model(bytes32 migrationId) external view returns (Model memory) {
        return _models[migrationId];
    }

    function assignCollateral(uint8 migrationSeed, uint96 rawAmount) external {
        bytes32 migrationId = _migrationId(migrationSeed);
        uint256 amountUnits = _boundedAmount(rawAmount);
        if (amountUnits == 0) return;

        escrow.assign(migrationId, IERC20(address(token)), address(this), amountUnits);
        _models[migrationId].collateralUnits += amountUnits;
    }

    function releaseCollateral(uint8 migrationSeed, uint96 rawAmount) external {
        bytes32 migrationId = _migrationId(migrationSeed);
        Model storage current = _models[migrationId];
        uint256 amountUnits = _boundedExisting(rawAmount, current.collateralUnits);
        if (amountUnits == 0) return;

        escrow.release(migrationId, IERC20(address(token)), address(this), amountUnits);
        current.collateralUnits -= amountUnits;
    }

    function assignLoanProceeds(uint8 migrationSeed, uint96 rawAmount) external {
        bytes32 migrationId = _migrationId(migrationSeed);
        uint256 amountUnits = _boundedAmount(rawAmount);
        if (amountUnits == 0) return;

        escrow.assignLoanProceeds(migrationId, IERC20(address(token)), amountUnits);
        _models[migrationId].loanUnits += amountUnits;
    }

    function secureSupplementaryFunding(uint8 migrationSeed, uint96 rawAmount) external {
        bytes32 migrationId = _migrationId(migrationSeed);
        Model storage current = _models[migrationId];
        MigrationEscrow.FundingRecord memory funding = escrow.fundingRecord(migrationId);
        uint256 amountUnits = _boundedAmount(rawAmount);
        if (funding.status != MigrationEscrow.FundingStatus.NONE || amountUnits == 0) return;

        uint64 deadline = uint64(block.timestamp + 1 days);
        MigrationEscrow.SettlementTerms memory settlement =
            _settlementTerms(migrationId, bytes32(0), amountUnits);
        bytes32 useHash = escrow.computeAuthorizedUseHash(settlement);
        bytes32 evidenceHash = escrow.secureSupplementaryFunding(
            MigrationEscrow.FundingCommitment({
                migrationId: migrationId,
                chainId: block.chainid,
                token: IERC20(address(token)),
                depositor: address(this),
                refundReceiver: address(this),
                amountUnits: amountUnits,
                authorizedUseHash: useHash,
                deadline: deadline
            })
        );
        current.supplementaryUnits = amountUnits;
        current.fundingEvidenceHash = evidenceHash;
    }

    function settleAvailable(uint8 migrationSeed) external {
        bytes32 migrationId = _migrationId(migrationSeed);
        Model storage current = _models[migrationId];
        MigrationEscrow.FundingRecord memory funding = escrow.fundingRecord(migrationId);

        if (funding.status == MigrationEscrow.FundingStatus.LOCKED) {
            if (block.timestamp > funding.deadline) return;
            escrow.settle(
                _settlementTerms(
                    migrationId, current.fundingEvidenceHash, current.supplementaryUnits
                )
            );
            current.loanUnits = 0;
            current.supplementaryUnits = 0;
            return;
        }
        if (funding.status != MigrationEscrow.FundingStatus.NONE || current.loanUnits == 0) return;

        escrow.settle(_settlementTerms(migrationId, bytes32(0), current.loanUnits));
        current.loanUnits = 0;
    }

    function refundSupplementaryFunding(uint8 migrationSeed) external {
        bytes32 migrationId = _migrationId(migrationSeed);
        Model storage current = _models[migrationId];
        MigrationEscrow.FundingRecord memory funding = escrow.fundingRecord(migrationId);
        if (funding.status != MigrationEscrow.FundingStatus.LOCKED) return;
        if (block.timestamp <= funding.deadline) VM.warp(uint256(funding.deadline) + 1);

        escrow.refundSupplementaryFunding(migrationId, current.fundingEvidenceHash);
        current.supplementaryUnits = 0;
    }

    function migrationOne() external pure returns (bytes32) {
        return MIGRATION_ONE;
    }

    function migrationTwo() external pure returns (bytes32) {
        return MIGRATION_TWO;
    }

    function _settlementTerms(
        bytes32 migrationId,
        bytes32 fundingEvidenceHash,
        uint256 solverPrincipalUnits
    ) private view returns (MigrationEscrow.SettlementTerms memory) {
        return MigrationEscrow.SettlementTerms({
            migrationId: migrationId,
            token: IERC20(address(token)),
            fundingEvidenceHash: fundingEvidenceHash,
            solverPayoutReceiver: address(this),
            capitalizedCostReceiver: address(0),
            residualReceiver: address(this),
            solverPrincipalUnits: solverPrincipalUnits,
            solverFeeUnits: 0,
            capitalizedCostUnits: 0
        });
    }

    function _migrationId(uint8 seed) private pure returns (bytes32) {
        return seed % 2 == 0 ? MIGRATION_ONE : MIGRATION_TWO;
    }

    function _boundedAmount(uint96 rawAmount) private view returns (uint256) {
        uint256 available = token.balanceOf(address(this));
        if (available == 0) return 0;
        return (uint256(rawAmount) % available) + 1;
    }

    function _boundedExisting(uint96 rawAmount, uint256 existing) private pure returns (uint256) {
        if (existing == 0) return 0;
        return (uint256(rawAmount) % existing) + 1;
    }
}

contract MigrationEscrowInvariantTest {
    MigrationEscrow internal escrow;
    TestToken internal token;
    MigrationEscrowHandler internal handler;
    bytes32 internal migrationOne;
    bytes32 internal migrationTwo;
    address[] internal targetedContracts;

    function setUp() public {
        token = new TestToken("Invariant Token", "INV", 6, address(this));
        escrow = new MigrationEscrow(address(this));
        handler = new MigrationEscrowHandler(escrow, token);
        migrationOne = handler.migrationOne();
        migrationTwo = handler.migrationTwo();
        escrow.setDepositor(address(handler), true);
        escrow.setOperator(address(handler), true);
        token.mint(address(handler), 1_000_000_000_000);
        targetedContracts.push(address(handler));
    }

    function targetContracts() external view returns (address[] memory) {
        return targetedContracts;
    }

    function invariantEscrowCustodyEqualsAllMigrationCategories() public view {
        uint256 totalOne = _assertMigrationReconciles(migrationOne);
        uint256 totalTwo = _assertMigrationReconciles(migrationTwo);
        require(
            token.balanceOf(address(escrow)) == totalOne + totalTwo,
            "token custody differs from migration accounting"
        );
    }

    function invariantFundingStatusMatchesActiveSupplementaryBalance() public view {
        _assertFundingStatus(migrationOne);
        _assertFundingStatus(migrationTwo);
    }

    function invariantShadowModelNeverCrossConsumesMigrations() public view {
        _assertShadowModel(migrationOne);
        _assertShadowModel(migrationTwo);
    }

    function _assertMigrationReconciles(bytes32 migrationId) private view returns (uint256 total) {
        address tokenAddress = address(token);
        uint256 collateral = escrow.categorizedBalances(
            migrationId, tokenAddress, MigrationEscrow.BalanceKind.TRANSPORTED_COLLATERAL
        );
        uint256 loan = escrow.categorizedBalances(
            migrationId, tokenAddress, MigrationEscrow.BalanceKind.DESTINATION_LOAN_PROCEEDS
        );
        uint256 supplementary = escrow.categorizedBalances(
            migrationId, tokenAddress, MigrationEscrow.BalanceKind.SUPPLEMENTARY_FUNDING
        );
        uint256 repayment = escrow.categorizedBalances(
            migrationId, tokenAddress, MigrationEscrow.BalanceKind.SOLVER_REPAYMENT
        );
        total = collateral + loan + supplementary + repayment;
        require(escrow.balances(migrationId, tokenAddress) == total, "category sum mismatch");
        require(repayment == 0, "transient solver repayment escaped an atomic call");
    }

    function _assertFundingStatus(bytes32 migrationId) private view {
        MigrationEscrow.FundingRecord memory funding = escrow.fundingRecord(migrationId);
        uint256 supplementary = escrow.categorizedBalances(
            migrationId, address(token), MigrationEscrow.BalanceKind.SUPPLEMENTARY_FUNDING
        );
        if (funding.status == MigrationEscrow.FundingStatus.LOCKED) {
            require(supplementary == funding.amountUnits, "locked funding amount mismatch");
        } else {
            require(supplementary == 0, "inactive funding remains spendable");
        }
    }

    function _assertShadowModel(bytes32 migrationId) private view {
        MigrationEscrowHandler.Model memory expected = handler.model(migrationId);
        require(
            escrow.categorizedBalances(
                migrationId, address(token), MigrationEscrow.BalanceKind.TRANSPORTED_COLLATERAL
            ) == expected.collateralUnits,
            "collateral crossed migration boundary"
        );
        require(
            escrow.categorizedBalances(
                migrationId, address(token), MigrationEscrow.BalanceKind.DESTINATION_LOAN_PROCEEDS
            ) == expected.loanUnits,
            "loan proceeds crossed migration boundary"
        );
        require(
            escrow.categorizedBalances(
                migrationId, address(token), MigrationEscrow.BalanceKind.SUPPLEMENTARY_FUNDING
            ) == expected.supplementaryUnits,
            "supplementary funding crossed migration boundary"
        );
    }
}
