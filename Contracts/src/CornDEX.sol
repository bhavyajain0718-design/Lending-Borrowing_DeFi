// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Corn} from "./Corn.sol";

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

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerTransferred(msg.sender, newOwner);
    }

    function setEthPriceInCorn(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert InvalidPrice();
        uint256 oldPrice = ethPriceInCorn;
        ethPriceInCorn = newPrice;
        lastPriceUpdateAt = block.timestamp;
        emit PriceUpdated(oldPrice, newPrice, block.timestamp);
    }

    function quoteEthToCorn(uint256 ethAmount) public view returns (uint256) {
        uint256 grossCorn = (ethAmount * ethPriceInCorn) / 1e18;
        return (grossCorn * (BPS - FEE_BPS)) / BPS;
    }

    function quoteCornToEth(uint256 cornAmount) public view returns (uint256) {
        uint256 grossEth = (cornAmount * 1e18) / ethPriceInCorn;
        return (grossEth * (BPS - FEE_BPS)) / BPS;
    }

    function quoteEthForExactCorn(uint256 desiredCornOut) public view returns (uint256) {
        uint256 numerator = desiredCornOut * 1e18 * BPS;
        uint256 denominator = ethPriceInCorn * (BPS - FEE_BPS);
        return (numerator + denominator - 1) / denominator;
    }

    function swapExactETHForCorn(uint256 minCornOut, address recipient) external payable returns (uint256 cornOut) {
        cornOut = quoteEthToCorn(msg.value);
        if (cornOut < minCornOut) revert SlippageExceeded();
        corn.transfer(recipient, cornOut);
        emit SwapEthForCorn(msg.sender, msg.value, cornOut, recipient);
    }

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
