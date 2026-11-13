// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { MigrationEscrow } from "../src/MigrationEscrow.sol";
import { IERC20 } from "../src/interfaces/IERC20.sol";
import { TestToken } from "../src/mocks/TestToken.sol";

interface InboundVm {
    function expectRevert(bytes4 selector) external;
}

contract MigrationEscrowInboundTest {
    InboundVm private constant VM =
        InboundVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant MIGRATION_ID = keccak256("inbound-migration");
    bytes32 private constant EVIDENCE_HASH = keccak256("one-click-status-response");

    MigrationEscrow private escrow;
    TestToken private token;

    function setUp() public {
        escrow = new MigrationEscrow(address(this));
        token = new TestToken("Collateral", "COL", 18, address(this));
    }

    function testRegistersOnlyActuallyDeliveredUnaccountedTokens() public {
        token.mint(address(escrow), 10 ether);
        escrow.registerTransportInbound(
            MIGRATION_ID, IERC20(address(token)), 9 ether, EVIDENCE_HASH
        );

        require(escrow.balances(MIGRATION_ID, address(token)) == 9 ether, "migration balance");
        require(escrow.accountedBalances(address(token)) == 9 ether, "accounted balance");
        require(escrow.consumedInboundEvidence(EVIDENCE_HASH), "evidence consumption");

        VM.expectRevert(MigrationEscrow.InboundEvidenceAlreadyConsumed.selector);
        escrow.registerTransportInbound(
            MIGRATION_ID, IERC20(address(token)), 1 ether, EVIDENCE_HASH
        );
    }

    function testRejectsRegistrationWithoutDeliveredCustody() public {
        VM.expectRevert(MigrationEscrow.UnfundedInboundAssignment.selector);
        escrow.registerTransportInbound(MIGRATION_ID, IERC20(address(token)), 1, EVIDENCE_HASH);
    }

    function testAccountedBalanceTracksReleaseWithoutConsumingUnassignedDust() public {
        token.mint(address(escrow), 12 ether);
        escrow.registerTransportInbound(
            MIGRATION_ID, IERC20(address(token)), 10 ether, EVIDENCE_HASH
        );
        escrow.release(MIGRATION_ID, IERC20(address(token)), address(0xB0B), 4 ether);

        require(escrow.accountedBalances(address(token)) == 6 ether, "accounted after release");
        require(token.balanceOf(address(escrow)) == 8 ether, "actual after release");
        require(token.balanceOf(address(0xB0B)) == 4 ether, "receiver balance");
    }
}
