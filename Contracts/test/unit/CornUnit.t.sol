// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Corn} from "../../src/Corn.sol";

contract CornUnitTest is Test {
    Corn internal corn;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");

    function setUp() public {
        corn = new Corn();
    }

    function testConstructorSetsOwnerAndInitialMinter() public view {
        assertEq(corn.owner(), address(this));
        assertTrue(corn.isMinter(address(this)));
        assertEq(corn.totalSupply(), 0);
    }

    function testTransferOwnershipRevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(Corn.NotOwner.selector);
        corn.transferOwnership(alice);
    }

    function testTransferOwnershipRevertsForZeroAddress() public {
        vm.expectRevert(Corn.ZeroAddress.selector);
        corn.transferOwnership(address(0));
    }

    function testSetMinterRevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(Corn.NotOwner.selector);
        corn.setMinter(alice, true);
    }

    function testMintRevertsForNonMinter() public {
        vm.prank(alice);
        vm.expectRevert(Corn.NotMinter.selector);
        corn.mint(alice, 1e18);
    }

    function testMintRevertsForZeroAddress() public {
        vm.expectRevert(Corn.ZeroAddress.selector);
        corn.mint(address(0), 1e18);
    }

    function testBurnRevertsForInsufficientBalance() public {
        vm.expectRevert(Corn.InsufficientBalance.selector);
        corn.burn(alice, 1e18);
    }

    function testTransferRevertsForZeroAddress() public {
        corn.mint(alice, 2e18);

        vm.prank(alice);
        vm.expectRevert(Corn.ZeroAddress.selector);
        corn.transfer(address(0), 1e18);
    }

    function testTransferRevertsForInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(Corn.InsufficientBalance.selector);
        corn.transfer(bob, 1e18);
    }

    function testTransferFromRevertsForInsufficientAllowance() public {
        corn.mint(alice, 2e18);

        vm.prank(bob);
        vm.expectRevert(Corn.InsufficientAllowance.selector);
        corn.transferFrom(alice, charlie, 1e18);
    }

    function testTransferFromUsesMaxAllowanceWithoutDecrementing() public {
        corn.mint(alice, 2e18);

        vm.prank(alice);
        corn.approve(bob, type(uint256).max);

        vm.prank(bob);
        assertTrue(corn.transferFrom(alice, charlie, 1e18));

        assertEq(corn.allowance(alice, bob), type(uint256).max);
        assertEq(corn.balanceOf(charlie), 1e18);
    }

    function testApproveTransferAndTransferFromSuccessPath() public {
        corn.mint(alice, 3e18);

        vm.prank(alice);
        assertTrue(corn.approve(bob, 2e18));
        assertEq(corn.allowance(alice, bob), 2e18);

        vm.prank(alice);
        assertTrue(corn.transfer(charlie, 1e18));
        assertEq(corn.balanceOf(charlie), 1e18);

        vm.prank(bob);
        assertTrue(corn.transferFrom(alice, bob, 2e18));

        assertEq(corn.balanceOf(alice), 0);
        assertEq(corn.balanceOf(bob), 2e18);
        assertEq(corn.allowance(alice, bob), 0);
    }
}
