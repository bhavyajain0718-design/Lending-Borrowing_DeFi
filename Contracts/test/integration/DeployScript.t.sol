// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../../script/Deploy.s.sol";
import {Corn} from "../../src/Corn.sol";
import {CornDEX} from "../../src/CornDEX.sol";
import {Lending} from "../../src/Lending.sol";
import {MovePrice} from "../../src/MovePrice.sol";
import {FlashLoanLiquidator} from "../../src/FlashLoanLiquidator.sol";

contract DeployScriptIntegrationTest is Test {
    function testDeployScriptDeploysAndWiresContracts() public {
        DeployScript deployScript = new DeployScript();

        (Corn corn, CornDEX cornDex, Lending lending, MovePrice mover, FlashLoanLiquidator liquidator) =
            deployScript.deploy();

        assertEq(address(lending.corn()), address(corn));
        assertEq(address(lending.cornDex()), address(cornDex));

        assertEq(address(liquidator.corn()), address(corn));
        assertEq(address(liquidator.cornDex()), address(cornDex));
        assertEq(address(liquidator.lending()), address(lending));

        assertTrue(corn.isMinter(address(lending)));
        assertEq(corn.owner(), address(deployScript));
        assertEq(cornDex.owner(), address(mover));
        assertEq(address(mover.cornDex()), address(cornDex));
        assertEq(address(mover.lending()), address(lending));
        assertEq(cornDex.ethPriceInCorn(), 2_000e18);
    }
}
