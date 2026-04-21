// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Corn} from "../src/Corn.sol";
import {CornDEX} from "../src/CornDEX.sol";
import {Lending} from "../src/Lending.sol";
import {MovePrice} from "../src/MovePrice.sol";
import {FlashLoanLiquidator} from "../src/FlashLoanLiquidator.sol";

contract DeployScript is Script {
    function run() external {
        vm.startBroadcast();

        Corn corn = new Corn();
        CornDEX cornDex = new CornDEX(corn, 2_000e18);
        Lending lending = new Lending(corn, cornDex);
        MovePrice mover = new MovePrice(cornDex);
        FlashLoanLiquidator liquidator = new FlashLoanLiquidator(corn, cornDex, lending);

        corn.setMinter(address(lending), true);
        cornDex.transferOwnership(address(mover));

        vm.stopBroadcast();

        mover;
        liquidator;
    }
}
