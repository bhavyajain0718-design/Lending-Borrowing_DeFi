// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Corn} from "../src/Corn.sol";
import {CornDEX} from "../src/CornDEX.sol";
import {Lending} from "../src/Lending.sol";
import {MovePrice} from "../src/MovePrice.sol";
import {FlashLoanLiquidator} from "../src/FlashLoanLiquidator.sol";

contract DeployScript is Script {
    function deploy()
        public
        returns (Corn corn, CornDEX cornDex, Lending lending, MovePrice mover, FlashLoanLiquidator liquidator)
    {
        corn = new Corn();
        cornDex = new CornDEX(corn, 2_000e18);
        lending = new Lending(corn, cornDex);
        mover = new MovePrice(cornDex);
        liquidator = new FlashLoanLiquidator(corn, cornDex, lending);

        corn.setMinter(address(lending), true);
        cornDex.transferOwnership(address(mover));

        return (corn, cornDex, lending, mover, liquidator);
    }

    function run() external {
        vm.startBroadcast();

        deploy();

        vm.stopBroadcast();
    }
}
