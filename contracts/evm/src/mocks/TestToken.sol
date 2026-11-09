// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../interfaces/IERC20.sol";

contract TestToken is IERC20 {
    error Unauthorized();
    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidReceiver();

    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    address public owner;
    mapping(address account => bool allowed) public minters;
    mapping(address account => uint256 amount) public override balanceOf;
    mapping(address tokenOwner => mapping(address spender => uint256 amount))
        public
        override allowance;

    event Transfer(address indexed sender, address indexed recipient, uint256 amount);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 amount);
    event MinterUpdated(address indexed minter, bool allowed);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_) {
        if (owner_ == address(0)) revert InvalidReceiver();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        owner = owner_;
        minters[owner_] = true;
    }

    function setMinter(address minter, bool allowed) external {
        if (msg.sender != owner) revert Unauthorized();
        minters[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    function mint(address recipient, uint256 amount) external {
        if (!minters[msg.sender]) revert Unauthorized();
        if (recipient == address(0)) revert InvalidReceiver();
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function burn(uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        override
        returns (bool)
    {
        uint256 currentAllowance = allowance[sender][msg.sender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < amount) revert InsufficientAllowance();
            allowance[sender][msg.sender] = currentAllowance - amount;
            emit Approval(sender, msg.sender, allowance[sender][msg.sender]);
        }
        _transfer(sender, recipient, amount);
        return true;
    }

    function _transfer(address sender, address recipient, uint256 amount) private {
        if (recipient == address(0)) revert InvalidReceiver();
        if (balanceOf[sender] < amount) revert InsufficientBalance();
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(sender, recipient, amount);
    }
}
