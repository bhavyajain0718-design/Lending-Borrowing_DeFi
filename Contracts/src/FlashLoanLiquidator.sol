// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Corn} from "./Corn.sol";
import {CornDEX} from "./CornDEX.sol";
import {Lending} from "./Lending.sol";
import {ICornFlashLoanReceiver} from "./interfaces/ICornFlashLoanReceiver.sol";

contract FlashLoanLiquidator is ICornFlashLoanReceiver {
    Corn public immutable corn;
    CornDEX public immutable cornDex;
    Lending public immutable lending;

    error OnlyLending();
    error ProfitTransferFailed();

    constructor(Corn _corn, CornDEX _cornDex, Lending _lending) {
        corn = _corn;
        cornDex = _cornDex;
        lending = _lending;
    }

    receive() external payable {}

    function execute(address user, uint256 repayAmount, address profitRecipient) external {
        lending.flashLoan(this, repayAmount, abi.encode(user, profitRecipient));
    }

    function onCornFlashLoan(address, uint256 amount, uint256 fee, bytes calldata data) external override {
        if (msg.sender != address(lending)) revert OnlyLending();

        (address user, address profitRecipient) = abi.decode(data, (address, address));

        corn.approve(address(lending), amount);
        lending.liquidate(user, amount);

        uint256 amountOwed = amount + fee;
        uint256 requiredEth = cornDex.quoteEthForExactCorn(amountOwed);
        cornDex.swapExactETHForCorn{value: requiredEth}(amountOwed, address(this));

        corn.approve(address(lending), amountOwed);

        uint256 ethProfit = address(this).balance;
        if (ethProfit != 0) {
            (bool success,) = payable(profitRecipient).call{value: ethProfit}("");
            if (!success) revert ProfitTransferFailed();
        }
    }
}
