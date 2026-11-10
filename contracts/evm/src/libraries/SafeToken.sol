// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../interfaces/IERC20.sol";

library SafeToken {
    error TokenCallFailed(address token, bytes data);
    error UnexpectedBalanceDelta(address token, uint256 expected, uint256 actual);

    function safeTransfer(IERC20 token, address recipient, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20.transfer, (recipient, amount)));
    }

    function safeTransferFrom(IERC20 token, address sender, address recipient, uint256 amount)
        internal
    {
        _call(token, abi.encodeCall(IERC20.transferFrom, (sender, recipient, amount)));
    }

    function forceApprove(IERC20 token, address spender, uint256 amount) internal {
        bytes memory approval = abi.encodeCall(IERC20.approve, (spender, amount));
        (bool success, bytes memory returnData) = address(token).call(approval);
        if (success && (returnData.length == 0 || abi.decode(returnData, (bool)))) return;

        _call(token, abi.encodeCall(IERC20.approve, (spender, 0)));
        _call(token, approval);
    }

    function transferFromWithExactDelta(
        IERC20 token,
        address sender,
        address recipient,
        uint256 amount
    ) internal {
        uint256 beforeBalance = token.balanceOf(recipient);
        safeTransferFrom(token, sender, recipient, amount);
        uint256 delta = token.balanceOf(recipient) - beforeBalance;
        if (delta != amount) revert UnexpectedBalanceDelta(address(token), amount, delta);
    }

    function transferWithExactDelta(IERC20 token, address recipient, uint256 amount) internal {
        uint256 beforeBalance = token.balanceOf(recipient);
        safeTransfer(token, recipient, amount);
        uint256 delta = token.balanceOf(recipient) - beforeBalance;
        if (delta != amount) revert UnexpectedBalanceDelta(address(token), amount, delta);
    }

    function _call(IERC20 token, bytes memory data) private {
        (bool success, bytes memory returnData) = address(token).call(data);
        if (!success || (returnData.length != 0 && !abi.decode(returnData, (bool)))) {
            revert TokenCallFailed(address(token), data);
        }
    }
}
