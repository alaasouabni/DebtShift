// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { MorphoBlueTargetLending } from "../src/MorphoBlueTargetLending.sol";
import { IMorphoBlue } from "../src/interfaces/IMorphoBlue.sol";
import { MockMorphoBlue } from "../src/mocks/MockMorphoBlue.sol";
import { TestToken } from "../src/mocks/TestToken.sol";

interface MorphoVm {
    function addr(uint256 privateKey) external returns (address);
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
}

contract MorphoBlueTargetLendingTest {
    MorphoVm private constant vm =
        MorphoVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BORROWER_KEY = 0xA11CE;
    uint256 private constant WRONG_KEY = 0xBAD;
    uint256 private constant COLLATERAL_UNITS = 5 ether;
    uint256 private constant DEBT_UNITS = 1_000e6;
    bytes32 private constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );

    TestToken private collateralToken;
    TestToken private debtToken;
    MockMorphoBlue private morpho;
    MorphoBlueTargetLending private module;
    IMorphoBlue.MarketParams private params;
    address private borrower;

    function setUp() public {
        borrower = vm.addr(BORROWER_KEY);
        collateralToken = new TestToken("Collateral", "COL", 18, address(this));
        debtToken = new TestToken("Debt", "DEBT", 6, address(this));
        params = IMorphoBlue.MarketParams({
            loanToken: address(debtToken),
            collateralToken: address(collateralToken),
            oracle: address(0xBEEF),
            irm: address(0),
            lltv: 0.86 ether
        });
        morpho = new MockMorphoBlue(params);
        module = new MorphoBlueTargetLending(address(this), morpho, params);
        module.setDestinationAdapter(address(this));

        collateralToken.mint(address(this), COLLATERAL_UNITS * 2);
        debtToken.mint(address(morpho), DEBT_UNITS * 2);
        collateralToken.approve(address(module), type(uint256).max);
    }

    function testAtomicOpenUsesAndRevokesConsecutiveMorphoAuthorizations() public {
        module.openPosition(
            borrower,
            address(this),
            address(this),
            COLLATERAL_UNITS,
            DEBT_UNITS,
            _authorizationPair(BORROWER_KEY, 0)
        );

        (, uint128 borrowShares, uint128 collateral) = morpho.position(module.marketId(), borrower);
        require(uint256(collateral) == COLLATERAL_UNITS, "collateral position mismatch");
        require(uint256(borrowShares) == DEBT_UNITS, "borrow position mismatch");
        require(debtToken.balanceOf(address(this)) == DEBT_UNITS, "debt receiver mismatch");
        require(morpho.nonce(borrower) == 2, "authorization nonce mismatch");
        require(!morpho.isAuthorized(borrower, address(module)), "authorization was not revoked");
        require(collateralToken.balanceOf(address(module)) == 0, "module retained collateral");
        require(debtToken.balanceOf(address(module)) == 0, "module retained debt asset");
    }

    function testFuzzAtomicOpenPreservesExactDeltas(uint96 collateralSeed, uint96 debtSeed) public {
        uint256 collateralUnits = uint256(collateralSeed) % COLLATERAL_UNITS + 1;
        uint256 debtUnits = uint256(debtSeed) % DEBT_UNITS + 1;

        module.openPosition(
            borrower,
            address(this),
            address(this),
            collateralUnits,
            debtUnits,
            _authorizationPair(BORROWER_KEY, 0)
        );

        (, uint128 borrowShares, uint128 collateral) = morpho.position(module.marketId(), borrower);
        require(uint256(collateral) == collateralUnits, "fuzzed collateral mismatch");
        require(uint256(borrowShares) == debtUnits, "fuzzed debt mismatch");
        require(debtToken.balanceOf(address(this)) == debtUnits, "fuzzed receiver mismatch");
        require(morpho.nonce(borrower) == 2, "fuzzed nonce mismatch");
        require(!morpho.isAuthorized(borrower, address(module)), "fuzzed authorization remains");
    }

    function testInvalidDisableSignatureRollsBackCollateralBorrowAndAuthorization() public {
        bytes memory invalidPair = _authorizationPairWithDisableSigner(BORROWER_KEY, WRONG_KEY, 0);

        vm.expectRevert();
        module.openPosition(
            borrower, address(this), address(this), COLLATERAL_UNITS, DEBT_UNITS, invalidPair
        );

        (, uint128 borrowShares, uint128 collateral) = morpho.position(module.marketId(), borrower);
        require(collateral == 0 && borrowShares == 0, "position did not roll back");
        require(morpho.nonce(borrower) == 0, "authorization nonce did not roll back");
        require(!morpho.isAuthorized(borrower, address(module)), "authorization did not roll back");
        require(debtToken.balanceOf(address(this)) == 0, "borrow transfer did not roll back");
        require(
            collateralToken.balanceOf(address(this)) == COLLATERAL_UNITS * 2,
            "collateral pull did not roll back"
        );
    }

    function testUnsolicitedTokenDustCannotBlockAtomicOpen() public {
        require(collateralToken.transfer(address(module), 1), "collateral dust transfer failed");
        debtToken.mint(address(this), 1);
        require(debtToken.transfer(address(module), 1), "debt dust transfer failed");

        module.openPosition(
            borrower,
            address(this),
            address(this),
            COLLATERAL_UNITS,
            DEBT_UNITS,
            _authorizationPair(BORROWER_KEY, 0)
        );

        require(collateralToken.balanceOf(address(module)) == 1, "collateral dust changed");
        require(debtToken.balanceOf(address(module)) == 1, "debt dust changed");
        require(!morpho.isAuthorized(borrower, address(module)), "authorization was not revoked");
    }

    function testExistingTargetPositionCannotBeMixedIntoAMigration() public {
        module.openPosition(
            borrower,
            address(this),
            address(this),
            COLLATERAL_UNITS,
            DEBT_UNITS,
            _authorizationPair(BORROWER_KEY, 0)
        );

        bytes memory nextPair = _authorizationPair(BORROWER_KEY, 2);
        vm.expectRevert(MorphoBlueTargetLending.ExistingPosition.selector);
        module.openPosition(
            borrower, address(this), address(this), COLLATERAL_UNITS, DEBT_UNITS, nextPair
        );
    }

    function testDestinationAdapterBindingIsOneTime() public {
        vm.expectRevert(MorphoBlueTargetLending.Unauthorized.selector);
        module.setDestinationAdapter(address(0xCAFE));
    }

    function _authorizationPair(uint256 signerKey, uint256 startingNonce)
        private
        returns (bytes memory)
    {
        return _authorizationPairWithDisableSigner(signerKey, signerKey, startingNonce);
    }

    function _authorizationPairWithDisableSigner(
        uint256 enableSignerKey,
        uint256 disableSignerKey,
        uint256 startingNonce
    ) private returns (bytes memory) {
        uint256 deadline = block.timestamp + 1 hours;
        IMorphoBlue.Authorization memory enable = IMorphoBlue.Authorization({
            authorizer: borrower,
            authorized: address(module),
            isAuthorized: true,
            nonce: startingNonce,
            deadline: deadline
        });
        IMorphoBlue.Authorization memory disable = IMorphoBlue.Authorization({
            authorizer: borrower,
            authorized: address(module),
            isAuthorized: false,
            nonce: startingNonce + 1,
            deadline: deadline
        });
        return abi.encode(
            enable,
            _signAuthorization(enableSignerKey, enable),
            disable,
            _signAuthorization(disableSignerKey, disable)
        );
    }

    function _signAuthorization(uint256 signerKey, IMorphoBlue.Authorization memory authorization)
        private
        returns (IMorphoBlue.Signature memory signature)
    {
        bytes32 structHash = keccak256(abi.encode(AUTHORIZATION_TYPEHASH, authorization));
        bytes32 digest =
            keccak256(abi.encodePacked(hex"1901", morpho.DOMAIN_SEPARATOR(), structHash));
        (signature.v, signature.r, signature.s) = vm.sign(signerKey, digest);
    }
}
