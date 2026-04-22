// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Corn} from "./Corn.sol";
import {CornDEX} from "./CornDEX.sol";
import {Lending} from "./Lending.sol";
import {ICornFlashLoanReceiver} from "./interfaces/ICornFlashLoanReceiver.sol";

/// @title FlashLoanLiquidator
/// @author Bhavya Jain
/// @notice Liquidation helper that uses a CORN flash loan to liquidate unhealthy positions.
contract FlashLoanLiquidator is ICornFlashLoanReceiver {
    Corn public immutable corn;
    CornDEX public immutable cornDex;
    Lending public immutable lending;

    error OnlyLending();
    error ProfitTransferFailed();

    /// @notice Initializes the helper with the protocol contracts it depends on.
    /// @param _corn Address of the CORN token contract.
    /// @param _cornDex Address of the CornDEX swap/oracle contract.
    /// @param _lending Address of the lending contract to liquidate through.
    constructor(Corn _corn, CornDEX _cornDex, Lending _lending) {
        corn = _corn;
        cornDex = _cornDex;
        lending = _lending;
    }

    receive() external payable {}

    /// @notice Starts a flash-loan-assisted liquidation and sends any profit to the recipient.
    /// @param user Borrower to liquidate.
    /// @param repayAmount Amount of CORN debt to repay during liquidation.
    /// @param profitRecipient Address that receives any leftover ETH profit.
    function execute(address user, uint256 repayAmount, address profitRecipient) external {
        lending.flashLoan(this, repayAmount, abi.encode(user, profitRecipient));
    }

    /// @notice Flash loan callback that performs liquidation, repurchases CORN, and forwards profit.
    /// @param amount Amount of CORN borrowed in the flash loan.
    /// @param fee Fee owed back to the lender, currently zero.
    /// @param data ABI-encoded liquidation target and profit recipient.
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
