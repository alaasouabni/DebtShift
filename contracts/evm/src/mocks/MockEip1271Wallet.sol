// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC1271 } from "../libraries/SignatureChecker.sol";

contract MockEip1271Wallet is IERC1271 {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;

    error Unauthorized();
    error ExecutionFailed();

    address public immutable owner;
    mapping(bytes32 digest => bool approved) public approvedDigests;

    constructor(address owner_) {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
    }

    function approveDigest(bytes32 digest, bool approved) external {
        if (msg.sender != owner) revert Unauthorized();
        approvedDigests[digest] = approved;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != owner) revert Unauthorized();
        (bool success, bytes memory returned) = target.call(data);
        if (!success) revert ExecutionFailed();
        return returned;
    }

    function isValidSignature(bytes32 hash, bytes calldata)
        external
        view
        returns (bytes4 magicValue)
    {
        return approvedDigests[hash] ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}
