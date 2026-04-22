// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Corn} from "../../src/Corn.sol";
import {CornDEX} from "../../src/CornDEX.sol";
import {MovePrice} from "../../src/MovePrice.sol";
import {Lending} from "../../src/Lending.sol";

contract MovePriceUnitTest is Test {
    Corn internal corn;
    CornDEX internal cornDex;
    MovePrice internal movePrice;
    Lending internal lending;

    address internal attacker = makeAddr("attacker");

    function setUp() public {
        corn = new Corn();
        cornDex = new CornDEX(corn, 2_000e18);
        lending = new Lending(corn, cornDex);
        movePrice = new MovePrice(cornDex, lending);
        cornDex.transferOwnership(address(movePrice));
    }

    function testOwnerCanMoveEthPriceInCorn() public {
        movePrice.moveEthPriceInCorn(1_500e18);
        assertEq(cornDex.ethPriceInCorn(), 1_500e18);
    }

    function testMoveEthPriceInCornRevertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(MovePrice.NotOwner.selector);
        movePrice.moveEthPriceInCorn(1_500e18);
    }

    function testMovePriceStoresLendingReference() public view {
        assertEq(address(movePrice.lending()), address(lending));
    }
}
