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
    error FeeCapExceeded();

    enum ReservationStatus {
        NONE,
        ACTIVE,
        DRAWN,
        SETTLED,
        RELEASED
    }

    struct Reservation {
        IERC20 asset;
        uint256 principalUnits;
        uint256 feeCapUnits;
        uint64 expiresAt;
        ReservationStatus status;
        address adapter;
    }

    address public owner;
    mapping(address operator => bool allowed) public operators;
    mapping(address adapter => bool allowed) public adapters;
    mapping(address asset => bool allowed) public assets;
    mapping(bytes32 migrationId => Reservation reservation) public reservations;
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
    event LiquidityDrawn(bytes32 indexed migrationId, uint256 principalUnits);
    event UnusedLiquidityReturned(bytes32 indexed migrationId, uint256 amountUnits);
    event LiquiditySettled(bytes32 indexed migrationId, uint256 principalUnits, uint256 feeUnits);
    event ReservationReleased(bytes32 indexed migrationId);

    constructor(address owner_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
        operators[owner_] = true;
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

    function reserve(
        bytes32 migrationId,
        IERC20 asset,
        address adapter,
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
        if (freeLiquidity(asset) < principalUnits) revert InsufficientFreeLiquidity();

        reservedUndrawn[address(asset)] += principalUnits;
        reservations[migrationId] = Reservation({
            asset: asset,
            principalUnits: principalUnits,
            feeCapUnits: feeCapUnits,
            expiresAt: expiresAt,
            status: ReservationStatus.ACTIVE,
            adapter: adapter
        });
        emit LiquidityReserved(
            migrationId, address(asset), adapter, principalUnits, feeCapUnits, expiresAt
        );
    }

    function draw(bytes32 migrationId, address receiver) external nonReentrant returns (uint256) {
        Reservation storage reservation = reservations[migrationId];
        if (reservation.status != ReservationStatus.ACTIVE || msg.sender != reservation.adapter) {
            revert Unauthorized();
        }
        if (block.timestamp > reservation.expiresAt) revert ReservationExpired();

        reservation.status = ReservationStatus.DRAWN;
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
                || amountUnits == 0 || amountUnits >= reservation.principalUnits
        ) revert InvalidReservation();

        reservation.asset.transferFromWithExactDelta(msg.sender, address(this), amountUnits);
        reservation.principalUnits -= amountUnits;
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
        if (feeUnits > reservation.feeCapUnits) revert FeeCapExceeded();

        uint256 principalUnits = reservation.principalUnits;
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
}
