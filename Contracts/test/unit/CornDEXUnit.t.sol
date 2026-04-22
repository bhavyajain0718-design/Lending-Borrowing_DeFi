// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Corn} from "../../src/Corn.sol";
import {CornDEX} from "../../src/CornDEX.sol";

contract RejectEthReceiver {
    receive() external payable {
        revert("no eth");
    }
}

contract CornDEXUnitTest is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;

    Corn internal corn;
    CornDEX internal cornDex;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        corn = new Corn();
        cornDex = new CornDEX(corn, INITIAL_PRICE);

        corn.mint(address(cornDex), 2_000_000e18);
        corn.mint(alice, 10_000e18);
        vm.deal(address(cornDex), 500 ether);
        vm.deal(alice, 50 ether);
    }

    function testConstructorRevertsForZeroInitialPrice() public {
        vm.expectRevert(CornDEX.InvalidPrice.selector);
        new CornDEX(corn, 0);
    }

    function testTransferOwnershipRevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(CornDEX.NotOwner.selector);
        cornDex.transferOwnership(alice);
    }

    function testSetEthPriceRevertsForNonOwner() public {
        vm.prank(alice);
        vm.expectRevert(CornDEX.NotOwner.selector);
        cornDex.setEthPriceInCorn(1_500e18);
    }

    function testSetEthPriceRevertsForZeroPrice() public {
        vm.expectRevert(CornDEX.InvalidPrice.selector);
        cornDex.setEthPriceInCorn(0);
    }

    function testQuoteHelpersReturnExpectedValues() public view {
        assertEq(cornDex.quoteEthToCorn(1 ether), 1_994e18);
        assertEq(cornDex.quoteCornToEth(2_000e18), 0.997 ether);
        assertEq(cornDex.quoteEthForExactCorn(1_994e18), 1 ether);
    }

    function testSwapExactEthForCornSuccess() public {
        uint256 expectedCornOut = cornDex.quoteEthToCorn(1 ether);

        vm.prank(alice);
        uint256 cornOut = cornDex.swapExactETHForCorn{value: 1 ether}(expectedCornOut, bob);

        assertEq(cornOut, expectedCornOut);
        assertEq(corn.balanceOf(bob), expectedCornOut);
    }

    function testSwapExactEthForCornRevertsOnSlippage() public {
        vm.prank(alice);
        vm.expectRevert(CornDEX.SlippageExceeded.selector);
        cornDex.swapExactETHForCorn{value: 1 ether}(2_000e18, bob);
    }

    function testSwapExactCornForEthSuccess() public {
        uint256 cornIn = 2_000e18;
        uint256 expectedEthOut = cornDex.quoteCornToEth(cornIn);
        uint256 bobBalanceBefore = bob.balance;

        vm.prank(alice);
        corn.approve(address(cornDex), cornIn);

        vm.prank(alice);
        uint256 ethOut = cornDex.swapExactCornForETH(cornIn, expectedEthOut, bob);

        assertEq(ethOut, expectedEthOut);
        assertEq(bob.balance, bobBalanceBefore + expectedEthOut);
    }

    function testSwapExactCornForEthRevertsOnSlippage() public {
        uint256 cornIn = 2_000e18;

        vm.prank(alice);
        corn.approve(address(cornDex), cornIn);

        vm.prank(alice);
        vm.expectRevert(CornDEX.SlippageExceeded.selector);
        cornDex.swapExactCornForETH(cornIn, 1 ether, bob);
    }

    function testSwapExactCornForEthRevertsIfRecipientRejectsEth() public {
        RejectEthReceiver rejector = new RejectEthReceiver();
        uint256 cornIn = 2_000e18;

        vm.prank(alice);
        corn.approve(address(cornDex), cornIn);

        vm.prank(alice);
        vm.expectRevert(CornDEX.EthTransferFailed.selector);
        cornDex.swapExactCornForETH(cornIn, 0, address(rejector));
    }
}
