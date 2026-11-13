// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "../src/interfaces/IERC20.sol";
import { SafeToken } from "../src/libraries/SafeToken.sol";

interface SafeTokenVm {
    function expectRevert(bytes calldata revertData) external;
}

contract SafeTokenHarness {
    using SafeToken for IERC20;

    function pull(IERC20 token, address sender, uint256 amount) external {
        token.transferFromWithExactDelta(sender, address(this), amount);
    }

    function push(IERC20 token, address recipient, uint256 amount) external {
        token.transferWithExactDelta(recipient, amount);
    }
}

contract FeeOnTransferToken is IERC20 {
    uint256 public constant FEE_UNITS = 1;

    uint256 public totalSupply;
    mapping(address account => uint256 amount) public override balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public override allowance;

    function mint(address recipient, uint256 amount) external {
        totalSupply += amount;
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
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
        uint256 approved = allowance[sender][msg.sender];
        if (approved != type(uint256).max) allowance[sender][msg.sender] = approved - amount;
        _transfer(sender, recipient, amount);
        return true;
    }

    function _transfer(address sender, address recipient, uint256 amount) private {
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount - FEE_UNITS;
        totalSupply -= FEE_UNITS;
    }
}

    contract SafeTokenTest {
        SafeTokenVm private constant VM =
            SafeTokenVm(address(uint160(uint256(keccak256("hevm cheat code")))));

        SafeTokenHarness private harness;
        FeeOnTransferToken private token;

        function setUp() public {
            harness = new SafeTokenHarness();
            token = new FeeOnTransferToken();
            token.mint(address(this), 1_000);
            token.approve(address(harness), type(uint256).max);
        }

        function testRejectsAndRollsBackFeeOnTransferPull() public {
            VM.expectRevert(
                abi.encodeWithSelector(
                    SafeToken.UnexpectedBalanceDelta.selector, address(token), 100, 99
                )
            );
            harness.pull(IERC20(address(token)), address(this), 100);

            require(token.balanceOf(address(this)) == 1_000, "sender balance changed");
            require(token.balanceOf(address(harness)) == 0, "harness retained taxed input");
            require(token.totalSupply() == 1_000, "fee burn was not rolled back");
        }

        function testRejectsAndRollsBackFeeOnTransferPush() public {
            token.mint(address(harness), 100);

            VM.expectRevert(
                abi.encodeWithSelector(
                    SafeToken.UnexpectedBalanceDelta.selector, address(token), 100, 99
                )
            );
            harness.push(IERC20(address(token)), address(0xB0B), 100);

            require(token.balanceOf(address(harness)) == 100, "harness balance changed");
            require(token.balanceOf(address(0xB0B)) == 0, "recipient retained taxed output");
            require(token.totalSupply() == 1_100, "fee burn was not rolled back");
        }
    }
