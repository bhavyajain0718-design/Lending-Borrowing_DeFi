// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Corn} from "../../src/Corn.sol";
import {CornDEX} from "../../src/CornDEX.sol";
import {Lending} from "../../src/Lending.sol";
import {MovePrice} from "../../src/MovePrice.sol";
import {FlashLoanLiquidator} from "../../src/FlashLoanLiquidator.sol";

contract LendingUnitTest is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant CRASHED_PRICE = 1_000e18;

    Corn internal corn;
    CornDEX internal cornDex;
    Lending internal lending;
    MovePrice internal movePrice;
    FlashLoanLiquidator internal flashLoanLiquidator;

    address internal homeowner = makeAddr("homeowner");
    address internal liquidatorOperator = makeAddr("liquidatorOperator");
    address internal freshUser = makeAddr("freshUser");

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

    function testHealthFactorUses120PercentThreshold() public view {
        uint256 expectedHealthFactor = (6_000e18 * 1e18 * 10_000) / (4_000e18 * 12_000);
        assertEq(lending.getHealthFactor(homeowner), expectedHealthFactor);
    }

    function testMovePriceCrashMakesLoanUnhealthy() public {
        uint256 healthFactorBefore = lending.getHealthFactor(homeowner);
        assertGt(healthFactorBefore, 1e18);

        movePrice.moveEthPriceInCorn(CRASHED_PRICE);

        uint256 healthFactorAfter = lending.getHealthFactor(homeowner);
        assertLt(healthFactorAfter, 1e18);

        (uint256 protectionHealthFactor, uint256 atRiskSince, uint256 protectionEndsAt, bool canLiquidate) =
            lending.getProtectionState(homeowner);

        assertEq(protectionHealthFactor, healthFactorAfter);
        assertEq(atRiskSince, block.timestamp);
        assertEq(protectionEndsAt, block.timestamp + 24 hours);
        assertFalse(canLiquidate);
    }

    function testRiskTimestampResetsWhenCollateralRecovers() public {
        movePrice.moveEthPriceInCorn(CRASHED_PRICE);

        lending.syncRiskState(homeowner);
        uint256 firstRiskSince = lending.riskSince(homeowner);
        assertEq(firstRiskSince, block.timestamp);

        vm.warp(block.timestamp + 12 hours);

        vm.deal(homeowner, 2 ether);
        vm.prank(homeowner);
        lending.depositCollateral{value: 2 ether}();

        assertEq(lending.riskSince(homeowner), 0);
        assertGt(lending.getHealthFactor(homeowner), 1e18);

        movePrice.moveEthPriceInCorn(800e18);

        lending.syncRiskState(homeowner);
        assertEq(lending.riskSince(homeowner), block.timestamp);
        assertGt(lending.riskSince(homeowner), firstRiskSince);
    }

    function testDepositCollateralRevertsOnZeroAmount() public {
        vm.prank(homeowner);
        vm.expectRevert(Lending.ZeroAmount.selector);
        lending.depositCollateral{value: 0}();
    }

    function testWithdrawCollateralRevertsOnZeroAmount() public {
        vm.prank(homeowner);
        vm.expectRevert(Lending.ZeroAmount.selector);
        lending.withdrawCollateral(0);
    }

    function testWithdrawCollateralRevertsWhenPositionWouldBecomeUnhealthy() public {
        vm.prank(homeowner);
        vm.expectRevert(Lending.Undercollateralized.selector);
        lending.withdrawCollateral(0.7 ether);
    }

    function testBorrowRevertsOnZeroAmount() public {
        vm.prank(homeowner);
        vm.expectRevert(Lending.ZeroAmount.selector);
        lending.borrow(0);
    }

    function testBorrowRevertsWhenPositionWouldBecomeUnhealthy() public {
        vm.prank(homeowner);
        vm.expectRevert(Lending.Undercollateralized.selector);
        lending.borrow(2_000e18);
    }

    function testRepayRevertsOnZeroAmount() public {
        vm.prank(homeowner);
        vm.expectRevert(Lending.ZeroAmount.selector);
        lending.repay(0);
    }

    function testRepayCapsAmountToOutstandingDebt() public {
        corn.mint(homeowner, 10_000e18);

        vm.prank(homeowner);
        corn.approve(address(lending), 10_000e18);

        vm.prank(homeowner);
        lending.repay(10_000e18);

        assertEq(lending.debtBalance(homeowner), 0);
    }

    function testLiquidateRevertsOnZeroAmount() public {
        vm.prank(liquidatorOperator);
        vm.expectRevert(Lending.ZeroAmount.selector);
        lending.liquidate(homeowner, 0);
    }

    function testLiquidateRevertsWhenPositionHealthy() public {
        vm.prank(liquidatorOperator);
        vm.expectRevert(Lending.PositionHealthy.selector);
        lending.liquidate(homeowner, 1e18);
    }

    function testLiquidateRevertsWhenRepayAmountExceedsMax() public {
        movePrice.moveEthPriceInCorn(CRASHED_PRICE);
        vm.warp(block.timestamp + 25 hours);

        uint256 maxRepay = lending.getMaxLiquidationRepay(homeowner);

        vm.prank(liquidatorOperator);
        vm.expectRevert(abi.encodeWithSelector(Lending.ExcessiveRepayAmount.selector, maxRepay));
        lending.liquidate(homeowner, maxRepay + 1);
    }

    function testGetHealthFactorReturnsMaxForUserWithNoDebt() public view {
        assertEq(lending.getHealthFactor(freshUser), type(uint256).max);
    }

    function testGetMaxLiquidationRepayReturnsDebtWhenDebtIsLower() public view {
        assertEq(lending.getMaxLiquidationRepay(homeowner), 4_000e18);
    }

    function testGetMaxLiquidationRepayReturnsCollateralLimitedAmountAfterCrash() public {
        movePrice.moveEthPriceInCorn(CRASHED_PRICE);
        uint256 expectedMaxRepay = (uint256(3_000e18) * 10_000) / 11_000;
        assertEq(lending.getMaxLiquidationRepay(homeowner), expectedMaxRepay);
    }

    function testGetProtectionStateForHealthyPositionHasNoTimer() public view {
        (uint256 healthFactor, uint256 atRiskSince, uint256 protectionEndsAt, bool canLiquidate) =
            lending.getProtectionState(homeowner);

        assertGt(healthFactor, 1e18);
        assertEq(atRiskSince, 0);
        assertEq(protectionEndsAt, 0);
        assertFalse(canLiquidate);
    }
}
