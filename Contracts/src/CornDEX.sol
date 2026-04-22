// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Corn} from "./Corn.sol";

/// @title CornDEX
/// @author Bhavya Jain
/// @notice Simple CORN/ETH swap contract that also acts as the protocol's on-chain price source.
contract CornDEX {
    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 30;

    Corn public immutable corn;
    address public owner;
    uint256 public ethPriceInCorn;
    uint256 public lastPriceUpdateAt;

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice, uint256 updatedAt);
    event SwapCornForEth(address indexed trader, uint256 cornIn, uint256 ethOut, address indexed recipient);
    event SwapEthForCorn(address indexed trader, uint256 ethIn, uint256 cornOut, address indexed recipient);

    error NotOwner();
    error InvalidPrice();
    error SlippageExceeded();
    error EthTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Initializes the DEX with the CORN token and a starting ETH/CORN price.
    /// @param _corn Address of the CORN token contract.
    /// @param initialPrice Initial price quoted as CORN per 1 ETH using 18 decimals.
    constructor(Corn _corn, uint256 initialPrice) {
        if (initialPrice == 0) revert InvalidPrice();
        corn = _corn;
        owner = msg.sender;
        ethPriceInCorn = initialPrice;
        lastPriceUpdateAt = block.timestamp;
        emit OwnerTransferred(address(0), msg.sender);
        emit PriceUpdated(0, initialPrice, block.timestamp);
    }

    receive() external payable {}

    /// @notice Transfers DEX ownership to another address.
    /// @param newOwner Address that will become the new owner.
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerTransferred(msg.sender, newOwner);
    }

    /// @notice Updates the ETH price denominated in CORN.
    /// @param newPrice New price quoted as CORN per 1 ETH using 18 decimals.
    function setEthPriceInCorn(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert InvalidPrice();
        uint256 oldPrice = ethPriceInCorn;
        ethPriceInCorn = newPrice;
        lastPriceUpdateAt = block.timestamp;
        emit PriceUpdated(oldPrice, newPrice, block.timestamp);
    }

    /// @notice Quotes how much CORN is received for an ETH input after fees.
    /// @param ethAmount Amount of ETH being swapped.
    /// @return Amount of CORN the swap would return after fees.
    function quoteEthToCorn(uint256 ethAmount) public view returns (uint256) {
        uint256 grossCorn = (ethAmount * ethPriceInCorn) / 1e18;
        return (grossCorn * (BPS - FEE_BPS)) / BPS;
    }

    /// @notice Quotes how much ETH is received for a CORN input after fees.
    /// @param cornAmount Amount of CORN being swapped.
    /// @return Amount of ETH the swap would return after fees.
    function quoteCornToEth(uint256 cornAmount) public view returns (uint256) {
        uint256 grossEth = (cornAmount * 1e18) / ethPriceInCorn;
        return (grossEth * (BPS - FEE_BPS)) / BPS;
    }

    /// @notice Quotes the ETH needed to buy an exact amount of CORN.
    /// @param desiredCornOut Amount of CORN desired from the swap.
    /// @return Amount of ETH required to receive the desired CORN after fees.
    function quoteEthForExactCorn(uint256 desiredCornOut) public view returns (uint256) {
        uint256 numerator = desiredCornOut * 1e18 * BPS;
        uint256 denominator = ethPriceInCorn * (BPS - FEE_BPS);
        return (numerator + denominator - 1) / denominator;
    }

    /// @notice Swaps exact ETH input for CORN.
    /// @param minCornOut Minimum acceptable CORN output for slippage protection.
    /// @param recipient Address that receives the CORN output.
    /// @return cornOut Actual amount of CORN sent to the recipient.
    function swapExactETHForCorn(uint256 minCornOut, address recipient) external payable returns (uint256 cornOut) {
        cornOut = quoteEthToCorn(msg.value);
        if (cornOut < minCornOut) revert SlippageExceeded();
        corn.transfer(recipient, cornOut);
        emit SwapEthForCorn(msg.sender, msg.value, cornOut, recipient);
    }

    /// @notice Swaps exact CORN input for ETH.
    /// @param cornIn Amount of CORN sent into the swap.
    /// @param minEthOut Minimum acceptable ETH output for slippage protection.
    /// @param recipient Address that receives the ETH output.
    /// @return ethOut Actual amount of ETH sent to the recipient.
    function swapExactCornForETH(uint256 cornIn, uint256 minEthOut, address recipient)
        external
        returns (uint256 ethOut)
    {
        ethOut = quoteCornToEth(cornIn);
        if (ethOut < minEthOut) revert SlippageExceeded();
        corn.transferFrom(msg.sender, address(this), cornIn);
        (bool success,) = payable(recipient).call{value: ethOut}("");
        if (!success) revert EthTransferFailed();
        emit SwapCornForEth(msg.sender, cornIn, ethOut, recipient);
    }
}
