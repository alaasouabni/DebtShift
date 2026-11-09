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

    address public owner;
    mapping(address account => bool allowed) public depositors;
    mapping(address account => bool allowed) public operators;
    mapping(bytes32 migrationId => mapping(address token => uint256 amount)) public balances;

    event CollateralAssigned(
        bytes32 indexed migrationId,
        address indexed token,
        address indexed depositor,
        uint256 amountUnits
    );
    event BalanceReleased(
        bytes32 indexed migrationId,
        address indexed token,
        address indexed receiver,
        uint256 amountUnits
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

    function setDepositor(address depositor, bool allowed) external onlyOwner {
        depositors[depositor] = allowed;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
    }

    function assign(bytes32 migrationId, IERC20 token, address sender, uint256 amountUnits)
        external
        nonReentrant
    {
        if (!depositors[msg.sender]) revert Unauthorized();
        if (migrationId == bytes32(0) || amountUnits == 0) revert InvalidAssignment();

        token.transferFromWithExactDelta(sender, address(this), amountUnits);
        balances[migrationId][address(token)] += amountUnits;
        emit CollateralAssigned(migrationId, address(token), msg.sender, amountUnits);
    }

    function release(bytes32 migrationId, IERC20 token, address receiver, uint256 amountUnits)
        external
        nonReentrant
    {
        if (!operators[msg.sender]) revert Unauthorized();
        uint256 assigned = balances[migrationId][address(token)];
        if (amountUnits == 0 || assigned < amountUnits) revert InsufficientAssignedBalance();

        balances[migrationId][address(token)] = assigned - amountUnits;
        token.safeTransfer(receiver, amountUnits);
        emit BalanceReleased(migrationId, address(token), receiver, amountUnits);
    }
}
