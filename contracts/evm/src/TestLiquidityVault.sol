// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "./interfaces/IERC20.sol";
import { SafeToken } from "./libraries/SafeToken.sol";
import { ReentrancyGuard } from "./security/ReentrancyGuard.sol";

contract TestLiquidityVault is ReentrancyGuard {
    using SafeToken for IERC20;

    error Unauthorized();
    error InvalidReservation();
    error ReservationExists();
    error ReservationExpired();
    error InsufficientFreeLiquidity();
    error FeeMismatch();
    error InvalidFeasibility();
    error StaleFeasibility();
    error FeasibilityMismatch();

    enum ReservationStatus {
        NONE,
        ACTIVE,
        DRAWN,
        SETTLED,
        RELEASED
    }

    struct Reservation {
        IERC20 asset;
        bytes32 planHash;
        bytes32 feasibilityHash;
        uint256 principalUnits;
        uint256 feeCapUnits;
        uint64 expiresAt;
        ReservationStatus status;
        address adapter;
        uint256 receivableUnits;
    }

    struct FeasibilityEvidence {
        bytes32 planHash;
        bytes32 analysisHash;
        bytes32 externalFundingEvidenceHash;
        address liquidityAsset;
        uint256 solverPrincipalUnits;
        uint256 solverFeeUnits;
        uint256 capitalizedCostUnits;
        uint256 totalRequiredUnits;
        uint256 confirmedExternalFundingUnits;
        uint256 maximumSafeBorrowingCapacityUnits;
        uint256 requiredDestinationBorrowUnits;
        uint256 fundingShortfallUnits;
        uint64 sequence;
        uint64 evaluatedAt;
        uint64 validUntil;
    }

    address public owner;
    mapping(address operator => bool allowed) public operators;
    mapping(address verifier => bool allowed) public verifiers;
    mapping(address adapter => bool allowed) public adapters;
    mapping(address asset => bool allowed) public assets;
    mapping(bytes32 migrationId => Reservation reservation) public reservations;
    mapping(bytes32 migrationId => FeasibilityEvidence evidence) private _latestFeasibility;
    mapping(bytes32 migrationId => bytes32 evidenceHash) public latestFeasibilityHash;
    mapping(bytes32 migrationId => uint64 sequence) public latestFeasibilitySequence;
    mapping(address asset => uint256 units) public reservedUndrawn;
    mapping(address asset => uint256 units) public principalReceivable;

    event LiquidityReserved(
        bytes32 indexed migrationId,
        address indexed asset,
        address indexed adapter,
        uint256 principalUnits,
        uint256 feeCapUnits,
        uint64 expiresAt
    );
    event FinancingFeasibilityRecorded(
        bytes32 indexed migrationId,
        bytes32 indexed planHash,
        bytes32 indexed feasibilityHash,
        address verifier,
        uint256 fundingShortfallUnits,
        uint64 sequence,
        uint64 evaluatedAt,
        uint64 validUntil
    );
    event ReservationFeasibilityBound(
        bytes32 indexed migrationId, bytes32 indexed planHash, bytes32 indexed feasibilityHash
    );
    event LiquidityDrawn(bytes32 indexed migrationId, uint256 principalUnits);
    event UnusedLiquidityReturned(bytes32 indexed migrationId, uint256 amountUnits);
    event LiquiditySettled(bytes32 indexed migrationId, uint256 principalUnits, uint256 feeUnits);
    event ReservationReleased(bytes32 indexed migrationId);

    constructor(address owner_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
        operators[owner_] = true;
        verifiers[owner_] = true;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert Unauthorized();
        _;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
    }

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        verifiers[verifier] = allowed;
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        adapters[adapter] = allowed;
    }

    function setAsset(address asset, bool allowed) external onlyOwner {
        assets[asset] = allowed;
    }

    function deposit(IERC20 asset, uint256 amountUnits) external nonReentrant {
        if (!assets[address(asset)] || amountUnits == 0) revert InvalidReservation();
        asset.transferFromWithExactDelta(msg.sender, address(this), amountUnits);
    }

    function freeLiquidity(IERC20 asset) public view returns (uint256) {
        return asset.balanceOf(address(this)) - reservedUndrawn[address(asset)];
    }

    function latestFeasibility(bytes32 migrationId)
        external
        view
        returns (FeasibilityEvidence memory)
    {
        return _latestFeasibility[migrationId];
    }

    function recordFeasibility(bytes32 migrationId, FeasibilityEvidence calldata evidence)
        external
        returns (bytes32 feasibilityHash)
    {
        if (!verifiers[msg.sender]) revert Unauthorized();
        _validateFeasibilityShape(migrationId, evidence);

        FeasibilityEvidence storage current = _latestFeasibility[migrationId];
        feasibilityHash = keccak256(abi.encode(migrationId, evidence));
        if (current.evaluatedAt != 0) {
            if (evidence.sequence == current.sequence) {
                if (latestFeasibilityHash[migrationId] != feasibilityHash) {
                    revert StaleFeasibility();
                }
                return feasibilityHash;
            }
            if (
                evidence.sequence != current.sequence + 1
                    || evidence.evaluatedAt < current.evaluatedAt
            ) revert StaleFeasibility();
        } else if (evidence.sequence != 1) {
            revert StaleFeasibility();
        }

        _latestFeasibility[migrationId] = evidence;
        latestFeasibilityHash[migrationId] = feasibilityHash;
        latestFeasibilitySequence[migrationId] = evidence.sequence;
        emit FinancingFeasibilityRecorded(
            migrationId,
            evidence.planHash,
            feasibilityHash,
            msg.sender,
            evidence.fundingShortfallUnits,
            evidence.sequence,
            evidence.evaluatedAt,
            evidence.validUntil
        );
    }

    function reserve(
        bytes32 migrationId,
        IERC20 asset,
        address adapter,
        bytes32 planHash,
        bytes32 feasibilityHash,
        uint256 principalUnits,
        uint256 feeCapUnits,
        uint64 expiresAt
    ) external onlyOperator {
        if (
            migrationId == bytes32(0) || !assets[address(asset)] || !adapters[adapter]
                || principalUnits == 0 || expiresAt <= block.timestamp
        ) revert InvalidReservation();
        if (reservations[migrationId].status != ReservationStatus.NONE) {
            revert ReservationExists();
        }
        _assertCurrentFeasibility(
            migrationId, asset, planHash, feasibilityHash, principalUnits, feeCapUnits, expiresAt
        );
        if (freeLiquidity(asset) < principalUnits) revert InsufficientFreeLiquidity();

        reservedUndrawn[address(asset)] += principalUnits;
        reservations[migrationId] = Reservation({
            asset: asset,
            planHash: planHash,
            feasibilityHash: feasibilityHash,
            principalUnits: principalUnits,
            feeCapUnits: feeCapUnits,
            expiresAt: expiresAt,
            status: ReservationStatus.ACTIVE,
            adapter: adapter,
            receivableUnits: 0
        });
        emit LiquidityReserved(
            migrationId, address(asset), adapter, principalUnits, feeCapUnits, expiresAt
        );
        emit ReservationFeasibilityBound(migrationId, planHash, feasibilityHash);
    }

    function assertExecutable(bytes32 migrationId, bytes32 planHash) external view {
        Reservation storage reservation = reservations[migrationId];
        if (
            reservation.status != ReservationStatus.ACTIVE || reservation.planHash != planHash
                || block.timestamp > reservation.expiresAt
        ) revert FeasibilityMismatch();
        _assertLatestPassingFeasibility(migrationId, reservation);
    }

    function draw(bytes32 migrationId, address receiver) external nonReentrant returns (uint256) {
        Reservation storage reservation = reservations[migrationId];
        if (reservation.status != ReservationStatus.ACTIVE || msg.sender != reservation.adapter) {
            revert Unauthorized();
        }
        if (block.timestamp > reservation.expiresAt) revert ReservationExpired();

        reservation.status = ReservationStatus.DRAWN;
        reservation.receivableUnits = reservation.principalUnits;
        reservedUndrawn[address(reservation.asset)] -= reservation.principalUnits;
        principalReceivable[address(reservation.asset)] += reservation.principalUnits;
        reservation.asset.safeTransfer(receiver, reservation.principalUnits);
        emit LiquidityDrawn(migrationId, reservation.principalUnits);
        return reservation.principalUnits;
    }

    function returnUnused(bytes32 migrationId, uint256 amountUnits) external nonReentrant {
        Reservation storage reservation = reservations[migrationId];
        if (
            reservation.status != ReservationStatus.DRAWN || msg.sender != reservation.adapter
                || amountUnits == 0 || amountUnits >= reservation.receivableUnits
        ) revert InvalidReservation();

        reservation.asset.transferFromWithExactDelta(msg.sender, address(this), amountUnits);
        reservation.receivableUnits -= amountUnits;
        principalReceivable[address(reservation.asset)] -= amountUnits;
        emit UnusedLiquidityReturned(migrationId, amountUnits);
    }

    function settle(bytes32 migrationId, address payer, uint256 feeUnits)
        external
        onlyOperator
        nonReentrant
    {
        Reservation storage reservation = reservations[migrationId];
        if (reservation.status != ReservationStatus.DRAWN) revert InvalidReservation();
        if (feeUnits != reservation.feeCapUnits) revert FeeMismatch();
        _assertLatestPassingFeasibility(migrationId, reservation);

        uint256 principalUnits = reservation.receivableUnits;
        reservation.asset
            .transferFromWithExactDelta(payer, address(this), principalUnits + feeUnits);
        principalReceivable[address(reservation.asset)] -= principalUnits;
        reservation.status = ReservationStatus.SETTLED;
        emit LiquiditySettled(migrationId, principalUnits, feeUnits);
    }

    function release(bytes32 migrationId) external onlyOperator {
        Reservation storage reservation = reservations[migrationId];
        if (reservation.status != ReservationStatus.ACTIVE) revert InvalidReservation();
        reservedUndrawn[address(reservation.asset)] -= reservation.principalUnits;
        reservation.status = ReservationStatus.RELEASED;
        emit ReservationReleased(migrationId);
    }

    function _validateFeasibilityShape(bytes32 migrationId, FeasibilityEvidence calldata evidence)
        private
        view
    {
        if (
            migrationId == bytes32(0) || evidence.planHash == bytes32(0)
                || evidence.analysisHash == bytes32(0) || evidence.liquidityAsset == address(0)
                || evidence.solverPrincipalUnits == 0 || evidence.sequence == 0
                || evidence.evaluatedAt > block.timestamp
                || evidence.validUntil < evidence.evaluatedAt
                || (evidence.confirmedExternalFundingUnits == 0
                    && evidence.externalFundingEvidenceHash != bytes32(0))
                || (evidence.confirmedExternalFundingUnits != 0
                    && evidence.externalFundingEvidenceHash == bytes32(0))
        ) revert InvalidFeasibility();

        uint256 totalRequired =
            evidence.solverPrincipalUnits + evidence.solverFeeUnits + evidence.capitalizedCostUnits;
        uint256 requiredBorrow = totalRequired > evidence.confirmedExternalFundingUnits
            ? totalRequired - evidence.confirmedExternalFundingUnits
            : 0;
        uint256 totalAvailable =
            evidence.maximumSafeBorrowingCapacityUnits + evidence.confirmedExternalFundingUnits;
        uint256 shortfall = totalRequired > totalAvailable ? totalRequired - totalAvailable : 0;
        if (
            evidence.totalRequiredUnits != totalRequired
                || evidence.requiredDestinationBorrowUnits != requiredBorrow
                || evidence.fundingShortfallUnits != shortfall
        ) revert InvalidFeasibility();
    }

    function _assertCurrentFeasibility(
        bytes32 migrationId,
        IERC20 asset,
        bytes32 planHash,
        bytes32 feasibilityHash,
        uint256 principalUnits,
        uint256 feeCapUnits,
        uint64 expiresAt
    ) private view {
        FeasibilityEvidence storage evidence = _latestFeasibility[migrationId];
        if (
            latestFeasibilityHash[migrationId] != feasibilityHash || evidence.planHash != planHash
                || evidence.liquidityAsset != address(asset)
                || evidence.solverPrincipalUnits != principalUnits
                || evidence.solverFeeUnits != feeCapUnits || evidence.fundingShortfallUnits != 0
                || evidence.requiredDestinationBorrowUnits
                    > evidence.maximumSafeBorrowingCapacityUnits || evidence.validUntil < expiresAt
                || block.timestamp > evidence.validUntil
        ) revert FeasibilityMismatch();
    }

    function _assertLatestPassingFeasibility(bytes32 migrationId, Reservation storage reservation)
        private
        view
    {
        FeasibilityEvidence storage evidence = _latestFeasibility[migrationId];
        if (
            evidence.planHash != reservation.planHash
                || evidence.liquidityAsset != address(reservation.asset)
                || evidence.solverPrincipalUnits != reservation.principalUnits
                || evidence.solverFeeUnits != reservation.feeCapUnits
                || evidence.fundingShortfallUnits != 0
                || evidence.requiredDestinationBorrowUnits
                    > evidence.maximumSafeBorrowingCapacityUnits
                || block.timestamp > evidence.validUntil
        ) revert FeasibilityMismatch();
    }
}
