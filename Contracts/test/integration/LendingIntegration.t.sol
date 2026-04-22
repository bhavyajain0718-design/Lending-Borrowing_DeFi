// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Corn} from "../../src/Corn.sol";
import {CornDEX} from "../../src/CornDEX.sol";
import {Lending} from "../../src/Lending.sol";
import {MovePrice} from "../../src/MovePrice.sol";
import {FlashLoanLiquidator} from "../../src/FlashLoanLiquidator.sol";

contract LendingIntegrationTest is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant CRASHED_PRICE = 1_000e18;

    Corn internal corn;
    CornDEX internal cornDex;
    Lending internal lending;
    MovePrice internal movePrice;
    FlashLoanLiquidator internal flashLoanLiquidator;

    address internal homeowner = makeAddr("homeowner");
    address internal liquidatorOperator = makeAddr("liquidatorOperator");

    function setUp() public {
        corn = new Corn();
        cornDex = new CornDEX(corn, INITIAL_PRICE);
        lending = new Lending(corn, cornDex);
        movePrice = new MovePrice(cornDex);
        flashLoanLiquidator = new FlashLoanLiquidator(corn, cornDex, lending);

        corn.setMinter(address(lending), true);
        cornDex.transferOwnership(address(movePrice));

        corn.mint(address(cornDex), 2_000_000e18);
        vm.deal(address(cornDex), 1_000 ether);

        vm.deal(homeowner, 10 ether);
        vm.prank(homeowner);
        lending.depositCollateral{value: 3 ether}();

        vm.prank(homeowner);
        lending.borrow(4_000e18);
    }

    function testGracePeriodBlocksImmediateFlashLoanLiquidation() public {
        movePrice.moveEthPriceInCorn(CRASHED_PRICE);

        (uint256 healthFactor,, uint256 protectionEndsAt, bool canLiquidate) = lending.getProtectionState(homeowner);
        assertLt(healthFactor, 1e18);
        assertEq(canLiquidate, false);
        assertEq(protectionEndsAt, block.timestamp + 24 hours);

        vm.prank(liquidatorOperator);
        vm.expectRevert(abi.encodeWithSelector(Lending.GracePeriodActive.selector, 24 hours));
        flashLoanLiquidator.execute(homeowner, 2_500e18, liquidatorOperator);
    }

    function testCrashThenImmediateLiquidationFailsThenSucceedsAfterTwentyFiveHours() public {
        movePrice.moveEthPriceInCorn(CRASHED_PRICE);

        vm.prank(liquidatorOperator);
        vm.expectRevert(abi.encodeWithSelector(Lending.GracePeriodActive.selector, 24 hours));
        flashLoanLiquidator.execute(homeowner, 2_500e18, liquidatorOperator);

        vm.warp(block.timestamp + 25 hours);

        uint256 debtBefore = lending.debtBalance(homeowner);
        uint256 collateralBefore = lending.collateralBalance(homeowner);

        vm.prank(liquidatorOperator);
        flashLoanLiquidator.execute(homeowner, 2_500e18, liquidatorOperator);

        assertEq(lending.debtBalance(homeowner), debtBefore - 2_500e18);
        assertLt(lending.collateralBalance(homeowner), collateralBefore);
    }

    function testLiquidationWorksAfterTwentyFiveHours() public {
        movePrice.moveEthPriceInCorn(CRASHED_PRICE);
        vm.warp(block.timestamp + 25 hours);

        uint256 beforeDebt = lending.debtBalance(homeowner);
        uint256 beforeCollateral = lending.collateralBalance(homeowner);
        uint256 liquidatorBalanceBefore = liquidatorOperator.balance;

        vm.prank(liquidatorOperator);
        flashLoanLiquidator.execute(homeowner, 2_500e18, liquidatorOperator);

        assertEq(lending.debtBalance(homeowner), beforeDebt - 2_500e18);
        assertLt(lending.collateralBalance(homeowner), beforeCollateral);
        assertGt(liquidatorOperator.balance, liquidatorBalanceBefore);
    }
}
