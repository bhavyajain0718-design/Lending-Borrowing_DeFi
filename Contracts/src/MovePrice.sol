// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CornDEX} from "./CornDEX.sol";

contract MovePrice {
    CornDEX public immutable cornDex;
    address public owner;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(CornDEX _cornDex) {
        cornDex = _cornDex;
        owner = msg.sender;
    }

    function moveEthPriceInCorn(uint256 newPrice) external onlyOwner {
        cornDex.setEthPriceInCorn(newPrice);
    }
}
