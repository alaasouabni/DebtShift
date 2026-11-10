// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

contract MigrationEscrow is ReentrancyGuard {
    using SafeToken for IERC20;

    error Unauthorized();
    error InvalidAssignment();
    error InsufficientAssignedBalance();
    error FundingAlreadyExists();
    error InvalidFundingCommitment();
    error FundingCommitmentMismatch();
    error FundingNotRefundable();
    error InvalidSettlement();

    enum BalanceKind {
        TRANSPORTED_COLLATERAL,
        DESTINATION_LOAN_PROCEEDS,
        SUPPLEMENTARY_FUNDING,
        SOLVER_REPAYMENT
    }

    enum FundingStatus {
        NONE,
        LOCKED,
        SPENT,
        REFUNDED
    }

    struct FundingCommitment {
        bytes32 migrationId;
        uint256 chainId;
        IERC20 token;
        address depositor;
        address refundReceiver;
        uint256 amountUnits;
        bytes32 authorizedUseHash;
        uint64 deadline;
    }

    struct FundingRecord {
        bytes32 evidenceHash;
        uint256 chainId;
        IERC20 token;
        address depositor;
        address refundReceiver;
        uint256 amountUnits;
        bytes32 authorizedUseHash;
        uint64 deadline;
        FundingStatus status;
    }

    struct SettlementTerms {
        bytes32 migrationId;
        IERC20 token;
        bytes32 fundingEvidenceHash;
        address solverPayoutReceiver;
        address capitalizedCostReceiver;
        address residualReceiver;
        uint256 solverPrincipalUnits;
        uint256 solverFeeUnits;
        uint256 capitalizedCostUnits;
    }

    address public owner;
    mapping(address account => bool allowed) public depositors;
    mapping(address account => bool allowed) public operators;
    mapping(bytes32 migrationId => mapping(address token => uint256 amount)) public balances;
    mapping(
        bytes32 migrationId => mapping(address token => mapping(BalanceKind kind => uint256 amount))
    ) public categorizedBalances;
    mapping(bytes32 migrationId => FundingRecord record) private _fundingRecords;

    event CollateralAssigned(
        bytes32 indexed migrationId,
        address indexed token,
        address indexed depositor,
        uint256 amountUnits
    );
    event BalanceCategoryAssigned(
        bytes32 indexed migrationId,
        address indexed token,
        BalanceKind indexed kind,
        address sender,
        uint256 amountUnits
    );
    event BalanceReleased(
        bytes32 indexed migrationId,
        address indexed token,
        address indexed receiver,
        uint256 amountUnits
    );
    event SupplementaryFundingSecured(
        bytes32 indexed migrationId,
        address indexed token,
        bytes32 indexed evidenceHash,
        address depositor,
        address refundReceiver,
        uint256 amountUnits,
        bytes32 authorizedUseHash,
        uint64 deadline
    );
    event SupplementaryFundingRefunded(
        bytes32 indexed migrationId,
        address indexed token,
        bytes32 indexed evidenceHash,
        address refundReceiver,
        uint256 amountUnits
    );
    event SettlementReleased(
        bytes32 indexed migrationId,
        address indexed token,
        address indexed solverPayoutReceiver,
        uint256 solverPrincipalUnits,
        uint256 solverFeeUnits,
        uint256 capitalizedCostUnits,
        uint256 residualUnits,
        bytes32 fundingEvidenceHash
    );

    constructor(address owner_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
        operators[owner_] = true;
        depositors[owner_] = true;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert Unauthorized();
        _;
    }

    function setDepositor(address depositor, bool allowed) external onlyOwner {
        depositors[depositor] = allowed;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
    }

    function fundingRecord(bytes32 migrationId) external view returns (FundingRecord memory) {
        return _fundingRecords[migrationId];
    }

    function computeFundingEvidenceHash(FundingCommitment calldata commitment)
        external
        view
        returns (bytes32)
    {
        return _fundingEvidenceHash(commitment);
    }

    function computeAuthorizedUseHash(SettlementTerms calldata terms)
        external
        pure
        returns (bytes32)
    {
        return _authorizedUseHash(terms);
    }

    function assign(bytes32 migrationId, IERC20 token, address sender, uint256 amountUnits)
        external
        nonReentrant
    {
        if (!depositors[msg.sender]) revert Unauthorized();
        _validateAssignment(migrationId, token, sender, amountUnits);

        token.transferFromWithExactDelta(sender, address(this), amountUnits);
        _credit(migrationId, token, BalanceKind.TRANSPORTED_COLLATERAL, amountUnits);
        emit CollateralAssigned(migrationId, address(token), msg.sender, amountUnits);
        emit BalanceCategoryAssigned(
            migrationId, address(token), BalanceKind.TRANSPORTED_COLLATERAL, sender, amountUnits
        );
    }

    function assignLoanProceeds(bytes32 migrationId, IERC20 token, uint256 amountUnits)
        external
        onlyOperator
        nonReentrant
    {
        _validateAssignment(migrationId, token, msg.sender, amountUnits);
        token.transferFromWithExactDelta(msg.sender, address(this), amountUnits);
        _credit(migrationId, token, BalanceKind.DESTINATION_LOAN_PROCEEDS, amountUnits);
        emit BalanceCategoryAssigned(
            migrationId,
            address(token),
            BalanceKind.DESTINATION_LOAN_PROCEEDS,
            msg.sender,
            amountUnits
        );
    }

    function secureSupplementaryFunding(FundingCommitment calldata commitment)
        external
        nonReentrant
        returns (bytes32 evidenceHash)
    {
        if (
            commitment.migrationId == bytes32(0) || commitment.chainId != block.chainid
                || address(commitment.token) == address(0) || commitment.depositor != msg.sender
                || commitment.refundReceiver == address(0) || commitment.amountUnits == 0
                || commitment.authorizedUseHash == bytes32(0)
                || commitment.deadline <= block.timestamp
        ) revert InvalidFundingCommitment();
        if (_fundingRecords[commitment.migrationId].status != FundingStatus.NONE) {
            revert FundingAlreadyExists();
        }

        evidenceHash = _fundingEvidenceHash(commitment);
        commitment.token
            .transferFromWithExactDelta(commitment.depositor, address(this), commitment.amountUnits);
        _credit(
            commitment.migrationId,
            commitment.token,
            BalanceKind.SUPPLEMENTARY_FUNDING,
            commitment.amountUnits
        );
        _fundingRecords[commitment.migrationId] = FundingRecord({
            evidenceHash: evidenceHash,
            chainId: commitment.chainId,
            token: commitment.token,
            depositor: commitment.depositor,
            refundReceiver: commitment.refundReceiver,
            amountUnits: commitment.amountUnits,
            authorizedUseHash: commitment.authorizedUseHash,
            deadline: commitment.deadline,
            status: FundingStatus.LOCKED
        });

        emit SupplementaryFundingSecured(
            commitment.migrationId,
            address(commitment.token),
            evidenceHash,
            commitment.depositor,
            commitment.refundReceiver,
            commitment.amountUnits,
            commitment.authorizedUseHash,
            commitment.deadline
        );
        emit BalanceCategoryAssigned(
            commitment.migrationId,
            address(commitment.token),
            BalanceKind.SUPPLEMENTARY_FUNDING,
            commitment.depositor,
            commitment.amountUnits
        );
    }

    function release(bytes32 migrationId, IERC20 token, address receiver, uint256 amountUnits)
        external
        onlyOperator
        nonReentrant
    {
        if (receiver == address(0)) revert InvalidAssignment();
        _debit(migrationId, token, BalanceKind.TRANSPORTED_COLLATERAL, amountUnits);
        token.transferWithExactDelta(receiver, amountUnits);
        emit BalanceReleased(migrationId, address(token), receiver, amountUnits);
    }

    function settle(SettlementTerms calldata terms) external onlyOperator nonReentrant {
        if (
            terms.migrationId == bytes32(0) || address(terms.token) == address(0)
                || terms.solverPayoutReceiver == address(0) || terms.residualReceiver == address(0)
                || terms.solverPrincipalUnits == 0
                || (terms.capitalizedCostUnits == 0 && terms.capitalizedCostReceiver != address(0))
                || (terms.capitalizedCostUnits != 0 && terms.capitalizedCostReceiver == address(0))
        ) revert InvalidSettlement();

        bytes32 useHash = _authorizedUseHash(terms);
        uint256 loanProceeds = categorizedBalances[
            terms.migrationId
        ][address(terms.token)][BalanceKind.DESTINATION_LOAN_PROCEEDS];
        uint256 supplementary = _consumeSupplementaryFunding(terms, useHash);
        uint256 obligation =
            terms.solverPrincipalUnits + terms.solverFeeUnits + terms.capitalizedCostUnits;
        uint256 available = loanProceeds + supplementary;
        if (available < obligation) revert InvalidSettlement();

        if (loanProceeds != 0) {
            _debit(
                terms.migrationId, terms.token, BalanceKind.DESTINATION_LOAN_PROCEEDS, loanProceeds
            );
        }
        categorizedBalances[terms.migrationId][address(terms.token)][BalanceKind.SOLVER_REPAYMENT] =
            terms.solverPrincipalUnits + terms.solverFeeUnits;

        terms.token
            .transferWithExactDelta(
                terms.solverPayoutReceiver, terms.solverPrincipalUnits + terms.solverFeeUnits
            );
        categorizedBalances[
            terms.migrationId
        ][address(terms.token)][BalanceKind.SOLVER_REPAYMENT] = 0;
        if (terms.capitalizedCostUnits != 0) {
            terms.token
                .transferWithExactDelta(terms.capitalizedCostReceiver, terms.capitalizedCostUnits);
        }
        uint256 residual = available - obligation;
        if (residual != 0) {
            terms.token.transferWithExactDelta(terms.residualReceiver, residual);
        }

        emit SettlementReleased(
            terms.migrationId,
            address(terms.token),
            terms.solverPayoutReceiver,
            terms.solverPrincipalUnits,
            terms.solverFeeUnits,
            terms.capitalizedCostUnits,
            residual,
            terms.fundingEvidenceHash
        );
    }

    function refundSupplementaryFunding(bytes32 migrationId, bytes32 evidenceHash)
        external
        nonReentrant
    {
        FundingRecord storage record = _fundingRecords[migrationId];
        if (
            record.status != FundingStatus.LOCKED || record.evidenceHash != evidenceHash
                || block.timestamp <= record.deadline
        ) revert FundingNotRefundable();

        record.status = FundingStatus.REFUNDED;
        _debit(migrationId, record.token, BalanceKind.SUPPLEMENTARY_FUNDING, record.amountUnits);
        record.token.transferWithExactDelta(record.refundReceiver, record.amountUnits);
        emit SupplementaryFundingRefunded(
            migrationId,
            address(record.token),
            evidenceHash,
            record.refundReceiver,
            record.amountUnits
        );
    }

    function _consumeSupplementaryFunding(SettlementTerms calldata terms, bytes32 useHash)
        private
        returns (uint256 amountUnits)
    {
        FundingRecord storage record = _fundingRecords[terms.migrationId];
        if (terms.fundingEvidenceHash == bytes32(0)) {
            if (
                record.status != FundingStatus.NONE
                    || categorizedBalances[
                            terms.migrationId
                        ][address(terms.token)][BalanceKind.SUPPLEMENTARY_FUNDING] != 0
            ) revert FundingCommitmentMismatch();
            return 0;
        }
        if (
            record.status != FundingStatus.LOCKED
                || record.evidenceHash != terms.fundingEvidenceHash
                || address(record.token) != address(terms.token)
                || record.authorizedUseHash != useHash || block.timestamp > record.deadline
        ) revert FundingCommitmentMismatch();

        amountUnits = record.amountUnits;
        record.status = FundingStatus.SPENT;
        _debit(terms.migrationId, terms.token, BalanceKind.SUPPLEMENTARY_FUNDING, amountUnits);
    }

    function _credit(bytes32 migrationId, IERC20 token, BalanceKind kind, uint256 amountUnits)
        private
    {
        balances[migrationId][address(token)] += amountUnits;
        categorizedBalances[migrationId][address(token)][kind] += amountUnits;
    }

    function _debit(bytes32 migrationId, IERC20 token, BalanceKind kind, uint256 amountUnits)
        private
    {
        uint256 categorized = categorizedBalances[migrationId][address(token)][kind];
        if (amountUnits == 0 || categorized < amountUnits) {
            revert InsufficientAssignedBalance();
        }
        categorizedBalances[migrationId][address(token)][kind] = categorized - amountUnits;
        balances[migrationId][address(token)] -= amountUnits;
    }

    function _validateAssignment(
        bytes32 migrationId,
        IERC20 token,
        address sender,
        uint256 amountUnits
    ) private pure {
        if (
            migrationId == bytes32(0) || address(token) == address(0) || sender == address(0)
                || amountUnits == 0
        ) revert InvalidAssignment();
    }

    function _fundingEvidenceHash(FundingCommitment calldata commitment)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                address(this),
                commitment.migrationId,
                commitment.chainId,
                commitment.token,
                commitment.depositor,
                commitment.refundReceiver,
                commitment.amountUnits,
                commitment.authorizedUseHash,
                commitment.deadline
            )
        );
    }

    function _authorizedUseHash(SettlementTerms calldata terms) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                terms.migrationId,
                terms.token,
                terms.solverPayoutReceiver,
                terms.capitalizedCostReceiver,
                terms.residualReceiver,
                terms.solverPrincipalUnits,
                terms.solverFeeUnits,
                terms.capitalizedCostUnits
            )
        );
    }
}
